import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/guards';
import { assertSameOrigin } from '@/lib/auth/errors';
import { PERSON_FIELDS } from '@/lib/person-fields';
import { ImportError, LIMITS } from './limits';
import { IMPORT_COLUMNS } from './headers';

export async function importOwner(request: Request): Promise<string> {
  if (request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request);
  const account = await requireUser();
  // The cookie binds drafts and receipts to a particular login; do not retain the cookie itself.
  const sessionCookie = (request.headers.get('cookie') ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith('tdb_session='));
  if (!sessionCookie) throw new ImportError('UNAUTHORIZED', 'Войдите под основной учётной записью.', 401);
  return createHash('sha256').update(account.id).update('\0').update(sessionCookie).digest('hex');
}
export function importResponse(error: unknown): Response {
  if (error instanceof Response) return error;
  if (error instanceof ImportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: { code: 'VALIDATION', message: 'Проверьте параметры запроса.' } }, { status: 400 });
  // Do not log documents, row values or Prisma diagnostics containing passport numbers.
  return Response.json({ error: { code: 'IMPORT_FAILED', message: 'Не удалось обработать импорт. Изменения не применены; повторите запрос.' } }, { status: 500 });
}
const fieldKeys = PERSON_FIELDS.map((f) => f.key) as [typeof PERSON_FIELDS[number]['key'], ...typeof PERSON_FIELDS[number]['key'][]];
const columnKeys = IMPORT_COLUMNS.map((f) => f.key) as [typeof IMPORT_COLUMNS[number]['key'], ...typeof IMPORT_COLUMNS[number]['key'][]];
const fields = z.record(z.enum(fieldKeys), z.string().max(LIMITS.cellChars));
export const revisionSchema = z.number().int().positive();
export const planRequestSchema = z.object({
  revision: revisionSchema,
  tables: z.array(z.object({ tableId: z.string().max(200), included: z.boolean(), headerStart: z.number().int().min(1).max(LIMITS.rows), headerEnd: z.number().int().min(1).max(LIMITS.rows), columns: z.array(z.enum(columnKeys).nullable()).max(LIMITS.columns) }).strict()).max(LIMITS.tables).optional(),
  rowEdits: z.array(z.object({ rowId: z.string().max(250), excluded: z.boolean().optional(), values: fields.optional(), acknowledgeWarnings: z.boolean().optional(), separate: z.boolean().optional(), mergeWith: z.string().max(250).nullable().optional() }).strict()).max(LIMITS.rows).optional(),
  decisions: z.array(z.object({ groupId: z.string().max(64), action: z.enum(['auto', 'new', 'existing', 'skip']), personId: z.string().max(100).optional(), restore: z.boolean().optional(), fields: z.record(z.enum(fieldKeys), z.string().max(LIMITS.cellChars).nullable()).optional() }).strict()).max(LIMITS.rows).optional(),
}).strict();
export const applyRequestSchema = z.object({ version: revisionSchema, confirm: z.literal(true) }).strict();

export async function boundedBody(request: Request, limit: number): Promise<Buffer> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > limit) throw new ImportError('REQUEST_LIMIT', 'Размер запроса превышает предел.', 413);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new ImportError('REQUEST_LIMIT', 'Размер запроса превышает предел.', 413);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function requestJson(request: Request): Promise<unknown> {
  return JSON.parse((await boundedBody(request, 8 * 1024 * 1024)).toString('utf8'));
}
