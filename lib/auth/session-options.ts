import type { SessionOptions } from 'iron-session';

// This module is safe in Edge middleware: no filesystem, vault, or native KDF imports.
export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? '',
  cookieName: 'tdb_session',
  ttl: 60 * 60 * 24 * 30,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: 60 * 60 * 24 * 30 - 60,
  },
};

export function sessionIsConfigured(): boolean {
  return typeof sessionOptions.password === 'string' && sessionOptions.password.length >= 32;
}
