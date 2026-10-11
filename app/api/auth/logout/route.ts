import { getSession } from '@/lib/session';
import { vaultLock } from '@/lib/storage/vault';
import { withAuthOperation } from '@/lib/auth/mutex';
import { assertSameOrigin, authFailure, authJson } from '@/lib/auth/errors';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return await withAuthOperation(async () => {
      const session = await getSession();
      try { await vaultLock(); } finally { session.destroy(); }
      return authJson({ ok: true });
    });
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
