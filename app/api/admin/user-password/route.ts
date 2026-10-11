import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/guards';
import { assertSameOrigin, authFailure, authJson, authError } from '@/lib/auth/errors';
import { withAuthOperation } from '@/lib/auth/mutex';
import { changePrimaryPassword } from '@/lib/storage/access-management';
const schema = z.object({ proof: z.string().min(1).max(1024), password: z.string().min(12).max(1024), recovery: z.boolean().default(false) }).strict();
export async function POST(req: Request) {
  try {
    assertSameOrigin(req); const d = schema.safeParse(await req.json().catch(() => null)); if (!d.success) throw authError('VALIDATION', 'Проверьте пароль и подтверждение доступа', 400);
    return await withAuthOperation(async () => { await requireAdmin(); return authJson(await changePrimaryPassword(d.data.proof, d.data.password, d.data.recovery)); });
  } catch (e) { return authFailure(e); }
}
export const runtime = 'nodejs';
