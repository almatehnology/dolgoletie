import { getSession } from '@/lib/session';
import { readAuth } from '@/lib/auth/store';
import { currentAccount, assertVaultUnlocked } from '@/lib/auth/authorization';
import { sessionRegistry, requireActiveSession } from '@/lib/auth/session-registry';
import { assertSameOrigin, authError, authFailure, authJson } from '@/lib/auth/errors';
import { vaultIsUnlocked } from '@/lib/storage/vault';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession();
    if (!currentAccount(session, await readAuth())) throw authError('UNAUTHORIZED', 'Сессия истекла. Войдите снова', 401);
    requireActiveSession(session);
    if (session.role === 'user') assertVaultUnlocked(vaultIsUnlocked());
    sessionRegistry.touch(session);
    return authJson({ ok: true, ...sessionRegistry.status(session) });
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
