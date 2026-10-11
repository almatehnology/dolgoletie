import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/guards';
import { assertSameOrigin, authError, authFailure, authJson } from '@/lib/auth/errors';
import { withAuthOperation } from '@/lib/auth/mutex';
import { completePendingAccess } from '@/lib/storage/sync-access';
import { vaultLock } from '@/lib/storage/vault';
const schema = z.object({ token: z.string(), proof: z.string().min(1).max(1024), recovery: z.boolean().default(false), incomingPassword: z.string().max(1024).optional() }).strict();
export async function POST(req: Request) {
  try {
    assertSameOrigin(req); const d = schema.safeParse(await req.json().catch(() => null)); if (!d.success) throw authError('VALIDATION', 'Проверьте подтверждение доступа', 400);
    return await withAuthOperation(async () => { await requireAdmin(); try { return authJson(await completePendingAccess(d.data.token, d.data.proof, d.data.recovery, d.data.incomingPassword)); } finally { await vaultLock(); } });
  } catch (e) { return authFailure(e); }
}
export const runtime = 'nodejs';
