import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';

export type KeySlot = { salt: string; nonce: string; tag: string; value: string; memoryCost: number; timeCost: number; parallelism: number };
const parameters = { memoryCost: 65536, timeCost: 3, parallelism: 1 };
const b64 = (v: Buffer) => v.toString('base64');
function from64(v: string, size?: number) {
  if (typeof v !== 'string' || v.length > 256 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new Error('Повреждён контейнер ключа');
  const b = Buffer.from(v, 'base64'); if (size && b.length !== size) throw new Error('Повреждён контейнер ключа'); return b;
}
export function derivedKey(root: Buffer, context: string) { return Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), `dolgoletie/${context}/v1`, 32)); }
async function passwordKey(password: string, salt: Buffer) {
  if (!password || password.length > 1024) throw new Error('Некорректный пароль');
  return argon2.hash(password, { type: argon2.argon2id, ...parameters, salt, hashLength: 32, raw: true });
}
function recoveryKey(code: string) {
  const normalized = code.replace(/[-\s]/g, '').toUpperCase();
  if (!/^[A-F0-9]{48}$/.test(normalized)) throw new Error('Некорректный ключ восстановления');
  return createHash('sha256').update('dolgoletie/recovery/v1\0').update(normalized).digest();
}
function wrap(root: Buffer, key: Buffer, salt: Buffer): KeySlot {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('dolgoletie/key-slot/v1'));
  const value = Buffer.concat([cipher.update(root), cipher.final()]);
  return { ...parameters, salt: b64(salt), nonce: b64(nonce), tag: b64(cipher.getAuthTag()), value: b64(value) };
}
function unwrap(slot: KeySlot, key: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key, from64(slot.nonce, 12));
  decipher.setAAD(Buffer.from('dolgoletie/key-slot/v1')); decipher.setAuthTag(from64(slot.tag, 16));
  try { const root = Buffer.concat([decipher.update(from64(slot.value, 32)), decipher.final()]); return root; }
  catch { throw new Error('Неверный пароль или ключ восстановления'); }
}
export async function wrapPassword(root: Buffer, password: string) {
  const salt = randomBytes(16), key = await passwordKey(password, salt);
  try { return wrap(root, key, salt); } finally { key.fill(0); }
}
export async function unwrapPassword(slot: KeySlot, password: string) {
  if (!slot || slot.memoryCost !== parameters.memoryCost || slot.timeCost !== parameters.timeCost || slot.parallelism !== 1) throw new Error('Неподдерживаемые параметры ключа');
  const key = await passwordKey(password, from64(slot.salt, 16));
  try { return unwrap(slot, key); } finally { key.fill(0); }
}
export function createRecoveryCode() { return randomBytes(24).toString('hex').toUpperCase().match(/.{4}/g)!.join('-'); }
export function wrapRecovery(root: Buffer, code: string) { const key = recoveryKey(code); try { return wrap(root, key, randomBytes(16)); } finally { key.fill(0); } }
export function unwrapRecovery(slot: KeySlot, code: string) { const key = recoveryKey(code); try { return unwrap(slot, key); } finally { key.fill(0); } }
export function encryptBytes(value: Buffer, root: Buffer, context: string, aad: Buffer = Buffer.alloc(0)) {
  const key = derivedKey(root, context), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  try { const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([Buffer.from('TDBE1'), nonce, cipher.getAuthTag(), data]); }
  finally { key.fill(0); }
}
export function decryptBytes(value: Buffer, root: Buffer, context: string, aad: Buffer = Buffer.alloc(0)) {
  if (value.length < 33 || value.subarray(0, 5).toString() !== 'TDBE1') throw new Error('Повреждён зашифрованный файл');
  const key = derivedKey(root, context), decipher = createDecipheriv('aes-256-gcm', key, value.subarray(5, 17));
  decipher.setAAD(aad); decipher.setAuthTag(value.subarray(17, 33));
  try { return Buffer.concat([decipher.update(value.subarray(33)), decipher.final()]); }
  catch { throw new Error('Файл повреждён или ключ не подходит'); }
  finally { key.fill(0); }
}
