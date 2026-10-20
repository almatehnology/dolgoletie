import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ENTITIES, type Entity, type Snapshot } from './types';
import { ARCHIVE_MAX_BYTES } from '@/lib/transfer-limits';

export class SyncError extends Error {
  constructor(message: string, public status = 400, public code = 'SYNC_INVALID') { super(message); }
}
export const LIMITS = { bundle: ARCHIVE_MAX_BYTES, expanded: ARCHIVE_MAX_BYTES, json: 32 * 1024 * 1024, attachment: 10 * 1024 * 1024, entries: 20000, operations: 100000, records: 100000 };
export const idSchema = z.string().min(1).max(180).regex(/^[a-zA-Z0-9:_-]+$/);
const scalar = z.union([z.string().max(1000000), z.number().finite(), z.boolean(), z.null()]);
const snapshot = z.record(scalar).refine(v => idSchema.safeParse(v.id).success, 'Некорректный ID');
export const operationSchema = z.object({
  id: idSchema, entity: z.enum(ENTITIES), entityId: idSchema, before: snapshot.nullable(), after: snapshot.nullable(),
  parents: z.array(idSchema).max(10000), deviceId: idSchema, sequence: z.number().int().nonnegative(), createdAt: z.string().datetime(),
}).strict();
export const aliasSchema = z.object({ source: idSchema, target: idSchema }).strict();
export const dataSchema = z.object({
  snapshots: z.object(Object.fromEntries(ENTITIES.map(e => [e, z.array(snapshot).max(LIMITS.records)])) as Record<Entity, z.ZodArray<typeof snapshot>>).strict(),
  operations: z.array(operationSchema).max(LIMITS.operations), aliases: z.array(aliasSchema).max(LIMITS.records),
}).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const manifestSchema = z.object({
  format: z.literal('dolgoletie-sync'), version: z.literal(1), schemaVersion: z.literal(1),
  bundleId: idSchema, databaseId: idSchema, deviceId: idSchema, createdAt: z.string().datetime(),
  data: z.object({ path: z.literal('data.json'), bytes: z.number().int().positive().max(LIMITS.json), sha256: hash }).strict(),
  attachments: z.array(z.object({ sha256: hash, path: z.string(), bytes: z.number().int().positive().max(LIMITS.attachment) }).strict()).max(LIMITS.entries - 2),
}).strict();
export function sha256(value: Buffer | string) { return createHash('sha256').update(value).digest('hex'); }
export function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(record[k])}`).join(',')}}`;
}
export function safeArchivePath(path: string) {
  if (path.length > 240 || !/^[a-zA-Z0-9._/-]+$/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new SyncError('Недопустимый путь в файле обмена');
  }
  return path;
}
export function safeStoragePath(path: string) {
  const portable = path.replaceAll('\\', '/');
  safeArchivePath(portable);
  if (portable.includes(':')) throw new SyncError('Недопустимый путь вложения');
  return portable;
}
export const FIELDS: Record<Entity, string[]> = {
  Person: ['id','lastName','firstName','middleName','phone','gender','birthDate','birthPlace','registrationAddress','passportNumber','passportIssuedBy','passportIssuedAt','passportExpiresAt','passportDepartmentCode','passportDetails','notes','createdAt','updatedAt','deletedAt'],
  Event: ['id','title','startDate','endDate','location','cost','currency','program','isOutbound','accommodationPlace','accommodationOrder','mealType','staysFrom','staysTo','accommodationCost','transportType','transportInfo','transportCost','createdAt','updatedAt','deletedAt'],
  Excursion: ['id','eventId','name','cost'],
  Participation: ['id','personId','eventId','paymentStatus','prepaidAmount','totalDue','notes','createdAt'],
  PassportScan: ['id','personId','filename','storedPath','thumbPath','mimeType','sizeBytes','uploadedAt'],
};
const required: Record<Entity, string[]> = {
  Person: ['lastName','firstName','createdAt','updatedAt'], Event: ['title','startDate','endDate','location','currency','isOutbound','createdAt','updatedAt'],
  Excursion: ['eventId','name'], Participation: ['personId','eventId','paymentStatus','createdAt'], PassportScan: ['personId','filename','storedPath','mimeType','sizeBytes','uploadedAt'],
};
const dates = new Set(['createdAt','updatedAt','uploadedAt','deletedAt','passportIssuedAt','passportExpiresAt','startDate','endDate','staysFrom','staysTo']);
const decimals = new Set(['cost','accommodationCost','transportCost','prepaidAmount','totalDue']);
export function validateSnapshot(entity: Entity, value: Snapshot) {
  for (const [field, v] of Object.entries(value)) {
    if (!FIELDS[entity].includes(field)) throw new SyncError(`Поле ${entity}.${field} не поддерживается. Обновите приложение.`);
    if (v !== null) {
      if (field === 'isOutbound' ? typeof v !== 'boolean' : field === 'sizeBytes' ? !Number.isSafeInteger(v) || Number(v) <= 0 || Number(v) > LIMITS.attachment : typeof v !== 'string') throw new SyncError(`Некорректное поле ${entity}.${field}`);
      if (dates.has(field) && (!z.string().datetime().safeParse(v).success || !Number.isFinite(Date.parse(String(v))))) throw new SyncError(`Некорректная дата ${field}`);
      if (decimals.has(field) && !/^-?\d+(\.\d+)?$/.test(String(v))) throw new SyncError(`Некорректное число ${field}`);
      if (field.endsWith('Id') || field === 'id') idSchema.parse(v);
    }
  }
  for (const field of required[entity]) if (value[field] == null || (typeof value[field] === 'string' && !String(value[field]).trim())) throw new SyncError(`Не заполнено ${entity}.${field}`);
  if (entity === 'Event' && Date.parse(String(value.endDate)) < Date.parse(String(value.startDate))) throw new SyncError('Дата окончания мероприятия раньше даты начала');
  if (value.staysFrom && value.staysTo && String(value.staysTo) < String(value.staysFrom)) throw new SyncError('Дата окончания проживания раньше даты начала');
  if (value.birthDate != null) {
    const s = String(value.birthDate), d = new Date(`${s}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(+d) || d.toISOString().slice(0,10) !== s) throw new SyncError('Некорректная дата рождения');
  }
  for (const [field, allowed] of Object.entries({ currency: ['RUB','USD'], paymentStatus: ['UNPAID','PREPAID','PAID'], transportType: ['BUS','TRAIN','PLANE','OTHER'], gender: ['MALE','FEMALE','OTHER'] })) {
    if (value[field] != null && !allowed.includes(String(value[field]))) throw new SyncError(`Некорректное значение ${field}`);
  }
  if (entity === 'PassportScan' && (!/^sha256:[a-f0-9]{64}$/.test(String(value.storedPath)) || !['image/jpeg','image/png','image/webp','application/pdf'].includes(String(value.mimeType)))) throw new SyncError('Некорректная ссылка или тип вложения');
}
