import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve, dirname, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { uploadsDirectory } from './storage/paths';
import { encodeAttachment, decodeAttachment } from './storage/vault';

export let UPLOADS_DIR = uploadsDirectory();
export function getUploadsDir() { return UPLOADS_DIR = uploadsDirectory(); }
export function safeAttachmentPath(rel: string) {
  const normalized = rel.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('Недопустимый путь вложения');
  const root = getUploadsDir(), full = resolve(root, normalized);
  if (relative(root, full).startsWith('..')) throw new Error('Недопустимый путь вложения');
  return { normalized, root, full };
}
async function assertSafeParents(full: string, root: string) {
  for (let p = dirname(full); p !== dirname(root); p = dirname(p)) {
    const info = await lstat(p).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error('Недопустимый путь вложения');
    if (p === root) break;
  }
}
export async function writeScanFile(rel: string, value: Buffer) {
  const { normalized, full, root } = safeAttachmentPath(rel);
  await assertSafeParents(full, root); await mkdir(dirname(full), { recursive: true });
  if (existsSync(full)) {
    const current = await readScanFile(normalized);
    if (!current.equals(value)) throw new Error('Файл с этим идентификатором уже имеет другое содержимое');
    return;
  }
  const tmp = `${full}.${randomUUID()}.tmp`;
  await writeFile(tmp, encodeAttachment(value, normalized), { mode: 0o600, flag: 'wx' });
  await rename(tmp, full);
}
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
  getUploadsDir();
  if (!existsSync(UPLOADS_DIR)) await mkdir(UPLOADS_DIR, { recursive: true });
}

export async function ensurePersonDir(personId: string) {
  await ensureUploadsDir();
  const dir = safeAttachmentPath(`${personId}/placeholder`).full.replace(/[/\\]placeholder$/, '');
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveScanFile(personId: string, originalName: string, buffer: Buffer) {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Файл больше ${process.env.MAX_UPLOAD_MB ?? 10} МБ`);
  }
  const { fileTypeFromBuffer } = await import('file-type');
  const sniff = await fileTypeFromBuffer(buffer);
  const mime = sniff?.mime;
  if (!mime || !ALLOWED_MIME.has(mime)) {
    throw new Error('Поддерживаются только JPG, PNG, WebP, PDF');
  }

  const id = randomUUID();
  const ext = EXT_BY_MIME[mime] ?? extname(originalName) ?? '';
  const relPath = `${personId}/${id}${ext}`;
  await ensurePersonDir(personId);
  await writeScanFile(relPath, buffer);

  let thumbRel: string | null = null;
  if (mime.startsWith('image/')) {
    const thumbName = `${id}.thumb.webp`;
    try {
      const thumb = await sharp(buffer).rotate().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      thumbRel = `${personId}/${thumbName}`;
      await writeScanFile(thumbRel, thumb);
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
  const { normalized, full, root } = safeAttachmentPath(relPath);
  await assertSafeParents(full, root);
  if ((await lstat(full)).isSymbolicLink()) throw new Error('Недопустимый файл вложения');
  return decodeAttachment(await readFile(full), normalized);
}

export async function deleteScanFile(relPath: string, thumbPath: string | null) {
  // Keep immutable objects while offline peers may need their prior versions.
  safeAttachmentPath(relPath);
  if (thumbPath) safeAttachmentPath(thumbPath);
}
