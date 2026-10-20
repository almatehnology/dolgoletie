import { getSession } from '@/lib/session';
import { readAuth } from '@/lib/auth/store';
import { currentAccount } from '@/lib/auth/authorization';
import { authFailure, authJson } from '@/lib/auth/errors';
import { vaultIsUnlocked } from '@/lib/storage/vault';
import { sessionRegistry } from '@/lib/auth/session-registry';

export async function GET() {
  try {
    const session = await getSession();
    const account = currentAccount(session, await readAuth());
    const authenticated = Boolean(sessionRegistry.isActive(session) && account && (session.role === 'admin' || vaultIsUnlocked()));
    return authJson({ authenticated, role: authenticated ? session.role : null, ...sessionRegistry.status(session) });
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
