import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError } from '@/lib/api-helpers';
import { generateEventPdf } from '@/lib/pdf';

export const runtime = 'nodejs';

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

  const buffer = await generateEventPdf({
    title: event.title,
    startDate: event.startDate,
    endDate: event.endDate,
    location: event.location,
    cost: event.cost ? event.cost.toString() : null,
    currency: event.currency,
    program: event.program,
    isOutbound: event.isOutbound,
    accommodationPlace: event.accommodationPlace,
    accommodationOrder: event.accommodationOrder,
    mealType: event.mealType,
    staysFrom: event.staysFrom,
    staysTo: event.staysTo,
    accommodationCost: event.accommodationCost ? event.accommodationCost.toString() : null,
    transportType: event.transportType,
    transportInfo: event.transportInfo,
    transportCost: event.transportCost ? event.transportCost.toString() : null,
    deletedAt: event.deletedAt,
    excursions: event.excursions.map((e) => ({
      name: e.name,
      cost: e.cost ? e.cost.toString() : null,
    })),
    participations: event.participations.map((p) => ({
      paymentStatus: p.paymentStatus,
      prepaidAmount: p.prepaidAmount ? p.prepaidAmount.toString() : null,
      totalDue: p.totalDue ? p.totalDue.toString() : null,
      person: {
        lastName: p.person.lastName,
        firstName: p.person.firstName,
        middleName: p.person.middleName,
        phone: p.person.phone,
        passportNumber: p.person.passportNumber,
      },
    })),
  });

  const filename = `${event.title || 'event'}.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(buffer.length),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'private, no-store',
    },
  });
}
