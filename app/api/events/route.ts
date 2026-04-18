import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { handlePrismaError, parseJson, toOptionalDate, toOptionalDecimal } from '@/lib/api-helpers';
import { eventCreateSchema } from '@/lib/validators';

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const q = url.searchParams.get('q')?.trim() ?? '';
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const archived = url.searchParams.get('archived') === 'true';
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') ?? '50')));

  const andClauses: Array<Record<string, unknown>> = [];
  if (q) {
    andClauses.push({
      OR: [{ title: { contains: q } }, { location: { contains: q } }, { program: { contains: q } }],
    });
  }
  if (from) andClauses.push({ endDate: { gte: new Date(from) } });
  if (to) andClauses.push({ startDate: { lte: new Date(`${to}T23:59:59`) } });

  const where = {
    deletedAt: archived ? { not: null } : null,
    ...(andClauses.length ? { AND: andClauses } : {}),
  } as const;

  const [items, total] = await Promise.all([
    prisma.event.findMany({
      where,
      orderBy: { startDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { participations: true, excursions: true } } },
    }),
    prisma.event.count({ where }),
  ]);

  return NextResponse.json({ items, total, page, pageSize });
}

export async function POST(req: NextRequest) {
  const parsed = await parseJson(req, eventCreateSchema);
  if (!parsed.ok) return parsed.response;
  const d = parsed.data;
  try {
    const created = await prisma.event.create({
      data: {
        title: d.title,
        startDate: new Date(d.startDate),
        endDate: new Date(d.endDate),
        location: d.location,
        cost: toOptionalDecimal(d.cost) ?? null,
        currency: d.currency,
        program: d.program ?? null,
        isOutbound: d.isOutbound,
        accommodationPlace: d.accommodationPlace ?? null,
        accommodationOrder: d.accommodationOrder ?? null,
        mealType: d.mealType ?? null,
        staysFrom: toOptionalDate(d.staysFrom) ?? null,
        staysTo: toOptionalDate(d.staysTo) ?? null,
        accommodationCost: toOptionalDecimal(d.accommodationCost) ?? null,
        transportType: d.transportType ?? null,
        transportInfo: d.transportInfo ?? null,
        transportCost: toOptionalDecimal(d.transportCost) ?? null,
        excursions: {
          create: d.excursions.map((e) => ({
            name: e.name,
            cost: toOptionalDecimal(e.cost) ?? null,
          })),
        },
      },
      include: { excursions: true },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}

export const dynamic = 'force-dynamic';
