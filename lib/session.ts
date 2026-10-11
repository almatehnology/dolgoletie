import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { sessionIsConfigured, sessionOptions } from './auth/session-options';
import { authError } from './auth/errors';
import type { SessionData } from './auth/types';

export { sessionOptions } from './auth/session-options';
export type { SessionData } from './auth/types';

export async function getSession() {
  if (!sessionIsConfigured()) throw authError('SESSION_NOT_CONFIGURED', 'Для входа требуется локальный SESSION_SECRET длиной не менее 32 символов', 503);
  const store = await cookies();
  return getIronSession<SessionData>(store, sessionOptions);
}
