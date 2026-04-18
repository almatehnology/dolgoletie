import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { handlePrismaError, parseJson, toOptionalDecimal } from '@/lib/api-helpers';
import { participationUpdateSchema } from '@/lib/validators';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseJson(req, participationUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const d = parsed.data;
  try {
    const updated = await prisma.participation.update({
      where: { id },
      data: {
        ...(d.paymentStatus !== undefined && { paymentStatus: d.paymentStatus }),
        ...(d.prepaidAmount !== undefined && { prepaidAmount: toOptionalDecimal(d.prepaidAmount) ?? null }),
        ...(d.totalDue !== undefined && { totalDue: toOptionalDecimal(d.totalDue) ?? null }),
        ...(d.notes !== undefined && { notes: d.notes ?? null }),
      },
    });
    return NextResponse.json(updated);
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.participation.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
