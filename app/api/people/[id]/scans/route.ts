import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError } from '@/lib/api-helpers';
import { saveScanFile } from '@/lib/uploads';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await prisma.person.findUnique({ where: { id } });
  if (!person) return apiError('NOT_FOUND', 'Человек не найден', 404);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return apiError('BAD_REQUEST', 'Ожидается multipart/form-data', 400);
  }

  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) return apiError('BAD_REQUEST', 'Файлы не переданы', 400);

  const created: Array<Awaited<ReturnType<typeof persist>>> = [];
  async function persist(file: File) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const saved = await saveScanFile(id, file.name, buffer);
    return prisma.passportScan.create({
      data: {
        id: saved.id,
        personId: id,
        filename: saved.filename,
        storedPath: saved.storedPath,
        thumbPath: saved.thumbPath,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
      },
    });
  }

  for (const file of files) {
    try {
      created.push(await persist(file));
    } catch (err) {
      return apiError('BAD_REQUEST', err instanceof Error ? err.message : 'Ошибка загрузки', 400);
    }
  }

  return NextResponse.json({ items: created }, { status: 201 });
}
