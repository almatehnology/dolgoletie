import archiver from 'archiver';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { prisma } from './db';
import { UPLOADS_DIR } from './uploads';

export type ExportScope = 'full' | 'people' | 'events';

export interface ExportManifest {
  version: 1;
  exportedAt: string;
  scope: ExportScope;
  counts: { people: number; events: number; participations: number; scans: number };
}

export async function buildExportZip(scope: ExportScope): Promise<{ stream: NodeJS.ReadableStream; filename: string }> {
  const includePeople = scope === 'full' || scope === 'people';
  const includeEvents = scope === 'full' || scope === 'events';

  const people = includePeople
    ? await prisma.person.findMany({
        include: { scans: true, participations: includeEvents ? true : { where: { event: { deletedAt: null } } } },
      })
    : [];

  const events = includeEvents
    ? await prisma.event.findMany({
        include: { excursions: true, participations: includePeople ? true : false },
      })
    : [];

  const participations =
    includePeople && includeEvents
      ? await prisma.participation.findMany()
      : includePeople
        ? []
        : includeEvents
          ? []
          : [];

  const scans = includePeople
    ? await prisma.passportScan.findMany()
    : [];

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

  const pt = new PassThrough();
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (err) => console.warn('[export]', err));
  archive.on('error', (err) => pt.destroy(err));
  archive.pipe(pt);

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  archive.append(JSON.stringify(people, null, 2), { name: 'people.json' });
  archive.append(JSON.stringify(events, null, 2), { name: 'events.json' });
  archive.append(JSON.stringify(participations, null, 2), { name: 'participations.json' });

  if (includePeople) {
    for (const s of scans) {
      const abs = join(UPLOADS_DIR, s.storedPath);
      if (existsSync(abs)) {
        archive.file(abs, { name: `uploads/${s.storedPath}` });
      }
      if (s.thumbPath) {
        const thumbAbs = join(UPLOADS_DIR, s.thumbPath);
        if (existsSync(thumbAbs)) {
          archive.file(thumbAbs, { name: `uploads/${s.thumbPath}` });
        }
      }
    }
  }

  archive.finalize();

  const date = new Date().toISOString().slice(0, 10);
  return { stream: pt, filename: `travel-database-${scope}-${date}.zip` };
}
