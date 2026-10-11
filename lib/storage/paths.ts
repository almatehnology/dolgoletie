import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function databasePath() {
  const url = process.env.DATABASE_URL ?? 'file:../data/data.db';
  if (!url.startsWith('file:')) throw new Error('Поддерживается только локальная база');
  if (url.startsWith('file://')) return fileURLToPath(url);
  const path = url.slice(5);
  // Legacy Prisma resolves relative URLs from prisma/schema.prisma.
  return resolve(process.env.DATA_DIR ? process.cwd() : resolve(process.cwd(), 'prisma'), path);
}
export function dataDirectory() { return resolve(process.env.DATA_DIR ?? dirname(databasePath())); }
export function storageGeneration(): string | undefined {
  const path = join(dataDirectory(), 'vault.json');
  if (!existsSync(path)) return undefined;
  const generation = JSON.parse(readFileSync(path, 'utf8')).generation;
  if (generation == null) return undefined;
  if (typeof generation !== 'string' || !/^[a-f0-9-]{36}$/.test(generation)) throw new Error('Повреждена конфигурация хранилища');
  return generation;
}
export function activeDatabasePath() { const gen = storageGeneration(); return gen ? join(dataDirectory(), 'vaults', gen, 'data.db') : databasePath(); }
export function uploadsDirectory() { const gen = storageGeneration(); return gen ? join(dataDirectory(), 'vaults', gen, 'uploads') : resolve(process.env.UPLOADS_DIR ?? './uploads'); }
