import type { PrismaClient, Prisma } from '@prisma/client';
import { getDatabase, closeDatabase } from './storage/database';
import { initializeJournal, journalModels, journalingDisabled, recordChange, snapshots } from './sync/journal';

const mutations = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
const delegates = new Set(Object.values(journalModels));
type Method = (...args: unknown[]) => unknown;
async function transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeout?: number; maxWait?: number }) {
  const db = await getDatabase();
  return db.$transaction(async tx => {
    if (journalingDisabled()) return fn(tx);
    const before = await snapshots(tx);
    await initializeJournal(tx, before);
    const result = await fn(tx);
    const after = await snapshots(tx);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key) ?? null, b = after.get(key) ?? null;
      const content = (v: Record<string, unknown> | null) => v && Object.fromEntries(Object.entries(v).filter(([k]) => !['createdAt', 'updatedAt'].includes(k)));
      if (JSON.stringify(content(a)) !== JSON.stringify(content(b))) {
        const split = key.indexOf(':'); await recordChange(tx, key.slice(0, split), key.slice(split + 1), a, b);
      }
    }
    return result;
  }, { maxWait: 300000, timeout: 300000, ...options });
}
// Resolve the current connection lazily: an encrypted vault has no open client
// until the primary user unlocks it, and conversion replaces that connection.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, model: string) {
    if (model === '$disconnect') return closeDatabase;
    if (model === '$transaction') return (fn: unknown, options?: { timeout?: number }) => {
      if (typeof fn !== 'function') throw new Error('Используйте интерактивную транзакцию');
      return transaction(fn as (tx: Prisma.TransactionClient) => Promise<unknown>, options);
    };
    if (model.startsWith('$')) return async (...args: unknown[]) => {
      const db = await getDatabase(); return (db[model as keyof PrismaClient] as Method).apply(db, args);
    };
    return new Proxy({}, { get(_delegate, method: string) {
      return async (...args: unknown[]) => {
        if (delegates.has(model as never) && mutations.has(method) && !journalingDisabled()) {
          return transaction(async tx => (tx[model as keyof Prisma.TransactionClient] as unknown as Record<string, Method>)[method](...args));
        }
        const db = await getDatabase(); return (db[model as keyof PrismaClient] as unknown as Record<string, Method>)[method](...args);
      };
    } });
  },
});
