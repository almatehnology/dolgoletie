import { requireAdmin } from '@/lib/auth/guards';
import { assertSameOrigin, authError, authFailure, authJson } from '@/lib/auth/errors';
import { withAuthOperation } from '@/lib/auth/mutex';
import { readSessionSettings, writeSessionSettings, sessionSettingsSchema } from '@/lib/auth/security-settings';
import { sessionRegistry } from '@/lib/auth/session-registry';

export async function GET() {
  try { await requireAdmin(); return authJson(readSessionSettings()); }
  catch (error) { return authFailure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return await withAuthOperation(async () => {
      await requireAdmin();
      const parsed = sessionSettingsSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) throw authError('VALIDATION', 'Укажите от 1 до 1440 минут или отключите таймер', 400);
      await requireAdmin();
      const settings = writeSessionSettings(parsed.data);
      sessionRegistry.configure(settings.idleTimeoutMinutes);
      return authJson(settings);
    });
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
