import { z } from 'zod';
import { getSession } from '@/lib/session';
import { requireAdmin } from '@/lib/auth/guards';
import { createPrimary, newPasswordSchema, usernameSchema } from '@/lib/auth/accounts';
import { assertSameOrigin, authError, authFailure, authJson } from '@/lib/auth/errors';

const schema = z.object({ username: usernameSchema, password: newPasswordSchema }).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireAdmin();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw authError('VALIDATION', 'Проверьте имя и пароль (не менее 12 символов)', 400);
    await createPrimary(await getSession(), parsed.data.username, parsed.data.password);
    return authJson({ ok: true }, 201);
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
