import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, handlePrismaError, parseJson, toOptionalDate, toOptionalDecimal } from '@/lib/api-helpers';
import { eventUpdateSchema } from '@/lib/validators';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await prisma.event.findUnique({
    where: { id },
    include: {
      excursions: { orderBy: { name: 'asc' } },
      participations: {
        include: { person: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!event) return apiError('NOT_FOUND', 'Мероприятие не найдено', 404);
  return NextResponse.json(event);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseJson(req, eventUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const d = parsed.data;

  try {
    // Транзакция: обновляем мероприятие и (опционально) полностью заменяем экскурсии.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.event.update({
        where: { id },
        data: {
          ...(d.title !== undefined && { title: d.title }),
          ...(d.startDate !== undefined && { startDate: new Date(d.startDate) }),
          ...(d.endDate !== undefined && { endDate: new Date(d.endDate) }),
          ...(d.location !== undefined && { location: d.location }),
          ...(d.cost !== undefined && { cost: toOptionalDecimal(d.cost) ?? null }),
          ...(d.currency !== undefined && { currency: d.currency }),
          ...(d.program !== undefined && { program: d.program ?? null }),
          ...(d.isOutbound !== undefined && { isOutbound: d.isOutbound }),
          ...(d.accommodationPlace !== undefined && { accommodationPlace: d.accommodationPlace ?? null }),
          ...(d.accommodationOrder !== undefined && { accommodationOrder: d.accommodationOrder ?? null }),
          ...(d.mealType !== undefined && { mealType: d.mealType ?? null }),
          ...(d.staysFrom !== undefined && { staysFrom: toOptionalDate(d.staysFrom) ?? null }),
          ...(d.staysTo !== undefined && { staysTo: toOptionalDate(d.staysTo) ?? null }),
          ...(d.accommodationCost !== undefined && { accommodationCost: toOptionalDecimal(d.accommodationCost) ?? null }),
          ...(d.transportType !== undefined && { transportType: d.transportType ?? null }),
          ...(d.transportInfo !== undefined && { transportInfo: d.transportInfo ?? null }),
          ...(d.transportCost !== undefined && { transportCost: toOptionalDecimal(d.transportCost) ?? null }),
        },
      });

      if (d.excursions !== undefined) {
        await tx.excursion.deleteMany({ where: { eventId: id } });
        if (d.excursions.length > 0) {
          await tx.excursion.createMany({
            data: d.excursions.map((e) => ({
              eventId: id,
              name: e.name,
              cost: toOptionalDecimal(e.cost) ?? null,
            })),
          });
        }
      }

      return tx.event.findUnique({
        where: { id },
        include: { excursions: true },
      });
    });

    return NextResponse.json(updated);
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.event.update({ where: { id }, data: { deletedAt: new Date() } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
