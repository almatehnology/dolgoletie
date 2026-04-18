import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError } from '@/lib/api-helpers';
import { deleteScanFile, readScanFile } from '@/lib/uploads';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scan = await prisma.passportScan.findUnique({ where: { id } });
  if (!scan) return apiError('NOT_FOUND', 'Скан не найден', 404);
  let buf: Buffer;
  try {
    buf = await readScanFile(scan.storedPath);
  } catch {
    return apiError('NOT_FOUND', 'Файл отсутствует на диске', 404);
  }
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': scan.mimeType,
      'Content-Length': String(buf.length),
      'Cache-Control': 'private, max-age=60',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(scan.filename)}`,
    },
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scan = await prisma.passportScan.findUnique({ where: { id } });
  if (!scan) return apiError('NOT_FOUND', 'Скан не найден', 404);
  await deleteScanFile(scan.storedPath, scan.thumbPath);
  await prisma.passportScan.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
