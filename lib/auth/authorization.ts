import { createHash } from 'node:crypto';
import { authError } from './errors';
import type { AdminAccount, AuthMetadata, AuthRole, PrimaryAccount, SessionData } from './types';

export function accountVersion(account: AdminAccount | PrimaryAccount): string | number {
  if ('version' in account) return account.version;
  // Changing a local admin credential also invalidates old admin cookies.
  return createHash('sha256').update(account.id).update('\0').update(account.passwordHash).digest('hex');
}

export function currentAccount(session: SessionData, auth: AuthMetadata): AdminAccount | PrimaryAccount | null {
  if (session.authenticated !== true || !session.userId) return null;
  const account = session.role === 'user' ? auth.primary : session.role === 'admin' ? auth.admin : undefined;
  if (!account || session.userId !== account.id || session.authVersion !== accountVersion(account)) return null;
  return account;
}

export function authorizeSession(session: SessionData, auth: AuthMetadata, role: 'user'): PrimaryAccount;
export function authorizeSession(session: SessionData, auth: AuthMetadata, role: 'admin'): AdminAccount;
export function authorizeSession(session: SessionData, auth: AuthMetadata, role: AuthRole): AdminAccount | PrimaryAccount {
  const account = currentAccount(session, auth);
  if (!account) throw authError('UNAUTHORIZED', 'Сессия истекла. Войдите снова', 401);
  if (session.role !== role) throw authError('FORBIDDEN', role === 'user' ? 'Содержимое доступно только основному пользователю' : 'Требуется вход admin', 403);
  return account;
}

export function assertVaultUnlocked(unlocked: boolean): void {
  if (!unlocked) throw authError('VAULT_LOCKED', 'Хранилище закрыто. Войдите снова', 423);
}
