import { LRUCache } from 'lru-cache';

type Entry = { count: number; resetAt: number };

const cache = new LRUCache<string, Entry>({ max: 500 });

export function rateLimit(key: string, limit = 5, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const entry = cache.get(key);

  if (!entry || entry.resetAt < now) {
    cache.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  cache.set(key, entry);
  return { allowed: true, remaining: limit - entry.count, resetAt: entry.resetAt };
}
