import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { authMetadataSchema as schema } from './metadata-schema';
import { recoverCredentialTransition } from '@/lib/storage/credential-transaction';
import { dataDirectory } from '@/lib/storage/paths';
import { withMutex } from './mutex';
import type { AuthMetadata } from './types';

export { hashPassword, verifyPassword } from './password';

export class AuthStoreError extends Error {
  constructor(public readonly code: 'INVALID_METADATA' | 'LOCK_TIMEOUT' | 'UNSAFE_FILE') {
    super(code);
    this.name = 'AuthStoreError';
  }
}

export function authFilePath(): string {
  return resolve(process.env.AUTH_FILE ?? join(dataDirectory(), 'auth.json'));
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function isExists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'EEXIST'; }

async function readMetadata(filename: string): Promise<AuthMetadata> {
  let handle;
  try {
    // Do not follow a symlink or accidentally read a database file as credentials.
    const info = await lstat(filename);
    if (!info.isFile()) throw new AuthStoreError('UNSAFE_FILE');
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > 1024 * 1024) throw new AuthStoreError('UNSAFE_FILE');
    await handle.chmod(0o600);
    const data: unknown = JSON.parse(await handle.readFile('utf8'));
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AuthStoreError('INVALID_METADATA');
    return parsed.data;
  } catch (error) {
    if (isMissing(error)) return { version: 1 };
    if (error instanceof SyntaxError) throw new AuthStoreError('INVALID_METADATA');
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readAuth(): Promise<AuthMetadata> {
  recoverCredentialTransition();
  // Atomic rename makes concurrent readers see a complete old or new snapshot.
  return readMetadata(authFilePath());
}

async function removeDeadLock(filename: string): Promise<void> {
  // Serialize reapers, so two waiters cannot delete a newly acquired lock.
  const reaperName = `${filename}.reap`;
  let reaper;
  try {
    reaper = await open(reaperName, 'wx', 0o600);
  } catch (error) {
    if (isExists(error)) return;
    throw error;
  }
  try {
    const info = await lstat(filename).catch(() => null);
    if (!info?.isFile()) return;
    let pid: number;
    try {
      const owner = JSON.parse(await readFile(filename, 'utf8')) as { pid?: unknown };
      if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) return;
      pid = Number(owner.pid);
    } catch { return; }
    try { process.kill(pid, 0); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
    }
    const latest = await lstat(filename).catch(() => null);
    if (latest?.ino === info.ino && latest.dev === info.dev) await unlink(filename);
  } finally {
    await reaper.close();
    await unlink(reaperName);
  }
}

async function acquireFileLock(filename: string): Promise<() => Promise<void>> {
  const lockName = `${filename}.lock`;
  const deadline = Date.now() + 15_000;
  while (true) {
    let handle;
    try {
      handle = await open(lockName, 'wx', 0o600);
    } catch (error) {
      if (!isExists(error)) throw error;
      await removeDeadLock(lockName);
      if (Date.now() >= deadline) throw new AuthStoreError('LOCK_TIMEOUT');
      await delay(25);
      continue;
    }
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(lockName);
      throw error;
    }
    return async () => { await handle.close(); await unlink(lockName); };
  }
}

async function atomicWrite(filename: string, value: AuthMetadata): Promise<void> {
  const tempName = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempName, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempName, filename);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(filename), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await unlink(tempName).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  }
}

export async function updateAuth(
  mutator: (metadata: AuthMetadata) => void | AuthMetadata | Promise<void | AuthMetadata>,
): Promise<AuthMetadata> {
  const filename = authFilePath();
  return withMutex(`metadata:${filename}`, async () => {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    const release = await acquireFileLock(filename);
    try {
      const current = await readMetadata(filename);
      const result = await mutator(current);
      const parsed = schema.safeParse(result ?? current);
      if (!parsed.success) throw new AuthStoreError('INVALID_METADATA');
      await atomicWrite(filename, parsed.data);
      return structuredClone(parsed.data);
    } finally {
      await release();
    }
  });
}
