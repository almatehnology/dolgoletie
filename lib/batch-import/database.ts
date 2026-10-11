import type { Person, Prisma } from '@prisma/client';
import { PERSON_FIELDS } from '@/lib/person-fields';
import { prisma } from '@/lib/db';
import { ImportError, LIMITS } from './limits';
import type { PersonSnapshot, Values } from './types';

export type ImportDatabase = Pick<Prisma.TransactionClient, 'person' | 'importReceipt'>;
export function personSnapshot(person: Person): PersonSnapshot {
  const values: Values = {};
  for (const field of PERSON_FIELDS) {
    const value = person[field.key];
    if (value !== null && value !== undefined && value !== '') values[field.key] = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  }
  return { id: person.id, values, updatedAt: person.updatedAt.toISOString(), deletedAt: person.deletedAt?.toISOString() ?? null };
}
export async function readPeople(db: ImportDatabase = prisma): Promise<PersonSnapshot[]> {
  const people = await db.person.findMany({ take: LIMITS.people + 1, orderBy: { id: 'asc' } });
  if (people.length > LIMITS.people) throw new ImportError('PEOPLE_LIMIT', 'База превышает предел 100 000 карточек для этого импортёра.', 413);
  return people.map(personSnapshot);
}
