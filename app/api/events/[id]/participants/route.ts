import { requireUser } from '@/lib/auth/guards';
import { withAuthOperation } from '@/lib/auth/mutex';
import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, handlePrismaError, parseJson, toOptionalDecimal } from '@/lib/api-helpers';
import { participationCreateSchema } from '@/lib/validators';
import { z } from 'zod';

const personIdSchema = z.string().trim().min(1).max(128);
const personIdsSchema = z.array(personIdSchema).min(1).max(200).superRefine((ids, ctx) => {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [index], message: 'Человек повторяется в списке' });
    seen.add(id);
  });
});

// Disallow ambiguous requests containing both formats; preserve the single response shape.
const createSchema = z.union([
  participationCreateSchema.extend({ personId: personIdSchema, personIds: z.never().optional() }),
  participationCreateSchema.omit({ personId: true }).extend({
    personIds: personIdsSchema,
    personId: z.never().optional(),
  }),
]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireUser(); } catch (error) { if (error instanceof Response) return error; throw error; }
  const { id: eventId } = await params;
  const parsed = await parseJson(req, createSchema);
  if (!parsed.ok) return parsed.response;
  const d = parsed.data;
  try {
    return await withAuthOperation(async () => {
      // Access may expire while waiting for an encryption/session transition.
      await requireUser();
      const items = await prisma.$transaction(async (tx) => {
        const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true, deletedAt: true } });
        if (!event) throw apiError('NOT_FOUND', 'Мероприятие не найдено', 404);
        if (event.deletedAt) throw apiError('CONFLICT', 'Нельзя добавлять участников в архивное мероприятие', 409);

        const personIds = d.personIds ?? [d.personId!];
        if (d.personIds !== undefined) {
          const people = await tx.person.findMany({
            where: { id: { in: personIds }, deletedAt: null }, select: { id: true },
          });
          const found = new Set(people.map((person) => person.id));
          const missingIndex = personIds.findIndex((id) => !found.has(id));
          if (missingIndex !== -1) {
            const message = 'Человек не найден или находится в архиве. Никто не добавлен.';
            throw apiError('VALIDATION', message, 400, { [`personIds.${missingIndex}`]: [message] });
          }
          const existing = await tx.participation.findFirst({ where: { eventId, personId: { in: personIds } } });
          if (existing) throw apiError('CONFLICT', 'Кто-то из выбранных людей уже участвует в мероприятии. Никто не добавлен. Обновите список участников.', 409);
        }

        const created = [];
        for (const personId of personIds) {
          created.push(await tx.participation.create({
            data: {
              eventId,
              personId,
              paymentStatus: d.paymentStatus,
              prepaidAmount: toOptionalDecimal(d.prepaidAmount) ?? null,
              totalDue: toOptionalDecimal(d.totalDue) ?? null,
              notes: d.notes ?? null,
            },
            include: { person: true, event: true },
          }));
        }
        return created;
      });
      return NextResponse.json(d.personIds !== undefined ? { items, count: items.length } : items[0], { status: 201 });
    });
  } catch (err) {
    if (err instanceof Response) return err;
    return handlePrismaError(err);
  }
}
