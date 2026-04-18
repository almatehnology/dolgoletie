import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';

export const UPLOADS_DIR = resolve(process.env.UPLOADS_DIR ?? './uploads');
export const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB ?? '10')) * 1024 * 1024;

export const ALLOWED_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

export const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export async function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) await mkdir(UPLOADS_DIR, { recursive: true });
}

export async function ensurePersonDir(personId: string) {
  await ensureUploadsDir();
  const dir = join(UPLOADS_DIR, personId);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveScanFile(personId: string, originalName: string, buffer: Buffer) {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Файл больше ${process.env.MAX_UPLOAD_MB ?? 10} МБ`);
  }
  const sniff = await fileTypeFromBuffer(buffer);
  const mime = sniff?.mime;
  if (!mime || !ALLOWED_MIME.has(mime)) {
    throw new Error('Поддерживаются только JPG, PNG, WebP, PDF');
  }

  const id = randomUUID();
  const ext = EXT_BY_MIME[mime] ?? extname(originalName) ?? '';
  const relPath = join(personId, `${id}${ext}`);
  const abs = join(UPLOADS_DIR, relPath);
  await ensurePersonDir(personId);
  await writeFile(abs, buffer);

  let thumbRel: string | null = null;
  if (mime.startsWith('image/')) {
    const thumbName = `${id}.thumb.webp`;
    const thumbAbs = join(UPLOADS_DIR, personId, thumbName);
    try {
      await sharp(buffer).rotate().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 72 }).toFile(thumbAbs);
      thumbRel = join(personId, thumbName);
    } catch {
      thumbRel = null;
    }
  }

  return {
    id,
    filename: originalName,
    storedPath: relPath,
    thumbPath: thumbRel,
    mimeType: mime,
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

export async function readScanFile(relPath: string): Promise<Buffer> {
  return readFile(join(UPLOADS_DIR, relPath));
}

export async function deleteScanFile(relPath: string, thumbPath: string | null) {
  await Promise.all(
    [relPath, thumbPath].filter((x): x is string => !!x).map(async (p) => {
      try {
        await unlink(join(UPLOADS_DIR, p));
      } catch {
        /* ignore */
      }
    }),
  );
}
