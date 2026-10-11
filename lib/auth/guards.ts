import { getSession } from '@/lib/session';
import { vaultIsUnlocked } from '@/lib/storage/vault';
import { readAuth } from './store';
import { assertVaultUnlocked, authorizeSession } from './authorization';

/** API handlers must return a caught Response instead of swallowing authorization errors. */
export async function requireUser() {
  const user = authorizeSession(await getSession(), await readAuth(), 'user');
  assertVaultUnlocked(vaultIsUnlocked());
  return user;
}

export async function requireAdmin() {
  return authorizeSession(await getSession(), await readAuth(), 'admin');
}
