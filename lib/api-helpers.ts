import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export type ApiError = {
  error: { code: string; message: string; fields?: Record<string, string[]> };
};

export function apiError(code: string, message: string, status = 400, fields?: Record<string, string[]>) {
  return NextResponse.json({ error: { code, message, fields } } satisfies ApiError, { status });
}

export async function parseJson<T extends ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, response: apiError('BAD_REQUEST', 'Некорректный JSON', 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of (parsed.error as ZodError).issues) {
      const key = issue.path.join('.') || '_';
      (fields[key] ??= []).push(issue.message);
    }
    return {
      ok: false,
      response: apiError('VALIDATION', 'Проверьте заполнение полей', 400, fields),
    };
  }
  return { ok: true, data: parsed.data };
}

export function handlePrismaError(err: unknown): NextResponse {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return apiError('CONFLICT', 'Запись с такими данными уже существует', 409);
    }
    if (err.code === 'P2025') {
      return apiError('NOT_FOUND', 'Запись не найдена', 404);
    }
  }
  // eslint-disable-next-line no-console
  console.error('[api] unexpected error', err);
  return apiError('INTERNAL', 'Внутренняя ошибка', 500);
}

export function toOptionalDate(v: string | undefined | null): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return new Date(v);
}

export function toOptionalDecimal(v: string | number | undefined | null): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return typeof v === 'number' ? v.toString() : v;
}
