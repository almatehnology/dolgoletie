import { z } from 'zod';
import { createAdmin, newPasswordSchema, setupStatus } from '@/lib/auth/accounts';
import { assertSameOrigin, authError, authFailure, authJson } from '@/lib/auth/errors';

const schema = z.object({ password: newPasswordSchema, legacyPassword: z.string().max(4096).optional() }).strict();

export async function GET() {
  try { return authJson(await setupStatus()); } catch (error) { return authFailure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw authError('VALIDATION', 'Проверьте пароль admin (не менее 12 символов)', 400);
    await createAdmin(parsed.data.password, parsed.data.legacyPassword);
    return authJson({ ok: true, next: '/login?role=admin' }, 201);
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
