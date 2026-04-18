import { NextResponse, type NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getSession } from '@/lib/session';
import { rateLimit } from '@/lib/rate-limit';

const schema = z.object({ password: z.string().min(1) });

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') ?? 'local';
  const limit = rateLimit(`login:${ip}`, 5, 10 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'Слишком много попыток. Попробуйте позже.' } },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Некорректный запрос' } }, { status: 400 });
  }

  const hash = process.env.APP_PASSWORD_HASH;
  if (!hash) {
    return NextResponse.json(
      { error: { code: 'NOT_CONFIGURED', message: 'Пароль не настроен. Выполните npm run set-password' } },
      { status: 500 },
    );
  }

  const ok = await bcrypt.compare(parsed.data.password, hash);
  if (!ok) {
    return NextResponse.json({ error: { code: 'BAD_CREDENTIALS', message: 'Неверный пароль' } }, { status: 401 });
  }

  const session = await getSession();
  session.authenticated = true;
  session.loggedInAt = Date.now();
  await session.save();

  return NextResponse.json({ ok: true });
}
