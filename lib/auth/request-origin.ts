/** NextURL normalizes loopback IPs to localhost. Browser Origin uses the actual Host. */
export function requestOrigin(request: Request): string | null {
  try {
    const url = new URL(request.url);
    const host = request.headers.get('host');
    if (host) {
      const actual = new URL(`${url.protocol}//${host}`);
      if (actual.host !== host || actual.username || actual.password || actual.pathname !== '/') return null;
      url.host = actual.host;
    }
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}
export function isSameOriginRequest(request: Request): boolean {
  const expected = requestOrigin(request), origin = request.headers.get('origin');
  if (!expected || request.headers.get('sec-fetch-site') === 'cross-site') return false;
  if (!origin) return true;
  try { return new URL(origin).origin === expected && new URL(origin).pathname === '/'; } catch { return false; }
}
