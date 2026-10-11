import { prisma } from '@/lib/db';
import { PERSON_FIELDS } from '@/lib/person-fields';
import { MAX_REPORT_PEOPLE, type EventRecord, type PersonRecord } from './model';
import type { ReportRepository } from './service';

const personSelect = {
  id: true,
  deletedAt: true,
  ...Object.fromEntries(PERSON_FIELDS.map((field) => [field.key, true])),
};

export const reportRepository: ReportRepository = {
  async findPeople(ids) {
    // Explicit IDs span all UI pages. Small batches stay within SQLite's
    // parameter limit; no transaction remains open during file generation.
    const people: PersonRecord[] = [];
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = await prisma.person.findMany({
        where: { id: { in: ids.slice(offset, offset + 400) }, deletedAt: null },
        select: personSelect,
      });
      people.push(...batch as PersonRecord[]);
    }
    return people;
  },
  async findEvent(id) {
    const event = await prisma.event.findUnique({
      where: { id },
      select: {
        title: true, startDate: true, endDate: true, location: true, cost: true, currency: true,
        program: true, isOutbound: true, accommodationPlace: true, accommodationOrder: true,
        mealType: true, staysFrom: true, staysTo: true, accommodationCost: true,
        transportType: true, transportInfo: true, transportCost: true,
        excursions: { select: { name: true, cost: true }, orderBy: { name: 'asc' } },
        participations: {
          select: { person: { select: personSelect } },
          orderBy: [{ person: { lastName: 'asc' } }, { person: { firstName: 'asc' } }, { personId: 'asc' }],
          // Read one beyond the supported limit to reject, never truncate.
          take: MAX_REPORT_PEOPLE + 1,
        },
      },
    });
    if (!event) return null;
    const { participations, ...summary } = event;
    return { ...summary, people: participations.map((item) => item.person as PersonRecord) } satisfies EventRecord;
  },
};
