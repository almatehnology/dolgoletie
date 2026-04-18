import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError } from '@/lib/api-helpers';
import { readScanFile } from '@/lib/uploads';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scan = await prisma.passportScan.findUnique({ where: { id } });
  if (!scan) return apiError('NOT_FOUND', 'Скан не найден', 404);
  const path = scan.thumbPath ?? null;
  if (!path) {
    // Для PDF возвращаем 204 — клиент покажет иконку PDF.
    return new NextResponse(null, { status: 204 });
  }
  let buf: Buffer;
  try {
    buf = await readScanFile(path);
  } catch {
    return apiError('NOT_FOUND', 'Превью отсутствует', 404);
  }
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(buf.length),
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
