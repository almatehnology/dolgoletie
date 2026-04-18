import { NextResponse, type NextRequest } from 'next/server';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, parseJson } from '@/lib/api-helpers';
import { UPLOADS_DIR } from '@/lib/uploads';

export const runtime = 'nodejs';

const schema = z.object({
  confirm: z.literal('ОЧИСТИТЬ', {
    errorMap: () => ({ message: 'Введите слово ОЧИСТИТЬ для подтверждения' }),
  }),
});

export async function POST(req: NextRequest) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.participation.deleteMany();
      await tx.passportScan.deleteMany();
      await tx.excursion.deleteMany();
      await tx.event.deleteMany();
      await tx.person.deleteMany();
    });

    // Чистим папку с загруженными сканами. FTS5-таблицы чистятся триггерами автоматически.
    try {
      const entries = await readdir(UPLOADS_DIR);
      await Promise.all(
        entries.map((name) => rm(join(UPLOADS_DIR, name), { recursive: true, force: true })),
      );
    } catch (err) {
      console.warn('[reset] не удалось очистить папку uploads:', err);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[reset]', err);
    return apiError('RESET_FAILED', err instanceof Error ? err.message : 'Не удалось очистить базу', 500);
  }
}
