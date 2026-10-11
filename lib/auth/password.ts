import { argon2id, hash, verify } from 'argon2';

export async function hashPassword(password: string): Promise<string> {
  if (!password || Buffer.byteLength(password, 'utf8') > 4096) {
    throw new Error('Invalid password length');
  }
  return hash(password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  const parts = passwordHash.split('$');
  if (passwordHash.length > 1024 || parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19' || !/^(?:[mtp]=\d+,){2}[mtp]=\d+$/.test(parts[3]) || !/^[A-Za-z0-9+/]+$/.test(parts[4]) || !/^[A-Za-z0-9+/]+$/.test(parts[5])) return false;
  const params = Object.fromEntries(parts[3].split(',').map(part => { const [key, value] = part.split('='); return [key, Number(value)]; }));
  if (Object.keys(params).length !== 3 || params.m > 262144 || params.m < 8192 || params.t < 1 || params.t > 10 || params.p < 1 || params.p > 8 || !password || Buffer.byteLength(password, 'utf8') > 4096) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
