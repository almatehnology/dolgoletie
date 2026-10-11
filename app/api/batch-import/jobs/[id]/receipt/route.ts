import { z } from 'zod';
import { getReceipt } from '@/lib/batch-import/apply';
import { importOwner, importResponse } from '@/lib/batch-import/http';
import { ImportError } from '@/lib/batch-import/limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const owner = await importOwner(request);
    const version = z.coerce.number().int().positive().parse(new URL(request.url).searchParams.get('version'));
    // This endpoint only reads a durable receipt; it never loads/applies a draft.
    const result = await getReceipt(owner, (await context.params).id, version);
    if (!result) throw new ImportError('RECEIPT_NOT_FOUND', 'Сохранённый результат пока отсутствует. Проверьте план перед новым подтверждением.', 404);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return importResponse(error); }
}
