import { existsSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { dataDirectory, databasePath } from './paths';
import { atomicJson, readProtectedJson, removeDurably, syncDirectory } from './atomic-files';
import { generationSchema } from './vault-schema';

const schema = z.object({ format: z.literal(1), source: generationSchema.nullable(), target: generationSchema }).strict().refine(value => value.source !== value.target);
export function assertSeparateUploads(uploads: string, database: string, target: string) {
  for (const path of [database, target]) {
    const rel = relative(uploads, path);
    if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) throw new Error('Каталог вложений должен находиться отдельно от базы и поколений хранилища');
  }
}
export function prepareGenerationTransition(source: string | undefined, target: string) {
  atomicJson(join(dataDirectory(), 'storage-transition.json'), schema.parse({ format: 1, source: source ?? null, target }));
}
/** Resolve a crash on either side of the atomic generation switch. No keys are persisted. */
export function recoverGenerationTransition(force = false) {
  if (!force && (globalThis as typeof globalThis & { tdbVaultState?: { busy: boolean } }).tdbVaultState?.busy) return;
  const marker = join(dataDirectory(), 'storage-transition.json');
  if (!existsSync(marker)) return;
  const transition = schema.parse(readProtectedJson(marker));
  const vaultFile = join(dataDirectory(), 'vault.json');
  const active = existsSync(vaultFile) ? (readProtectedJson(vaultFile) as { generation?: unknown }).generation : undefined;
  if (active === transition.target) {
    if (transition.source) {
      rmSync(join(dataDirectory(), 'vaults', transition.source), { recursive: true, force: true });
      syncDirectory(join(dataDirectory(), 'vaults'));
    } else {
      const db = databasePath(), uploads = resolve(process.env.UPLOADS_DIR ?? './uploads');
      assertSeparateUploads(uploads, db, join(dataDirectory(), 'vaults', transition.target));
      for (const path of [db, `${db}-wal`, `${db}-shm`]) rmSync(path, { force: true });
      syncDirectory(dirname(db));
      // Docker bind mounts cannot be removed (EBUSY). Remove the obsolete
      // plaintext contents while retaining the mount directory itself.
      if (existsSync(uploads)) {
        const info = lstatSync(uploads);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Недопустимый каталог вложений');
        for (const entry of readdirSync(uploads)) rmSync(join(uploads, entry), { recursive: true, force: true });
        syncDirectory(uploads);
      }
    }
  } else {
    rmSync(join(dataDirectory(), 'vaults', transition.target), { recursive: true, force: true });
    if (existsSync(join(dataDirectory(), 'vaults'))) syncDirectory(join(dataDirectory(), 'vaults'));
  }
  removeDurably(marker);
}
