import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/guards';
import { assertSameOrigin, authFailure, authJson, authError } from '@/lib/auth/errors';
import { withAuthOperation } from '@/lib/auth/mutex';
import { prepareEncryption, enableEncryption, disableEncryption } from '@/lib/storage/access-management';

const schema = z.object({ action: z.enum(['prepare', 'enable', 'disable']), proof: z.string().min(1).max(1024), recovery: z.boolean().default(false), token: z.string().optional(), confirmed: z.boolean().optional() }).strict();
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const d = schema.safeParse(await req.json().catch(() => null)); if (!d.success) throw authError('VALIDATION', 'Проверьте параметры операции', 400);
    return await withAuthOperation(async () => {
      const admin = await requireAdmin(); const p = d.data;
      const result = p.action === 'prepare' ? await prepareEncryption(admin.id, p.proof) : p.action === 'enable' ? await enableEncryption(admin.id, p.proof, p.token ?? '', p.confirmed === true) : await disableEncryption(p.proof, p.recovery);
      return authJson(result);
    });
  } catch (e) { return authFailure(e); }
}
export const runtime = 'nodejs';
