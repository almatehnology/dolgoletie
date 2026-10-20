import { requireUser } from '@/lib/auth/guards';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { executeImport } from '@/lib/import';
import { withAuthOperation } from '@/lib/auth/mutex';
import { readUploadForm } from '@/lib/http-upload';
import { assertSameOrigin } from '@/lib/auth/errors';
import { ARCHIVE_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } from '@/lib/transfer-limits';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try { assertSameOrigin(req); await requireUser(); } catch (error) { if (error instanceof Response) return error; throw error; }
  let form: FormData;
  try {
    form = await readUploadForm(req, UPLOAD_REQUEST_MAX_BYTES);
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError('UPLOAD_FAILED', 'Не удалось получить файл. Повторите загрузку.', 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return apiError('BAD_REQUEST', 'Файл не передан', 400);
  if (file.size > ARCHIVE_MAX_BYTES) return apiError('IMPORT_LIMIT', 'Размер файла не должен превышать 1 ГиБ.', 413);

  const mode = (form.get('mode') ?? 'merge') === 'replace' ? 'replace' : 'merge';
  const dryRun = form.get('dryRun') === 'true';
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    if (buffer.length > ARCHIVE_MAX_BYTES) return apiError('IMPORT_LIMIT', 'Размер файла не должен превышать 1 ГиБ.', 413);
    const password = typeof form.get('password') === 'string' ? String(form.get('password')) : undefined;
    return await withAuthOperation(async () => {
      await requireUser();
      const result = await executeImport({ zipBuffer: buffer, mode, dryRun, password });
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    });
  } catch (err) {
    if (err instanceof Response) return err;
    return apiError('IMPORT_FAILED', 'Не удалось открыть резервную копию. Проверьте файл и его пароль.', 400);
  }
}
