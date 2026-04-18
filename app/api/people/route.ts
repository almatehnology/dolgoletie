import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { handlePrismaError, parseJson, toOptionalDate } from '@/lib/api-helpers';
import { personCreateSchema } from '@/lib/validators';

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const q = url.searchParams.get('q')?.trim() ?? '';
  const archived = url.searchParams.get('archived') === 'true';
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') ?? '50')));

  const where = {
    deletedAt: archived ? { not: null } : null,
    ...(q
      ? {
          OR: [
            { lastName: { contains: q } },
            { firstName: { contains: q } },
            { middleName: { contains: q } },
            { phone: { contains: q } },
            { passportNumber: { contains: q } },
          ],
        }
      : {}),
  } as const;

  const [items, total] = await Promise.all([
    prisma.person.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: { select: { scans: true, participations: true } },
      },
    }),
    prisma.person.count({ where }),
  ]);

  return NextResponse.json({ items, total, page, pageSize });
}

export async function POST(req: NextRequest) {
  const parsed = await parseJson(req, personCreateSchema);
  if (!parsed.ok) return parsed.response;
  const d = parsed.data;

  try {
    const created = await prisma.person.create({
      data: {
        lastName: d.lastName,
        firstName: d.firstName,
        middleName: d.middleName ?? null,
        phone: d.phone ?? null,
        gender: d.gender ?? null,
        birthPlace: d.birthPlace ?? null,
        registrationAddress: d.registrationAddress ?? null,
        passportNumber: d.passportNumber ?? null,
        passportIssuedBy: d.passportIssuedBy ?? null,
        passportIssuedAt: toOptionalDate(d.passportIssuedAt) ?? null,
        passportExpiresAt: toOptionalDate(d.passportExpiresAt) ?? null,
        passportDepartmentCode: d.passportDepartmentCode ?? null,
        passportDetails: d.passportDetails ?? null,
        notes: d.notes ?? null,
      },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}

export const dynamic = 'force-dynamic';
