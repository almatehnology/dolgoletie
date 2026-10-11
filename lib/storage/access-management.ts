import { randomBytes, randomUUID } from 'node:crypto';
import { readAuth } from '@/lib/auth/store';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { newPasswordSchema } from '@/lib/auth/accounts';
import { authError } from '@/lib/auth/errors';
import { accessFingerprint } from '@/lib/crypto/bundle';
import { createRecoveryCode, wrapPassword, wrapRecovery } from '@/lib/crypto/primitives';
import { commitCredentialFiles } from './credential-transaction';
import { readVault, keyFromProof, convertVault, vaultLock, type VaultConfig } from './vault';

type Pending = { owner: string; root: Buffer; recoveryCode: string; passwordSlot: NonNullable<VaultConfig['passwordSlot']>; recoverySlot: NonNullable<VaultConfig['recoverySlot']>; fingerprint: string; expires: number; expiry?: ReturnType<typeof setTimeout> };
const g = globalThis as typeof globalThis & { tdbPendingEncryption?: Map<string, Pending> };
const pending = g.tdbPendingEncryption ??= new Map<string, Pending>();
function cleanup() { for (const [id, p] of pending) if (p.expires < Date.now()) { p.root.fill(0); pending.delete(id); } }
async function verifyPrimary(proof: string, recovery = false) {
  const auth = await readAuth(); if (!auth.primary) throw authError('NO_USER', 'Сначала создайте основного пользователя', 409);
  if (!recovery && !await verifyPassword(auth.primary.passwordHash, proof)) throw authError('BAD_PROOF', 'Неверный текущий пароль пользователя', 403);
  if (recovery && !readVault().enabled) throw authError('NO_RECOVERY', 'Ключ восстановления доступен только для зашифрованной базы', 409);
  return auth;
}
function history(old: VaultConfig, next: VaultConfig, oldFingerprint: string, nextFingerprint: string) {
  const previous = old.accessRevision === 'initial' ? oldFingerprint : old.accessRevision;
  const all = old.accessHistory ?? [{ id: previous, parents: [], fingerprint: oldFingerprint }];
  return [...all, { id: next.accessRevision, parents: [previous], fingerprint: nextFingerprint }];
}
export async function prepareEncryption(owner: string, proof: string) {
  cleanup(); if (pending.size >= 4) throw authError('BUSY', 'Завершите предыдущую подготовку шифрования', 409);
  const auth = await verifyPrimary(proof); const vault = readVault();
  if (vault.enabled) throw authError('ALREADY_ENCRYPTED', 'Шифрование уже включено', 409);
  const root = randomBytes(32), recoveryCode = createRecoveryCode(), token = randomUUID();
  const value: Pending = { owner, root, recoveryCode, passwordSlot: await wrapPassword(root, proof), recoverySlot: wrapRecovery(root, recoveryCode), fingerprint: accessFingerprint({ primary: auth.primary, vault }), expires: Date.now() + 15 * 60 * 1000 };
  value.expiry = setTimeout(() => { root.fill(0); pending.delete(token); }, 15 * 60 * 1000); value.expiry.unref();
  pending.set(token, value);
  return { token, recoveryCode };
}
export async function enableEncryption(owner: string, proof: string, token: string, confirmed: boolean) {
  cleanup(); const item = pending.get(token);
  if (!item || item.owner !== owner || !confirmed) throw authError('CONFIRM_RECOVERY', 'Подтвердите сохранение ключа восстановления', 400);
  const auth = await verifyPrimary(proof), before = readVault();
  if (item.fingerprint !== accessFingerprint({ primary: auth.primary, vault: before })) throw authError('STALE', 'Доступ изменился. Подготовьте шифрование заново', 409);
  await convertVault(true, proof, false, { root: item.root, passwordSlot: item.passwordSlot, recoverySlot: item.recoverySlot, accessRevision: randomUUID() }, next => {
    auth.primary!.version++;
    next.accessHistory = history(before, next, item.fingerprint, accessFingerprint({ primary: auth.primary, vault: next }));
    commitCredentialFiles(auth, next);
  });
  pending.delete(token); if (item.expiry) clearTimeout(item.expiry); item.root.fill(0);
  return { enabled: true };
}
export async function disableEncryption(proof: string, recovery: boolean) {
  const auth = await verifyPrimary(proof, recovery), before = readVault(), fingerprint = accessFingerprint({ primary: auth.primary, vault: before });
  await convertVault(false, proof, recovery, undefined, next => {
    auth.primary!.version++; next.accessHistory = history(before, next, fingerprint, accessFingerprint({ primary: auth.primary, vault: next }));
    commitCredentialFiles(auth, next);
  });
  return { enabled: false };
}
export async function changePrimaryPassword(proof: string, password: string, recovery: boolean) {
  if (!newPasswordSchema.safeParse(password).success) throw authError('VALIDATION', 'Новый пароль должен содержать не менее 12 символов', 400);
  const auth = await verifyPrimary(proof, recovery), old = readVault(), fingerprint = accessFingerprint({ primary: auth.primary, vault: old });
  const root = await keyFromProof(proof, recovery), recoveryCode = recovery ? createRecoveryCode() : undefined;
  try {
    const next: VaultConfig = { ...old, accessRevision: randomUUID(), ...(root && { passwordSlot: await wrapPassword(root, password), ...(recoveryCode && { recoverySlot: wrapRecovery(root, recoveryCode) }) }) };
    auth.primary!.passwordHash = await hashPassword(password); auth.primary!.version++;
    next.accessHistory = history(old, next, fingerprint, accessFingerprint({ primary: auth.primary, vault: next }));
    commitCredentialFiles(auth, next); await vaultLock(); return { ok: true, recoveryCode };
  } finally { root?.fill(0); }
}
