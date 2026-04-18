import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { handlePrismaError, parseJson, toOptionalDecimal } from '@/lib/api-helpers';
import { participationCreateSchema } from '@/lib/validators';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params;
  const parsed = await parseJson(req, participationCreateSchema);
  if (!parsed.ok) return parsed.response;
  const d = parsed.data;
  try {
    const created = await prisma.participation.create({
      data: {
        eventId,
        personId: d.personId,
        paymentStatus: d.paymentStatus,
        prepaidAmount: toOptionalDecimal(d.prepaidAmount) ?? null,
        totalDue: toOptionalDecimal(d.totalDue) ?? null,
        notes: d.notes ?? null,
      },
      include: { person: true, event: true },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
