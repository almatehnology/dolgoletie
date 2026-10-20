import archiver from 'archiver';
import { Readable } from 'node:stream';
import { prisma } from './db';
import { readScanFile } from './uploads';
import { encodeVaultBundle } from './crypto/bundle';
import { vaultEncryptionEnabled } from './storage/vault';
import { ARCHIVE_MAX_BYTES } from './transfer-limits';

export type ExportScope = 'full' | 'people' | 'events';

export interface ExportManifest {
  version: 1;
  exportedAt: string;
  scope: ExportScope;
  counts: { people: number; events: number; participations: number; scans: number };
}

/** The API holds withAuthOperation while reading and sealing the backup. */
export async function buildExportZip(scope: ExportScope): Promise<{ stream: Readable; filename: string; contentType: string }> {
  const includePeople = scope === 'full' || scope === 'people';
  const includeEvents = scope === 'full' || scope === 'events';

  // Capture the rows and immutable attachment contents from one database snapshot.
  const { people, events, participations, scans, files } = await prisma.$transaction(async (tx) => {
    const people = includePeople
      ? await tx.person.findMany({
          include: { scans: true, participations: includeEvents ? true : { where: { event: { deletedAt: null } } } },
        })
      : [];

    const events = includeEvents
      ? await tx.event.findMany({
          include: { excursions: true, participations: includePeople ? true : false },
        })
      : [];

    const participations =
      includePeople && includeEvents
        ? await tx.participation.findMany()
        : [];

    const scans = includePeople
      ? await tx.passportScan.findMany()
      : [];

    const files = new Map<string, Buffer>();
    for (const scan of scans) {
      for (const path of [scan.storedPath, scan.thumbPath]) {
        if (!path) continue;
        const name = `uploads/${path.replaceAll('\\', '/')}`;
        if (!files.has(name)) {
          try { files.set(name, await readScanFile(path)); }
          catch { throw new Error('Не удалось прочитать вложение резервной копии. Проверьте наличие и целостность файлов.'); }
        }
      }
    }
    return { people, events, participations, scans, files };
  });

  const manifest: ExportManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    scope,
    counts: {
      people: people.length,
      events: events.length,
      participations: participations.length,
      scans: scans.length,
    },
  };

  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const complete = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > ARCHIVE_MAX_BYTES) {
        archive.abort(); reject(new Error('Размер файла не должен превышать 1 ГиБ.')); return;
      }
      chunks.push(chunk);
    });
    archive.once('end', () => resolve(Buffer.concat(chunks)));
    archive.once('error', reject);
    archive.once('warning', reject);
  });

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  archive.append(JSON.stringify(people, null, 2), { name: 'people.json' });
  archive.append(JSON.stringify(events, null, 2), { name: 'events.json' });
  archive.append(JSON.stringify(participations, null, 2), { name: 'participations.json' });

  for (const [name, file] of files) archive.append(file, { name });
  const [, zip] = await Promise.all([archive.finalize(), complete]);
  const encrypted = vaultEncryptionEnabled();
  const buffer = encrypted ? await encodeVaultBundle(zip) : zip;

  const date = new Date().toISOString().slice(0, 10);
  return {
    stream: Readable.from([buffer]),
    filename: `dolgoletie-${scope}-${date}.${encrypted ? 'tdbbackup' : 'zip'}`,
    contentType: encrypted ? 'application/octet-stream' : 'application/zip',
  };
}
