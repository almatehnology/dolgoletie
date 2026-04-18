import { getIronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';

export type SessionData = {
  authenticated?: boolean;
  loggedInAt?: number;
};

const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) {
  // eslint-disable-next-line no-console
  console.warn('[session] SESSION_SECRET отсутствует или слишком короткий (нужно >= 32 символа)');
}

export const sessionOptions: SessionOptions = {
  password: secret ?? 'insecure-development-secret-please-change-me-xxxxxxxxx',
  cookieName: 'tdb_session',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  },
};

export async function getSession() {
  const store = await cookies();
  return getIronSession<SessionData>(store, sessionOptions);
}
