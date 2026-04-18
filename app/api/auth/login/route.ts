import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/session';

const schema = z.object({ password: z.string().min(1) });

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Некорректный запрос' } }, { status: 400 });
  }

  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { error: { code: 'NOT_CONFIGURED', message: 'APP_PASSWORD не задан в .env' } },
      { status: 500 },
    );
  }

  if (parsed.data.password !== expected) {
    return NextResponse.json({ error: { code: 'BAD_CREDENTIALS', message: 'Неверный пароль' } }, { status: 401 });
  }

  const session = await getSession();
  session.authenticated = true;
  session.loggedInAt = Date.now();
  await session.save();

  return NextResponse.json({ ok: true });
}
