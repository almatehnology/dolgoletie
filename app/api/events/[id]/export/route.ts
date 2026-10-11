import { requireUser } from '@/lib/auth/guards';
import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError } from '@/lib/api-helpers';
import { assertLegacyObjectExportAllowed, buildEventEnvelope } from '@/lib/object-export';
import { withAuthOperation } from '@/lib/auth/mutex';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withAuthOperation(async () => {
      await requireUser();
      assertLegacyObjectExportAllowed();
      const { id } = await params;
      const event = await prisma.event.findUnique({
        where: { id },
        include: { excursions: { orderBy: { name: 'asc' } } },
      });
      if (!event) return apiError('NOT_FOUND', 'Мероприятие не найдено', 404);

      const envelope = buildEventEnvelope(event);
      const body = JSON.stringify(envelope, null, 2);
      const base = event.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 48) || 'event';
      const filename = `${base}-${id.slice(0, 6)}.json`;

      return new NextResponse(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'private, no-store',
        },
      });
    });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
