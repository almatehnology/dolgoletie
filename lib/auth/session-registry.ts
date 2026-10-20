import { vaultLock } from '@/lib/storage/vault';
import { IdleSessionRegistry } from './idle-session';
import { withAuthOperation } from './mutex';
import { authError } from './errors';
import type { SessionData } from './types';

const globalSessions = globalThis as typeof globalThis & { tdbIdleSessionRegistry?: IdleSessionRegistry };
export const sessionRegistry = globalSessions.tdbIdleSessionRegistry ??= new IdleSessionRegistry((generation) => {
  // Never close the DB midway through an encryption/login transition. A newer login
  // already locks the old vault itself, so a queued old expiry must not lock it again.
  void withAuthOperation(async () => {
    if (sessionRegistry.generation === generation) await vaultLock();
  }).catch(() => { console.error('Idle session vault lock failed'); });
});

export function requireActiveSession(session: SessionData): void {
  if (!sessionRegistry.isActive(session)) throw authError('UNAUTHORIZED', 'Сессия истекла. Войдите снова', 401);
}
