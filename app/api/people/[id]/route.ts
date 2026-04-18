import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, handlePrismaError, parseJson, toOptionalDate } from '@/lib/api-helpers';
import { personUpdateSchema } from '@/lib/validators';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await prisma.person.findUnique({
    where: { id },
    include: {
      scans: { orderBy: { uploadedAt: 'desc' } },
      participations: {
        include: { event: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!person) return apiError('NOT_FOUND', 'Человек не найден', 404);
  return NextResponse.json(person);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseJson(req, personUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const d = parsed.data;
  try {
    const updated = await prisma.person.update({
      where: { id },
      data: {
        ...(d.lastName !== undefined && { lastName: d.lastName }),
        ...(d.firstName !== undefined && { firstName: d.firstName }),
        ...(d.middleName !== undefined && { middleName: d.middleName ?? null }),
        ...(d.phone !== undefined && { phone: d.phone ?? null }),
        ...(d.gender !== undefined && { gender: d.gender ?? null }),
        ...(d.birthPlace !== undefined && { birthPlace: d.birthPlace ?? null }),
        ...(d.registrationAddress !== undefined && { registrationAddress: d.registrationAddress ?? null }),
        ...(d.passportNumber !== undefined && { passportNumber: d.passportNumber ?? null }),
        ...(d.passportIssuedBy !== undefined && { passportIssuedBy: d.passportIssuedBy ?? null }),
        ...(d.passportIssuedAt !== undefined && {
          passportIssuedAt: toOptionalDate(d.passportIssuedAt) ?? null,
        }),
        ...(d.passportExpiresAt !== undefined && {
          passportExpiresAt: toOptionalDate(d.passportExpiresAt) ?? null,
        }),
        ...(d.passportDepartmentCode !== undefined && {
          passportDepartmentCode: d.passportDepartmentCode ?? null,
        }),
        ...(d.passportDetails !== undefined && { passportDetails: d.passportDetails ?? null }),
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
    await prisma.person.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
