import { createHash } from 'node:crypto';
import { readAuth } from '@/lib/auth/store';
import type { PrimaryAccount } from '@/lib/auth/types';
import { readVault, vaultKey, type VaultConfig } from '@/lib/storage/vault';
import { encryptBytes, decryptBytes, unwrapPassword } from './primitives';
import { z } from 'zod';
import { primaryAccountSchema } from '@/lib/auth/metadata-schema';
import { vaultConfigSchema } from '@/lib/storage/vault-schema';

export type TransferAccess = { primary?: PrimaryAccount; vault: VaultConfig; root?: Buffer; password?: string };
const MAGIC = Buffer.from('TDBSYNC1');
const headerSchema = z.object({ version: z.literal(1), encrypted: z.boolean(), access: z.object({ primary: primaryAccountSchema.optional(), vault: vaultConfigSchema }).strict() }).strict().refine(value => value.encrypted === value.access.vault.enabled && (!value.encrypted || !!value.access.primary));
export function accessFingerprint(access: Omit<TransferAccess, 'root' | 'password'>) {
  const { primary, vault } = access;
  // Key-slot object property order changes after schema parsing; it is not a credential change.
  const slot = (value: VaultConfig['passwordSlot']) => value && { salt: value.salt, nonce: value.nonce, tag: value.tag, value: value.value, memoryCost: value.memoryCost, timeCost: value.timeCost, parallelism: value.parallelism };
  return createHash('sha256').update(JSON.stringify({ primary: primary ? { id: primary.id, username: primary.username, passwordHash: primary.passwordHash } : null, enabled: vault.enabled, passwordSlot: slot(vault.passwordSlot), recoverySlot: slot(vault.recoverySlot) })).digest('hex');
}
export async function encodeVaultBundle(payload: Buffer) {
  const { primary } = await readAuth(), vault = readVault();
  const header = { version: 1, encrypted: vault.enabled, access: { primary, vault: { ...vault, generation: undefined } } };
  const json = Buffer.from(JSON.stringify(header));
  headerSchema.parse(header);
  if (json.length > 262144) throw new Error('История доступа превышает размер заголовка');
  const size = Buffer.alloc(4); size.writeUInt32BE(json.length);
  const aad = Buffer.concat([MAGIC, size, json]);
  return Buffer.concat([aad, vault.enabled ? encryptBytes(payload, vaultKey(), 'sync', aad) : payload]);
}
export async function decodeVaultBundle(input: Buffer, password?: string): Promise<{ payload: Buffer; access: TransferAccess | null }> {
  if (input.length > 512 * 1024 * 1024) throw new Error('Файл превышает лимит');
  if (!input.subarray(0, MAGIC.length).equals(MAGIC)) return { payload: input, access: null };
  if (input.length < 12) throw new Error('Повреждён заголовок файла');
  const size = input.readUInt32BE(8); if (size > 262144 || size < 1 || input.length < 12 + size) throw new Error('Повреждён заголовок файла');
  const header = headerSchema.parse(JSON.parse(input.subarray(12, 12 + size).toString('utf8')));
  const access: TransferAccess = header.access;
  const payload = input.subarray(12 + size);
  if (!header.encrypted) return { payload, access };
  if (!password) throw new Error('Введите пароль файла синхронизации');
  const root = await unwrapPassword(access.vault.passwordSlot!, password);
  try {
    const plain = decryptBytes(payload, root, 'sync', input.subarray(0, 12 + size));
    // Ephemeral server-side proof, never serialize access into a UI response.
    access.root = Buffer.from(root); access.password = password;
    return { payload: plain, access };
  } finally { root.fill(0); }
}
