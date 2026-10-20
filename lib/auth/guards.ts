import { getSession } from '@/lib/session';
import { vaultIsUnlocked } from '@/lib/storage/vault';
import { readAuth } from './store';
import { assertVaultUnlocked, authorizeSession } from './authorization';
import { requireActiveSession } from './session-registry';

/** API handlers must return a caught Response instead of swallowing authorization errors. */
export async function requireUser() {
  const session = await getSession();
  const user = authorizeSession(session, await readAuth(), 'user');
  requireActiveSession(session);
  assertVaultUnlocked(vaultIsUnlocked());
  return user;
}

export async function requireAdmin() {
  const session = await getSession();
  const admin = authorizeSession(session, await readAuth(), 'admin');
  requireActiveSession(session);
  return admin;
}
