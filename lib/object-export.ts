import { z } from 'zod';
import { prisma } from './db';
import type { Currency, Person, Event, Excursion, PassportScan, TransportType } from '@prisma/client';

const FORMAT_VERSION = 1;
const PERSON_TYPE = 'dolgoletie/person';
const EVENT_TYPE = 'dolgoletie/event';

// ---- Схемы валидации при импорте ----

const scanMetaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  uploadedAt: z.string(),
});

const personDataSchema = z.object({
  lastName: z.string().min(1),
  firstName: z.string().min(1),
  middleName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable().optional(),
  birthPlace: z.string().nullable().optional(),
  registrationAddress: z.string().nullable().optional(),
  passportNumber: z.string().nullable().optional(),
  passportIssuedBy: z.string().nullable().optional(),
  passportIssuedAt: z.string().nullable().optional(),
  passportExpiresAt: z.string().nullable().optional(),
  passportDepartmentCode: z.string().nullable().optional(),
  passportDetails: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  scans: z.array(scanMetaSchema).optional(),
});

const excursionDataSchema = z.object({
  name: z.string().min(1),
  cost: z.string().nullable().optional(),
});

const eventDataSchema = z.object({
  title: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
  location: z.string().min(1),
  cost: z.string().nullable().optional(),
  currency: z.enum(['RUB', 'USD']),
  program: z.string().nullable().optional(),
  isOutbound: z.boolean(),
  accommodationPlace: z.string().nullable().optional(),
  accommodationOrder: z.string().nullable().optional(),
  mealType: z.string().nullable().optional(),
  staysFrom: z.string().nullable().optional(),
  staysTo: z.string().nullable().optional(),
  accommodationCost: z.string().nullable().optional(),
  transportType: z.enum(['BUS', 'TRAIN', 'PLANE', 'OTHER']).nullable().optional(),
  transportInfo: z.string().nullable().optional(),
  transportCost: z.string().nullable().optional(),
  excursions: z.array(excursionDataSchema).optional(),
});

export const personEnvelopeSchema = z.object({
  type: z.literal(PERSON_TYPE),
  version: z.number(),
  exportedAt: z.string().optional(),
  data: personDataSchema,
});

export const eventEnvelopeSchema = z.object({
  type: z.literal(EVENT_TYPE),
  version: z.number(),
  exportedAt: z.string().optional(),
  data: eventDataSchema,
});

// ---- Экспорт ----

type PersonWithScans = Person & { scans: PassportScan[] };
type EventWithExcursions = Event & { excursions: Excursion[] };

export function buildPersonEnvelope(person: PersonWithScans) {
  return {
    type: PERSON_TYPE,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      lastName: person.lastName,
      firstName: person.firstName,
      middleName: person.middleName,
      phone: person.phone,
      gender: person.gender,
      birthPlace: person.birthPlace,
      registrationAddress: person.registrationAddress,
      passportNumber: person.passportNumber,
      passportIssuedBy: person.passportIssuedBy,
      passportIssuedAt: person.passportIssuedAt?.toISOString() ?? null,
      passportExpiresAt: person.passportExpiresAt?.toISOString() ?? null,
      passportDepartmentCode: person.passportDepartmentCode,
      passportDetails: person.passportDetails,
      notes: person.notes,
      scans: person.scans.map((s) => ({
        id: s.id,
        filename: s.filename,
        mimeType: s.mimeType,
        sizeBytes: s.sizeBytes,
        uploadedAt: s.uploadedAt.toISOString(),
      })),
    },
  };
}

export function buildEventEnvelope(event: EventWithExcursions) {
  return {
    type: EVENT_TYPE,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      title: event.title,
      startDate: event.startDate.toISOString(),
      endDate: event.endDate.toISOString(),
      location: event.location,
      cost: event.cost ? event.cost.toString() : null,
      currency: event.currency as Currency,
      program: event.program,
      isOutbound: event.isOutbound,
      accommodationPlace: event.accommodationPlace,
      accommodationOrder: event.accommodationOrder,
      mealType: event.mealType,
      staysFrom: event.staysFrom?.toISOString() ?? null,
      staysTo: event.staysTo?.toISOString() ?? null,
      accommodationCost: event.accommodationCost ? event.accommodationCost.toString() : null,
      transportType: (event.transportType ?? null) as TransportType | null,
      transportInfo: event.transportInfo,
      transportCost: event.transportCost ? event.transportCost.toString() : null,
      excursions: event.excursions.map((ex) => ({
        name: ex.name,
        cost: ex.cost ? ex.cost.toString() : null,
      })),
    },
  };
}

// ---- Импорт ----

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ImportResult<T> {
  action: 'created' | 'updated';
  record: T;
}

export async function importPerson(
  envelope: z.infer<typeof personEnvelopeSchema>,
): Promise<ImportResult<Person>> {
  const d = envelope.data;

  const existing =
    d.passportNumber && d.passportNumber.trim()
      ? await prisma.person.findFirst({
          where: { passportNumber: d.passportNumber.trim(), deletedAt: null },
        })
      : null;

  const values = {
    lastName: d.lastName,
    firstName: d.firstName,
    middleName: d.middleName ?? null,
    phone: d.phone ?? null,
    gender: d.gender ?? null,
    birthPlace: d.birthPlace ?? null,
    registrationAddress: d.registrationAddress ?? null,
    passportNumber: d.passportNumber ?? null,
    passportIssuedBy: d.passportIssuedBy ?? null,
    passportIssuedAt: toDate(d.passportIssuedAt),
    passportExpiresAt: toDate(d.passportExpiresAt),
    passportDepartmentCode: d.passportDepartmentCode ?? null,
    passportDetails: d.passportDetails ?? null,
    notes: d.notes ?? null,
  };

  if (existing) {
    const record = await prisma.person.update({ where: { id: existing.id }, data: values });
    return { action: 'updated', record };
  }
  const record = await prisma.person.create({ data: values });
  return { action: 'created', record };
}

export async function importEvent(
  envelope: z.infer<typeof eventEnvelopeSchema>,
): Promise<ImportResult<Event>> {
  const d = envelope.data;
  const startDate = toDate(d.startDate);
  const endDate = toDate(d.endDate);
  if (!startDate || !endDate) {
    throw new Error('Некорректные даты мероприятия');
  }

  const existing = await prisma.event.findFirst({
    where: { title: d.title, startDate, deletedAt: null },
  });

  const values = {
    title: d.title,
    startDate,
    endDate,
    location: d.location,
    cost: d.cost ?? null,
    currency: d.currency,
    program: d.program ?? null,
    isOutbound: d.isOutbound,
    accommodationPlace: d.accommodationPlace ?? null,
    accommodationOrder: d.accommodationOrder ?? null,
    mealType: d.mealType ?? null,
    staysFrom: toDate(d.staysFrom),
    staysTo: toDate(d.staysTo),
    accommodationCost: d.accommodationCost ?? null,
    transportType: d.transportType ?? null,
    transportInfo: d.transportInfo ?? null,
    transportCost: d.transportCost ?? null,
  };

  const record = await prisma.$transaction(async (tx) => {
    if (existing) {
      const updated = await tx.event.update({ where: { id: existing.id }, data: values });
      if (d.excursions) {
        await tx.excursion.deleteMany({ where: { eventId: existing.id } });
        if (d.excursions.length > 0) {
          await tx.excursion.createMany({
            data: d.excursions.map((ex) => ({
              eventId: existing.id,
              name: ex.name,
              cost: ex.cost ?? null,
            })),
          });
        }
      }
      return { action: 'updated' as const, record: updated };
    }
    const created = await tx.event.create({
      data: {
        ...values,
        excursions: {
          create: (d.excursions ?? []).map((ex) => ({
            name: ex.name,
            cost: ex.cost ?? null,
          })),
        },
      },
    });
    return { action: 'created' as const, record: created };
  });

  return record;
}
