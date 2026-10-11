import { isSameOriginRequest } from './request-origin';

export function authError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function authJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function authFailure(error: unknown): Response {
  if (error instanceof Response) return error;
  // Never log requests, passwords, hashes, recovery keys, or underlying vault errors.
  return authError('AUTH_UNAVAILABLE', 'Не удалось выполнить операцию с учётной записью', 503);
}

export function assertSameOrigin(request: Request): void {
  if (!isSameOriginRequest(request)) {
    throw authError('FORBIDDEN', 'Запрос с другого сайта запрещён', 403);
  }
}
