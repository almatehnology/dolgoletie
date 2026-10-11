import { constants, lstatSync, openSync, readFileSync, closeSync, fsyncSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function syncFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function readProtectedJson(path: string, maxBytes = 1024 * 1024): unknown {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Недопустимый файл настроек');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
}
export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    syncFile(tmp); renameSync(tmp, path); syncDirectory(dirname(path));
  } finally { rmSync(tmp, { force: true }); }
}
export function removeDurably(path: string) { rmSync(path, { force: true }); syncDirectory(dirname(path)); }
