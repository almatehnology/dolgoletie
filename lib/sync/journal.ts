import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getDatabase } from '@/lib/storage/database';
import { dataDirectory } from '@/lib/storage/paths';

const context = new AsyncLocalStorage<boolean>();
export const journalModels = { Person: 'person', Event: 'event', Excursion: 'excursion', Participation: 'participation', PassportScan: 'passportScan' } as const;
export const journalingDisabled = () => context.getStore() === true;
export function withoutJournal<T>(fn: () => Promise<T>): Promise<T> { return context.run(true, fn); }
export async function getInstanceId() {
  const dir = dataDirectory(); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'instance.json');
  if (!existsSync(path)) {
    try { writeFileSync(path, JSON.stringify({ instanceId: randomUUID() }), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  const id = JSON.parse(readFileSync(path, 'utf8')).instanceId;
  if (typeof id !== 'string' || !id) throw new Error('Повреждены настройки экземпляра');
  return id as string;
}
type Client = Prisma.TransactionClient | PrismaClient;
export async function recordChange(tx: Client, entity: string, entityId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, parents?: string[]) {
  const deviceId = await getInstanceId();
  const operations = await tx.changeOperation.findMany({ where: { entity, entityId }, select: { id: true, parents: true } });
  const used = new Set(operations.flatMap(x => JSON.parse(x.parents) as string[]));
  const heads = operations.filter(x => !used.has(x.id)).map(x => x.id);
  const last = await tx.changeOperation.aggregate({ where: { deviceId }, _max: { sequence: true } });
  await tx.changeOperation.create({ data: { id: randomUUID(), entity, entityId, deviceId, sequence: (last._max.sequence ?? 0) + 1, parents: JSON.stringify(parents ?? heads), before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null } });
}
export async function snapshots(tx: Client) {
  const map = new Map<string, Record<string, unknown>>();
  for (const [entity, model] of Object.entries(journalModels)) {
    const rows = await (tx[model as keyof Client] as unknown as { findMany(): Promise<{ id: string }[]> }).findMany();
    for (const row of rows) map.set(`${entity}:${row.id}`, JSON.parse(JSON.stringify(row)));
  }
  return map;
}
export async function initializeJournal(tx: Client, before: Map<string, Record<string, unknown>>) {
  await tx.databaseMetadata.upsert({ where: { id: 'main' }, create: { id: 'main', databaseId: randomUUID() }, update: {} });
  const known = new Set((await tx.changeOperation.findMany({ select: { entity: true, entityId: true } })).map(x => `${x.entity}:${x.entityId}`));
  for (const [key, row] of before) if (!known.has(key)) { const colon = key.indexOf(':'); await recordChange(tx, key.slice(0, colon), key.slice(colon + 1), null, row, []); }
}
export async function ensureJournalBaseline() {
  const db = await getDatabase();
  await db.$transaction(async tx => { await initializeJournal(tx, await snapshots(tx)); }, { timeout: 300000 });
}
