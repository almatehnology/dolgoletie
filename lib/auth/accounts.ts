import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { databasePath, dataDirectory } from '@/lib/storage/paths';
import { accountVersion, authorizeSession, currentAccount } from './authorization';
import { authError } from './errors';
import { hashPassword, verifyPassword } from './password';
import { readAuth, updateAuth } from './store';
import type { SessionData, VaultHooks } from './types';

export const newPasswordSchema = z.string().min(12, 'Пароль должен содержать не менее 12 символов').max(1024);
export const usernameSchema = z.string().trim().transform((value) => value.normalize('NFKC'))
  .pipe(z.string().min(3).max(80).regex(/^[\p{L}\p{N}_.-]+$/u, 'Используйте буквы, цифры, точку, дефис или подчёркивание'))
  .refine((value) => value.toLowerCase() !== 'admin', 'Имя admin зарезервировано');

async function existingDatabase(): Promise<boolean> {
  const dataDir = dataDirectory();
  const filenames = await readdir(dataDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = filenames.filter((name) => /\.(db|sqlite|sqlite3)$/i.test(name) || name === 'vault.json').map((name) => join(dataDir, name));
  candidates.push(databasePath());
  for (const filename of candidates) {
    const info = await stat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isFile() && info.size > 0) return true;
  }
  return false;
}

export async function setupStatus() {
  const auth = await readAuth();
  if (auth.admin) return { configured: true, legacyConfirmationRequired: false, canSetup: false };
  const legacyConfirmationRequired = Boolean(process.env.APP_PASSWORD);
  return { configured: false, legacyConfirmationRequired, canSetup: legacyConfirmationRequired || !(await existingDatabase()) };
}

export async function createAdmin(password: string, legacyPassword?: string): Promise<void> {
  if (!newPasswordSchema.safeParse(password).success) throw authError('VALIDATION', 'Пароль admin должен содержать от 12 до 1024 символов', 400);
  const status = await setupStatus();
  if (status.configured) throw authError('SETUP_COMPLETE', 'Admin уже создан. Повторная настройка запрещена', 409);
  if (!status.canSetup) throw authError('LEGACY_CONFIRMATION_UNAVAILABLE', 'Для переноса существующей установки настройте её прежний APP_PASSWORD', 403);
  const expected = process.env.APP_PASSWORD;
  if (expected) {
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!legacyPassword || !timingSafeEqual(digest(expected), digest(legacyPassword))) throw authError('BAD_LEGACY_PASSWORD', 'Неверный прежний пароль установки', 403);
  }
  const passwordHash = await hashPassword(password);
  await updateAuth((auth) => {
    if (auth.admin) throw authError('SETUP_COMPLETE', 'Admin уже создан. Повторная настройка запрещена', 409);
    auth.admin = { id: randomUUID(), username: 'admin', passwordHash };
  });
}

export async function createPrimary(session: SessionData, username: string, password: string): Promise<void> {
  const parsedUsername = usernameSchema.safeParse(username);
  const parsedPassword = newPasswordSchema.safeParse(password);
  if (!parsedUsername.success || !parsedPassword.success) throw authError('VALIDATION', 'Проверьте имя пользователя и пароль (не менее 12 символов)', 400);
  authorizeSession(session, await readAuth(), 'admin');
  const passwordHash = await hashPassword(parsedPassword.data);
  await updateAuth((auth) => {
    authorizeSession(session, auth, 'admin');
    if (auth.primary) throw authError('PRIMARY_EXISTS', 'Основной пользователь уже создан', 409);
    auth.primary = { id: randomUUID(), username: parsedUsername.data, passwordHash, version: 1 };
  });
}

/** Caller serializes this with cookie writes using withAuthOperation(). */
export async function authenticateAccount(username: string, password: string, vault: VaultHooks): Promise<SessionData> {
  await vault.vaultLock();
  const auth = await readAuth();
  if (!auth.admin) throw authError('SETUP_REQUIRED', 'Сначала создайте admin', 409);
  const name = username.normalize('NFKC').trim().toLowerCase();
  const role = name === 'admin' ? 'admin' : 'user';
  const account = role === 'admin' ? auth.admin : auth.primary;
  if (!account || account.username.normalize('NFKC').trim().toLowerCase() !== name || !(await verifyPassword(account.passwordHash, password))) throw authError('BAD_CREDENTIALS', 'Неверное имя пользователя или пароль', 401);
  const session: SessionData = { authenticated: true, userId: account.id, role, authVersion: accountVersion(account) };
  const stillCurrent = async () => {
    const current = currentAccount(session, await readAuth());
    return current?.passwordHash === account.passwordHash;
  };
  if (!(await stillCurrent())) throw authError('ACCESS_CHANGED', 'Доступ изменился. Войдите снова', 401);
  if (role === 'user') {
    try {
      await vault.vaultUnlock(password);
      if (!vault.vaultIsUnlocked()) throw authError('VAULT_LOCKED', 'Не удалось открыть хранилище', 423);
      if (!(await stillCurrent())) throw authError('ACCESS_CHANGED', 'Доступ изменился. Войдите снова', 401);
    } catch (error) {
      await vault.vaultLock();
      if (error instanceof Response) throw error;
      throw authError('VAULT_UNLOCK_FAILED', 'Не удалось открыть хранилище этим паролем', 423);
    }
  }
  return session;
}
