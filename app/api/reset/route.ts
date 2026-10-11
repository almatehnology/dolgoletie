import { requireUser } from '@/lib/auth/guards';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, parseJson } from '@/lib/api-helpers';
import { withAuthOperation } from '@/lib/auth/mutex';

export const runtime = 'nodejs';

const schema = z.object({
  confirm: z.literal('ОЧИСТИТЬ', {
    errorMap: () => ({ message: 'Введите слово ОЧИСТИТЬ для подтверждения' }),
  }),
});

export async function POST(req: NextRequest) {
  try {
    return await withAuthOperation(async () => {
      await requireUser();
      const parsed = await parseJson(req, schema);
      if (!parsed.ok) return parsed.response;
      await prisma.$transaction(async (tx) => {
        await tx.participation.deleteMany();
        await tx.passportScan.deleteMany();
        await tx.excursion.deleteMany();
        await tx.event.deleteMany();
        await tx.person.deleteMany();
      });

      // Prisma journals these deletions. Immutable files and retention receipts
      // remain available to offline peers through sync history.

      return NextResponse.json({ ok: true });
    });
  } catch (err) {
    if (err instanceof Response) return err;
    return apiError('RESET_FAILED', 'Не удалось очистить базу', 500);
  }
}
