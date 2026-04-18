import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import unzipper from 'unzipper';
import { prisma } from './db';
import { UPLOADS_DIR } from './uploads';

export type ImportMode = 'merge' | 'replace';

export interface ImportPlan {
  people: { toCreate: number; toUpdate: number };
  events: { toCreate: number; toUpdate: number };
  participations: { toCreate: number; toUpdate: number };
  scans: { toCopy: number };
  manifest: { version: number; exportedAt: string; scope: string } | null;
}

interface ImportInput {
  zipBuffer: Buffer;
  mode: ImportMode;
  dryRun: boolean;
}

interface RawScan {
  id: string;
  personId: string;
  filename: string;
  storedPath: string;
  thumbPath: string | null;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

interface RawPerson {
  id: string;
  lastName: string;
  firstName: string;
  middleName: string | null;
  phone: string | null;
  gender: string | null;
  birthPlace: string | null;
  registrationAddress: string | null;
  passportNumber: string | null;
  passportIssuedBy: string | null;
  passportIssuedAt: string | null;
  passportExpiresAt: string | null;
  passportDepartmentCode: string | null;
  passportDetails: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  scans?: RawScan[];
}

interface RawExcursion {
  id: string;
  eventId: string;
  name: string;
  cost: string | null;
}

interface RawEvent {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  location: string;
  cost: string | null;
  currency: 'RUB' | 'USD';
  program: string | null;
  isOutbound: boolean;
  accommodationPlace: string | null;
  accommodationOrder: string | null;
  mealType: string | null;
  staysFrom: string | null;
  staysTo: string | null;
  accommodationCost: string | null;
  transportType: 'BUS' | 'TRAIN' | 'PLANE' | 'OTHER' | null;
  transportInfo: string | null;
  transportCost: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  excursions?: RawExcursion[];
}

interface RawParticipation {
  id: string;
  personId: string;
  eventId: string;
  paymentStatus: 'UNPAID' | 'PREPAID' | 'PAID';
  prepaidAmount: string | null;
  totalDue: string | null;
  notes: string | null;
  createdAt: string;
}

interface ImportBundle {
  manifest: { version: number; exportedAt: string; scope: string } | null;
  people: RawPerson[];
  events: RawEvent[];
  participations: RawParticipation[];
  uploadFiles: Map<string, Buffer>;
}

async function readBundle(zipBuffer: Buffer): Promise<ImportBundle> {
  const directory = await unzipper.Open.buffer(zipBuffer);
  const bundle: ImportBundle = {
    manifest: null,
    people: [],
    events: [],
    participations: [],
    uploadFiles: new Map(),
  };
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    const path = entry.path;
    if (path === 'manifest.json') {
      bundle.manifest = JSON.parse((await entry.buffer()).toString('utf8'));
    } else if (path === 'people.json') {
      bundle.people = JSON.parse((await entry.buffer()).toString('utf8'));
    } else if (path === 'events.json') {
      bundle.events = JSON.parse((await entry.buffer()).toString('utf8'));
    } else if (path === 'participations.json') {
      bundle.participations = JSON.parse((await entry.buffer()).toString('utf8'));
    } else if (path.startsWith('uploads/')) {
      bundle.uploadFiles.set(path.replace(/^uploads\//, ''), await entry.buffer());
    }
  }
  return bundle;
}

export async function planImport({ zipBuffer }: { zipBuffer: Buffer }): Promise<ImportPlan> {
  const bundle = await readBundle(zipBuffer);

  const [existingPeople, existingEvents] = await Promise.all([
    prisma.person.findMany({ select: { id: true, passportNumber: true } }),
    prisma.event.findMany({ select: { id: true, title: true, startDate: true } }),
  ]);

  const peopleByPassport = new Map(existingPeople.filter((p) => p.passportNumber).map((p) => [p.passportNumber!, p.id]));
  const peopleById = new Set(existingPeople.map((p) => p.id));
  const eventsByKey = new Map(existingEvents.map((e) => [`${e.title}|${e.startDate.toISOString()}`, e.id]));
  const eventsById = new Set(existingEvents.map((e) => e.id));

  const plan: ImportPlan = {
    people: { toCreate: 0, toUpdate: 0 },
    events: { toCreate: 0, toUpdate: 0 },
    participations: { toCreate: 0, toUpdate: 0 },
    scans: { toCopy: 0 },
    manifest: bundle.manifest,
  };

  for (const p of bundle.people) {
    const matched = (p.passportNumber && peopleByPassport.get(p.passportNumber)) || (peopleById.has(p.id) ? p.id : null);
    if (matched) plan.people.toUpdate++;
    else plan.people.toCreate++;
    if (p.scans) plan.scans.toCopy += p.scans.length;
  }

  for (const e of bundle.events) {
    const key = `${e.title}|${new Date(e.startDate).toISOString()}`;
    const matched = eventsByKey.get(key) || (eventsById.has(e.id) ? e.id : null);
    if (matched) plan.events.toUpdate++;
    else plan.events.toCreate++;
  }

  for (const p of bundle.participations) {
    plan.participations.toCreate++;
  }

  return plan;
}

export async function executeImport({ zipBuffer, mode, dryRun }: ImportInput) {
  const bundle = await readBundle(zipBuffer);
  if (dryRun) {
    return planImport({ zipBuffer });
  }

  const idMap = {
    people: new Map<string, string>(),
    events: new Map<string, string>(),
  };

  await prisma.$transaction(
    async (tx) => {
      if (mode === 'replace') {
        await tx.participation.deleteMany();
        await tx.passportScan.deleteMany();
        await tx.excursion.deleteMany();
        await tx.event.deleteMany();
        await tx.person.deleteMany();
      }

      for (const raw of bundle.people) {
        const existing = raw.passportNumber
          ? await tx.person.findFirst({ where: { passportNumber: raw.passportNumber } })
          : await tx.person.findUnique({ where: { id: raw.id } });
        const data = {
          lastName: raw.lastName,
          firstName: raw.firstName,
          middleName: raw.middleName,
          phone: raw.phone,
          gender: raw.gender ?? null,
          birthPlace: raw.birthPlace ?? null,
          registrationAddress: raw.registrationAddress ?? null,
          passportNumber: raw.passportNumber,
          passportIssuedBy: raw.passportIssuedBy,
          passportIssuedAt: raw.passportIssuedAt ? new Date(raw.passportIssuedAt) : null,
          passportExpiresAt: raw.passportExpiresAt ? new Date(raw.passportExpiresAt) : null,
          passportDepartmentCode: raw.passportDepartmentCode ?? null,
          passportDetails: raw.passportDetails,
          notes: raw.notes,
          deletedAt: raw.deletedAt ? new Date(raw.deletedAt) : null,
        };
        if (existing) {
          await tx.person.update({ where: { id: existing.id }, data });
          idMap.people.set(raw.id, existing.id);
        } else {
          const created = await tx.person.create({ data: { id: raw.id, ...data } });
          idMap.people.set(raw.id, created.id);
        }

        if (raw.scans) {
          for (const scan of raw.scans) {
            const newPersonId = idMap.people.get(raw.id)!;
            const srcPath = scan.storedPath;
            const data = bundle.uploadFiles.get(srcPath);
            if (!data) continue;
            const abs = join(UPLOADS_DIR, scan.storedPath);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, data);
            if (scan.thumbPath) {
              const thumbBuf = bundle.uploadFiles.get(scan.thumbPath);
              if (thumbBuf) {
                const thumbAbs = join(UPLOADS_DIR, scan.thumbPath);
                await mkdir(dirname(thumbAbs), { recursive: true });
                await writeFile(thumbAbs, thumbBuf);
              }
            }
            await tx.passportScan.upsert({
              where: { id: scan.id },
              create: {
                id: scan.id,
                personId: newPersonId,
                filename: scan.filename,
                storedPath: scan.storedPath,
                thumbPath: scan.thumbPath,
                mimeType: scan.mimeType,
                sizeBytes: scan.sizeBytes,
                uploadedAt: new Date(scan.uploadedAt),
              },
              update: {
                personId: newPersonId,
                filename: scan.filename,
                storedPath: scan.storedPath,
                thumbPath: scan.thumbPath,
                mimeType: scan.mimeType,
                sizeBytes: scan.sizeBytes,
              },
            });
          }
        }
      }

      for (const raw of bundle.events) {
        const existing = await tx.event.findFirst({
          where: { title: raw.title, startDate: new Date(raw.startDate) },
        });
        const data = {
          title: raw.title,
          startDate: new Date(raw.startDate),
          endDate: new Date(raw.endDate),
          location: raw.location,
          cost: raw.cost,
          currency: raw.currency,
          program: raw.program,
          isOutbound: raw.isOutbound,
          accommodationPlace: raw.accommodationPlace,
          accommodationOrder: raw.accommodationOrder,
          mealType: raw.mealType,
          staysFrom: raw.staysFrom ? new Date(raw.staysFrom) : null,
          staysTo: raw.staysTo ? new Date(raw.staysTo) : null,
          accommodationCost: raw.accommodationCost,
          transportType: raw.transportType,
          transportInfo: raw.transportInfo,
          transportCost: raw.transportCost,
          deletedAt: raw.deletedAt ? new Date(raw.deletedAt) : null,
        };
        let eventId: string;
        if (existing) {
          await tx.event.update({ where: { id: existing.id }, data });
          eventId = existing.id;
        } else {
          const created = await tx.event.create({ data: { id: raw.id, ...data } });
          eventId = created.id;
        }
        idMap.events.set(raw.id, eventId);

        if (raw.excursions) {
          await tx.excursion.deleteMany({ where: { eventId } });
          if (raw.excursions.length > 0) {
            await tx.excursion.createMany({
              data: raw.excursions.map((ex) => ({ eventId, name: ex.name, cost: ex.cost })),
            });
          }
        }
      }

      for (const raw of bundle.participations) {
        const personId = idMap.people.get(raw.personId) ?? raw.personId;
        const eventId = idMap.events.get(raw.eventId) ?? raw.eventId;
        await tx.participation.upsert({
          where: { personId_eventId: { personId, eventId } },
          create: {
            id: raw.id,
            personId,
            eventId,
            paymentStatus: raw.paymentStatus,
            prepaidAmount: raw.prepaidAmount,
            totalDue: raw.totalDue,
            notes: raw.notes,
            createdAt: new Date(raw.createdAt),
          },
          update: {
            paymentStatus: raw.paymentStatus,
            prepaidAmount: raw.prepaidAmount,
            totalDue: raw.totalDue,
            notes: raw.notes,
          },
        });
      }
    },
    { timeout: 5 * 60 * 1000 },
  );

  return { ok: true, counts: { people: bundle.people.length, events: bundle.events.length, participations: bundle.participations.length } };
}
