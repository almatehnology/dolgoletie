import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { executeImport } from '@/lib/import';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError('BAD_REQUEST', 'Ожидается multipart/form-data', 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return apiError('BAD_REQUEST', 'Файл не передан', 400);

  const mode = (form.get('mode') ?? 'merge') === 'replace' ? 'replace' : 'merge';
  const dryRun = form.get('dryRun') === 'true';
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await executeImport({ zipBuffer: buffer, mode, dryRun });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[import]', err);
    return apiError('IMPORT_FAILED', err instanceof Error ? err.message : 'Не удалось импортировать', 500);
  }
}
