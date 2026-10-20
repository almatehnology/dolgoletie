'use client';

import type { LocalFileKind, TravelDesktopBridge } from '../types/desktop';
import { ARCHIVE_MAX_BYTES } from './transfer-limits';
export type { LocalFileKind } from '../types/desktop';

const CHUNK_BYTES = 256 * 1024;
const SYNC_BYTES = ARCHIVE_MAX_BYTES;
const ACCEPT = { tables: '.docx,.xlsx', sync: '.zip,.tdbsync' } as const;
export interface LocalFileOptions { signal?: AbortSignal }

function checkAbort(options?: LocalFileOptions) {
  if (options?.signal?.aborted) throw new DOMException('Передача отменена', 'AbortError');
}

function bridge(): TravelDesktopBridge | undefined {
  if (typeof window === 'undefined') throw new Error('Выбор файлов доступен только в окне приложения');
  const api = window.travelDesktop;
  if (api && api.version !== 1) throw new Error('Версия desktop-интерфейса не поддерживается');
  // An incompatible/broken desktop bridge must never silently fall back to a browser download.
  return api;
}

function validateFiles(kind: LocalFileKind, files: readonly { name: string; size: number }[]) {
  const extensions = kind === 'tables' ? /\.(docx|xlsx)$/i : /\.(zip|tdbsync)$/i;
  if (!files.length || files.length > (kind === 'tables' ? 32 : 1)) throw new Error('Недопустимое количество файлов');
  let total = 0;
  for (const file of files) {
    if (!extensions.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 ||
        file.size > (kind === 'tables' ? 32 * 1024 * 1024 : SYNC_BYTES)) throw new Error('Недопустимый формат или размер файла');
    total += file.size;
  }
  if (total > (kind === 'tables' ? 128 * 1024 * 1024 : SYNC_BYTES)) throw new Error('Выбранные файлы превышают общий лимит');
}

function validateSave(blob: Blob, filename: string) {
  if (!filename || filename.length > 180 || new TextEncoder().encode(filename).length > 180 || filename.trim() !== filename ||
      /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(filename) || /[. ]$/u.test(filename) ||
      /^(?:con(?:in\$|out\$)?|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(filename) ||
      !/\.(pdf|xlsx|zip|tdbsync|tdbbackup|jpe?g|png|webp)$/i.test(filename)) throw new Error('Недопустимое имя или формат файла');
  const limit = /\.(zip|tdbsync|tdbbackup)$/i.test(filename) ? SYNC_BYTES : 64 * 1024 * 1024;
  if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > limit) throw new Error('Файл превышает лимит');
}

function browserSelect(kind: LocalFileKind, options?: LocalFileOptions): Promise<File[] | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT[kind];
    input.multiple = kind === 'tables';
    input.hidden = true;
    let finished = false;
    const onAbort = () => finish(null);
    const finish = (files: File[] | null) => {
      if (finished) return;
      finished = true;
      options?.signal?.removeEventListener('abort', onAbort);
      input.remove();
      try {
        if (files) validateFiles(kind, files);
        resolve(files);
      } catch (error) { reject(error); }
    };
    input.addEventListener('change', () => finish(input.files?.length ? Array.from(input.files) : null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    document.body.append(input);
    try { input.click(); }
    catch (error) { options?.signal?.removeEventListener('abort', onAbort); input.remove(); reject(error); }
  });
}

/** null means dialog cancelled; invalid files and I/O failures reject. */
export async function openLocalFiles(kind: LocalFileKind, options?: LocalFileOptions): Promise<File[] | null> {
  if (kind !== 'tables' && kind !== 'sync') throw new Error('Недопустимый вид файлов');
  if (options?.signal?.aborted) return null;
  const api = bridge();
  if (!api) return browserSelect(kind, options);
  const selected = await api.selectFiles({ kind });
  if (!selected) return null;
  try {
    checkAbort(options);
    validateFiles(kind, selected);
    const files: File[] = [];
    for (const entry of selected) {
      const parts: ArrayBuffer[] = [];
      let position = 0;
      do {
        checkAbort(options);
        const chunk = await api.readFileChunk(entry.id, position);
        checkAbort(options);
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > CHUNK_BYTES ||
            chunk.byteLength > entry.size - position || (chunk.byteLength === 0 && position < entry.size)) throw new Error('Повреждённая передача файла');
        // Each IPC message is bounded; File requires retaining the selected file in renderer memory.
        parts.push(new Uint8Array(chunk).buffer);
        position += chunk.byteLength;
      } while (position < entry.size);
      files.push(new File(parts, entry.name, { type: entry.mimeType, lastModified: entry.lastModified }));
    }
    return files;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  } finally { await api.releaseFiles(selected.map((entry) => entry.id)); }
}

/** false means native dialog cancelled. Browser true means download initiated, not durable write. */
export async function saveLocalFile(blob: Blob, filename: string, options?: LocalFileOptions): Promise<boolean> {
  validateSave(blob, filename);
  if (options?.signal?.aborted) return false;
  const api = bridge();
  if (!api) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    try { anchor.click(); }
    finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    return true;
  }
  const transfer = await api.beginSave(filename, blob.size);
  if (!transfer) return false;
  try {
    checkAbort(options);
    if (transfer.chunkBytes !== CHUNK_BYTES) throw new Error('Недопустимый размер блока desktop');
    // slice avoids materialising a second full Blob/ArrayBuffer and bounds IPC/backpressure.
    for (let position = 0; position < blob.size; position += CHUNK_BYTES) {
      checkAbort(options);
      const bytes = new Uint8Array(await blob.slice(position, position + CHUNK_BYTES).arrayBuffer());
      checkAbort(options);
      const written = await api.writeSaveChunk(transfer.id, position, bytes);
      if (written !== position + bytes.length) throw new Error('Неполная запись файла');
    }
    checkAbort(options);
    return await api.finishSave(transfer.id);
  } catch (error) {
    // Cleanup failure must remain visible, including when cancellation was requested.
    await api.cancelSave(transfer.id);
    if (error instanceof DOMException && error.name === 'AbortError') return false;
    throw error;
  }
}
