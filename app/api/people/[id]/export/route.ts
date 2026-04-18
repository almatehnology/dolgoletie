import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError } from '@/lib/api-helpers';
import { buildPersonEnvelope } from '@/lib/object-export';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await prisma.person.findUnique({
    where: { id },
    include: { scans: { orderBy: { uploadedAt: 'desc' } } },
  });
  if (!person) return apiError('NOT_FOUND', 'Человек не найден', 404);

  const envelope = buildPersonEnvelope(person);
  const body = JSON.stringify(envelope, null, 2);
  const base = [person.lastName, person.firstName].filter(Boolean).join('-') || 'person';
  const filename = `${base}-${id.slice(0, 6)}.json`;

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'private, no-store',
    },
  });
}
