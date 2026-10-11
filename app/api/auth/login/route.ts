import { z } from 'zod';
import { getSession } from '@/lib/session';
import * as vault from '@/lib/storage/vault';
import { authenticateAccount } from '@/lib/auth/accounts';
import { assertSameOrigin, authError, authFailure, authJson } from '@/lib/auth/errors';
import { withAuthOperation } from '@/lib/auth/mutex';

const schema = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(1024) }).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw authError('BAD_REQUEST', 'Введите имя пользователя и пароль', 400);
    return await withAuthOperation(async () => {
      const session = await getSession();
      session.destroy();
      try {
        const authenticated = await authenticateAccount(parsed.data.username, parsed.data.password, vault);
        Object.assign(session, authenticated);
        await session.save();
        return authJson({ ok: true, role: authenticated.role, next: authenticated.role === 'admin' ? '/admin' : '/' });
      } catch (error) {
        await vault.vaultLock();
        session.destroy();
        throw error;
      }
    });
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
