import { getSession } from '@/lib/session';
import { vaultLock } from '@/lib/storage/vault';
import { withAuthOperation } from '@/lib/auth/mutex';
import { assertSameOrigin, authFailure, authJson } from '@/lib/auth/errors';
import { sessionRegistry } from '@/lib/auth/session-registry';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return await withAuthOperation(async () => {
      const session = await getSession();
      // An old tab must not log out a newer login using a replaced cookie.
      try {
        if (sessionRegistry.isActive(session)) { sessionRegistry.revoke(); await vaultLock(); }
      } finally { session.destroy(); }
      return authJson({ ok: true });
    });
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
