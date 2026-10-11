import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, lstatSync, copyFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { activeDatabasePath, dataDirectory, uploadsDirectory } from './paths';
import { closeDatabase, getDatabase, setDatabaseKey } from './database';
import { openSqlite } from './sqlite-adapter';
import { createRecoveryCode, encryptBytes, decryptBytes, wrapPassword, unwrapPassword, wrapRecovery, unwrapRecovery, type KeySlot } from '@/lib/crypto/primitives';
import { recoverCredentialTransition } from './credential-transaction';
import { atomicJson, readProtectedJson, syncFile, syncDirectory } from './atomic-files';
import { prepareGenerationTransition, recoverGenerationTransition, assertSeparateUploads } from './generation-transition';
import { vaultConfigSchema } from './vault-schema';
import { clearBatchImportJobs } from '@/lib/batch-import/jobs';
import { clearSyncJobs } from '@/lib/sync/jobs';

export type VaultConfig = { format: 1; enabled: boolean; generation?: string; passwordSlot?: KeySlot; recoverySlot?: KeySlot; accessRevision: string; accessHistory?: { id: string; parents: string[]; fingerprint: string }[] };
type State = { root?: Buffer; busy: boolean };
const g = globalThis as typeof globalThis & { tdbVaultState?: State };
const state = g.tdbVaultState ??= { busy: false };
export function readVault(): VaultConfig {
  recoverCredentialTransition();
  recoverGenerationTransition();
  const p = join(dataDirectory(), 'vault.json');
  if (!existsSync(p)) return { format: 1, enabled: false, accessRevision: 'initial' };
  return vaultConfigSchema.parse(readProtectedJson(p));
}
export function writeVault(config: VaultConfig) {
  atomicJson(join(dataDirectory(), 'vault.json'), vaultConfigSchema.parse(config));
}
export const vaultEncryptionEnabled = () => readVault().enabled;
export const vaultIsUnlocked = () => !state.busy && (!vaultEncryptionEnabled() || !!state.root);
export function vaultKey() { if (!state.root) throw new Error('Хранилище заблокировано'); return state.root; }
export async function vaultUnlock(password: string) {
  if (state.busy) throw new Error('Преобразование хранилища ещё выполняется');
  const config = readVault();
  if (!config.enabled) { await setDatabaseKey(); await getDatabase(); return; }
  const root = await unwrapPassword(config.passwordSlot!, password);
  try { await setDatabaseKey(root); await getDatabase(); state.root?.fill(0); state.root = Buffer.from(root); }
  catch (e) { await setDatabaseKey(undefined, true); throw e; }
  finally { root.fill(0); }
}
export async function vaultLock() {
  clearBatchImportJobs(); clearSyncJobs();
  const pending = (globalThis as typeof globalThis & { tdbPendingEncryption?: Map<string, { root: Buffer; expiry?: ReturnType<typeof setTimeout> }> }).tdbPendingEncryption;
  if (pending) { for (const value of pending.values()) { value.root.fill(0); if(value.expiry) clearTimeout(value.expiry); } pending.clear(); }
  state.root?.fill(0); state.root = undefined; await setDatabaseKey(undefined, readVault().enabled);
}
export function encodeAttachment(value: Buffer, path: string) { return readVault().enabled ? encryptBytes(value, vaultKey(), 'attachment', Buffer.from(path.replaceAll('\\', '/'))) : value; }
export function decodeAttachment(value: Buffer, path: string) { return readVault().enabled ? decryptBytes(value, vaultKey(), 'attachment', Buffer.from(path.replaceAll('\\', '/'))) : value; }
export async function keyFromProof(proof: string, recovery = false) {
  const config = readVault(); if (!config.enabled) return undefined;
  return recovery ? unwrapRecovery(config.recoverySlot!, proof) : unwrapPassword(config.passwordSlot!, proof);
}
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (lstatSync(dir).isSymbolicLink()) throw new Error('Символические ссылки в хранилище не поддерживаются');
  return readdirSync(dir, { withFileTypes: true }).flatMap(x => { const p = join(dir, x.name); if (x.isSymbolicLink()) throw new Error('Символические ссылки в хранилище не поддерживаются'); return x.isDirectory() ? files(p) : x.isFile() ? [p] : []; });
}
export async function convertVault(enabled: boolean, proof: string, recovery = false, target?: { root: Buffer; passwordSlot: KeySlot; recoverySlot: KeySlot; accessRevision: string }, commit: (config: VaultConfig) => void = writeVault) {
  if (state.busy) throw new Error('Операция уже выполняется');
  const old = readVault();
  if (old.enabled === enabled && !target) throw new Error('Режим шифрования уже установлен');
  state.busy = true;
  let oldRoot: Buffer | undefined, root: Buffer | undefined;
  const srcDb = activeDatabasePath(), srcUploads = uploadsDirectory(), generation = randomUUID(), dir = join(dataDirectory(), 'vaults', generation);
  try {
    assertSeparateUploads(srcUploads, srcDb, dir);
    oldRoot = await keyFromProof(proof, recovery);
    root = enabled ? (target ? Buffer.from(target.root) : randomBytes(32)) : undefined;
    const recoveryCode = enabled && !target ? createRecoveryCode() : undefined;
    const next: VaultConfig = { format: 1, enabled, generation, accessRevision: target?.accessRevision ?? randomUUID(), ...(enabled && { passwordSlot: target?.passwordSlot ?? await wrapPassword(root!, proof), recoverySlot: target?.recoverySlot ?? wrapRecovery(root!, recoveryCode!) }) };
    await closeDatabase(); await setDatabaseKey(oldRoot, true);
    prepareGenerationTransition(old.generation, generation);
    mkdirSync(join(dir, 'uploads'), { recursive: true, mode: 0o700 });
    const src = openSqlite(srcDb, oldRoot);
    try { src.pragma('wal_checkpoint(TRUNCATE)'); src.pragma('journal_mode = DELETE'); } finally { src.close(); }
    const dstDb = join(dir, 'data.db'); copyFileSync(srcDb, dstDb);
    const dst = openSqlite(dstDb, oldRoot);
    try { dst.rekey(root ?? Buffer.alloc(0)); const check = dst.pragma('integrity_check') as { integrity_check: string }[]; if (check.some(x => x.integrity_check !== 'ok')) throw new Error('Проверка базы не пройдена'); } finally { dst.close(); }
    syncFile(dstDb);
    for (const path of files(srcUploads)) {
      const rel = relative(srcUploads, path).replaceAll('\\', '/');
      const stored = readFileSync(path), plain = old.enabled ? decryptBytes(stored, oldRoot!, 'attachment', Buffer.from(rel)) : stored;
      const output = enabled ? encryptBytes(plain, root!, 'attachment', Buffer.from(rel)) : plain;
      const destination = resolve(dir, 'uploads', rel); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, output, { mode: 0o600 });
      syncFile(destination); syncDirectory(dirname(destination));
      if (enabled && !decryptBytes(readFileSync(destination), root!, 'attachment', Buffer.from(rel)).equals(plain)) throw new Error('Проверка вложения не пройдена');
      plain.fill(0);
    }
    syncDirectory(join(dir, 'uploads')); syncDirectory(dir); syncDirectory(dirname(dir));
    // The caller commits account hashes and wrapped keys together with this switch.
    commit(next);
    await setDatabaseKey(undefined, enabled); state.root?.fill(0); state.root = undefined;
    recoverGenerationTransition(true);
    return { enabled, recoveryCode, accessRevision: next.accessRevision };
  } catch (e) {
    recoverCredentialTransition();
    recoverGenerationTransition(true);
    if (readVault().generation !== generation) await setDatabaseKey(oldRoot, old.enabled && !oldRoot);
    throw e;
  } finally { oldRoot?.fill(0); root?.fill(0); state.busy = false; }
}
export async function changeVaultPassword(proof: string, password: string, recovery = false) {
  const config = readVault();
  if (!config.enabled) return { recoveryCode: undefined };
  const root = await keyFromProof(proof, recovery);
  try {
    const recoveryCode = recovery ? createRecoveryCode() : undefined;
    writeVault({ ...config, passwordSlot: await wrapPassword(root!, password), ...(recoveryCode && { recoverySlot: wrapRecovery(root!, recoveryCode) }), accessRevision: randomUUID() });
    await vaultLock(); return { recoveryCode };
  } finally { root?.fill(0); }
}
