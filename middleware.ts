import { NextResponse, type NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
import { sessionIsConfigured, sessionOptions } from '@/lib/auth/session-options';
import type { SessionData } from '@/lib/auth/types';
import { isSameOriginRequest, requestOrigin } from '@/lib/auth/request-origin';

const PUBLIC_PATHS = ['/login', '/setup', '/api/setup', '/api/auth/login', '/api/auth/logout', '/api/auth/status'];
const within = (pathname: string, path: string) => pathname === path || pathname.startsWith(`${path}/`);

// Preliminary cookie/role check only. Node guards verify current metadata and vault state.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const origin = requestOrigin(req);
  if (!origin) return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Используйте локальный адрес приложения' } }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  if (within(pathname, '/api') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!isSameOriginRequest(req)) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Запрос с другого сайта запрещён' } }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
  }
  if (pathname.startsWith('/_next/') || pathname === '/favicon.ico' || PUBLIC_PATHS.some((path) => within(pathname, path))) {
    return NextResponse.next();
  }

  const res = NextResponse.next();
  const session: SessionData = sessionIsConfigured() ? await getIronSession<SessionData>(req, res, sessionOptions) : {};
  const authenticated = session.authenticated === true && Boolean(session.userId) &&
    (session.role === 'admin' || session.role === 'user') && session.authVersion !== undefined;
  const adminRoute = within(pathname, '/admin') || within(pathname, '/api/admin');
  if (authenticated && session.role === (adminRoute ? 'admin' : 'user')) return res;
  if (within(pathname, '/api')) {
    return NextResponse.json({ error: { code: authenticated ? 'FORBIDDEN' : 'UNAUTHORIZED', message: authenticated ? 'Недостаточно прав' : 'Требуется вход' } }, { status: authenticated ? 403 : 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const url = req.nextUrl.clone();
  url.host = new URL(origin).host;
  url.protocol = new URL(origin).protocol;
  url.search = '';
  if (authenticated && session.role === 'admin') url.pathname = '/admin';
  else {
    url.pathname = '/login';
    if (adminRoute) {
      url.searchParams.set('role', 'admin');
      const token = req.nextUrl.searchParams.get('syncToken');
      if (token && /^[a-f0-9-]{36}$/.test(token)) url.searchParams.set('syncToken', token);
    }
    else url.searchParams.set('next', pathname);
  }
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
