import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError } from '@/lib/api-helpers';
import { generatePersonPdf } from '@/lib/pdf';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await prisma.person.findUnique({
    where: { id },
    include: {
      participations: {
        include: { event: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!person) return apiError('NOT_FOUND', 'Человек не найден', 404);

  const buffer = await generatePersonPdf({
    lastName: person.lastName,
    firstName: person.firstName,
    middleName: person.middleName,
    phone: person.phone,
    gender: person.gender,
    birthPlace: person.birthPlace,
    registrationAddress: person.registrationAddress,
    passportNumber: person.passportNumber,
    passportIssuedBy: person.passportIssuedBy,
    passportIssuedAt: person.passportIssuedAt,
    passportExpiresAt: person.passportExpiresAt,
    passportDepartmentCode: person.passportDepartmentCode,
    passportDetails: person.passportDetails,
    notes: person.notes,
    createdAt: person.createdAt,
    deletedAt: person.deletedAt,
    participations: person.participations.map((p) => ({
      paymentStatus: p.paymentStatus,
      prepaidAmount: p.prepaidAmount ? p.prepaidAmount.toString() : null,
      totalDue: p.totalDue ? p.totalDue.toString() : null,
      event: {
        title: p.event.title,
        startDate: p.event.startDate,
        endDate: p.event.endDate,
        location: p.event.location,
        currency: p.event.currency,
      },
    })),
  });

  const name = [person.lastName, person.firstName, person.middleName].filter(Boolean).join(' ');
  const filename = `${name || 'person'}.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(buffer.length),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'private, no-store',
    },
  });
}
