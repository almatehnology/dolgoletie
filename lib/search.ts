import { prisma } from './db';

/**
 * Построение FTS5-запроса с поддержкой префиксного поиска по каждому токену.
 * "иванов пет" -> "иванов* pet*" (каждое слово с суффиксом *).
 */
export function toFtsQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `${t}*`).join(' ');
}

export async function searchPeople(q: string, limit = 20) {
  const fts = toFtsQuery(q);
  if (!fts) return [];
  const rows = await prisma.$queryRawUnsafe<{ personId: string }[]>(
    `SELECT personId FROM person_fts WHERE person_fts MATCH ? LIMIT ?`,
    fts,
    limit,
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.personId);
  return prisma.person.findMany({
    where: { id: { in: ids }, deletedAt: null },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
}

export async function searchEvents(q: string, limit = 20) {
  const fts = toFtsQuery(q);
  if (!fts) return [];
  const rows = await prisma.$queryRawUnsafe<{ eventId: string }[]>(
    `SELECT eventId FROM event_fts WHERE event_fts MATCH ? LIMIT ?`,
    fts,
    limit,
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.eventId);
  return prisma.event.findMany({
    where: { id: { in: ids }, deletedAt: null },
    orderBy: { startDate: 'desc' },
  });
}
