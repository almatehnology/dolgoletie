import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { readPeople } from './database';
import { jobs } from './jobs';
import { ImportError } from './limits';
import { buildPlan, planIsCurrent } from './plan';
import type { ApplyResult, Job, PlanGroup } from './types';

export const receiptId = (owner: string, jobId: string) => `batch:${createHash('sha256').update(owner).update('\0').update(jobId).digest('hex')}`;
type Receipt = { version: number; result: ApplyResult };
export async function getReceipt(owner: string, jobId: string, version: number): Promise<ApplyResult | null> {
  const found = await prisma.importReceipt.findUnique({ where: { id: receiptId(owner, jobId) } });
  if (!found) return null;
  const receipt = JSON.parse(found.result) as Receipt;
  if (receipt.version !== version) throw new ImportError('ALREADY_APPLIED', 'Задание уже сохранено с другой версией плана.', 409);
  return receipt.result;
}
function dataFor(group: PlanGroup): Prisma.PersonUpdateInput {
  const data: Record<string, string | Date> = {};
  for (const change of group.changes) {
    if (!change.value || (group.action === 'existing' && change.value === change.current)) continue;
    data[change.key] = change.key === 'passportIssuedAt' || change.key === 'passportExpiresAt' ? new Date(`${change.value}T00:00:00.000Z`) : change.value;
  }
  return data;
}
export async function commitPlan(job: Job, version: number): Promise<ApplyResult> {
  if (!job.plan || job.revision !== version || job.plan.version !== version) throw new ImportError('PLAN_VERSION', 'План изменился. Просмотрите новую версию и подтвердите её.', 409);
  if (job.plan.blocked || !job.plan.ready) throw new ImportError('UNRESOLVED', 'Разрешите конфликты или исключите проблемные строки; должен остаться хотя бы один человек.', 409);
  const id = receiptId(job.owner, job.id);
  try {
    return await prisma.$transaction(async (tx) => {
      const prior = await tx.importReceipt.findUnique({ where: { id } });
      if (prior) {
        const receipt = JSON.parse(prior.result) as Receipt;
        if (receipt.version !== version) throw new ImportError('ALREADY_APPLIED', 'Импорт уже подтверждён с другой версией.', 409);
        return receipt.result;
      }
      // Read both affected cards and all candidate indexes from the same transactional snapshot.
      const people = await readPeople(tx);
      const fresh = buildPlan(job, people);
      if (!planIsCurrent(job.plan!, fresh)) {
        throw new StalePlan(people);
      }
      const result: ApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0, restored: 0, people: [] };
      for (const group of fresh.groups) {
        if (group.action === 'skip') { result.skipped += group.rowIds.length; continue; }
        if (!group.ready) throw new ImportError('UNRESOLVED', 'План содержит неразрешённые строки.', 409);
        const data = dataFor(group);
        if (group.action === 'new') {
          const created = await tx.person.create({ data: { ...data, lastName: group.changes.find((c) => c.key === 'lastName')!.value!, firstName: group.changes.find((c) => c.key === 'firstName')!.value! } as Prisma.PersonCreateInput });
          result.created++;
          result.people.push({ id: created.id, action: 'created', groupId: group.id });
        } else if (group.action === 'existing' && group.target) {
          const changed = Object.keys(data).length > 0 || group.restore;
          if (changed) {
            await tx.person.update({ where: { id: group.target.id }, data: { ...data, ...(group.restore ? { deletedAt: null } : {}) } });
            result.updated++; if (group.restore) result.restored++;
          } else result.unchanged++;
          result.people.push({ id: group.target.id, action: changed ? 'updated' : 'unchanged', groupId: group.id });
        }
      }
      await tx.importReceipt.create({ data: { id, result: JSON.stringify({ version, result } satisfies Receipt) } });
      return result;
    }, { timeout: 60000, maxWait: 10000 });
  } catch (err) {
    if (err instanceof StalePlan) {
      const next = { ...job, revision: job.revision + 1, decisions: [] };
      next.plan = buildPlan(next, err.people);
      jobs.checkSize(next);
      Object.assign(job, next);
      throw new ImportError('STALE_PLAN', 'Карточки или кандидаты изменились. План пересчитан; проверьте и подтвердите его заново.', 409);
    }
    // A concurrent process may have committed the same receipt while this writer waited.
    const prior = await getReceipt(job.owner, job.id, version);
    if (prior) return prior;
    throw err;
  }
}
class StalePlan extends Error { constructor(public people: Awaited<ReturnType<typeof readPeople>>) { super('stale'); } }

export async function applyJob(owner: string, id: string, version: number): Promise<ApplyResult> {
  // Durable receipt is checked before memory; a retry after process restart still works.
  const prior = await getReceipt(owner, id, version);
  if (prior) return prior;
  return jobs.locked(id, owner, async (job) => {
    const result = await commitPlan(job, version);
    job.result = result;
    job.tables = []; job.rowEdits = []; job.decisions = []; job.manualCandidateIds = []; job.plan = null;
    jobs.checkSize(job);
    return result;
  });
}
