import { randomUUID } from 'node:crypto';
import { ImportError, LIMITS } from './limits';
import type { Job, JobView, Table } from './types';

export class JobStore {
  private jobs = new Map<string, Job>();
  private parsing = 0;
  constructor(private now = () => Date.now()) {}
  prune() { for (const [id, job] of this.jobs) if (!job.busy && job.expiresAt <= this.now()) this.jobs.delete(id); }
  async parse<T>(fn: () => Promise<T>): Promise<T> {
    this.prune();
    if (this.parsing >= 2 || this.jobs.size + this.parsing >= LIMITS.jobs) throw new ImportError('BUSY', 'Лимит заданий исчерпан. Отмените ненужный импорт или попробуйте позже.', 429);
    this.parsing++;
    try { return await fn(); } finally { this.parsing--; }
  }
  create(owner: string, tables: Table[]): Job {
    this.prune();
    if (this.jobs.size >= LIMITS.jobs) throw new ImportError('JOB_LIMIT', 'Слишком много открытых заданий.', 429);
    const createdAt = this.now();
    const job: Job = { id: randomUUID(), owner, createdAt, expiresAt: createdAt + LIMITS.ttlMs, revision: 1, tables, rowEdits: [], decisions: [], manualCandidateIds: [], plan: null, result: null, busy: false, bytes: 0 };
    this.checkSize(job);
    this.jobs.set(job.id, job);
    return job;
  }
  checkSize(job: Job) {
    const bytes = Buffer.byteLength(JSON.stringify(job));
    const others = [...this.jobs.values()].filter((j) => j.id !== job.id).reduce((n, j) => n + j.bytes, 0);
    if (bytes > LIMITS.jobBytes || others + bytes > LIMITS.memoryBytes) throw new ImportError('MEMORY_LIMIT', 'Задание слишком велико. Разделите пакет или отмените другие задания.', 413);
    job.bytes = bytes;
  }
  get(id: string, owner: string): Job {
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new ImportError('JOB_NOT_FOUND', 'Задание истекло, отменено или принадлежит другой сессии. Выберите файлы снова.', 404);
    return job;
  }
  delete(id: string, owner: string) {
    const job = this.get(id, owner);
    if (job.busy) throw new ImportError('JOB_BUSY', 'Задание сохраняется; дождитесь результата.', 409);
    this.jobs.delete(id);
  }
  clearOwner(owner: string) { for (const [id, job] of this.jobs) if (job.owner === owner && !job.busy) this.jobs.delete(id); }
  clear() { for (const [id, job] of this.jobs) if (!job.busy) this.jobs.delete(id); }
  async locked<T>(id: string, owner: string, fn: (job: Job) => Promise<T>): Promise<T> {
    const job = this.get(id, owner);
    if (job.busy) throw new ImportError('JOB_BUSY', 'Другой запрос уже обрабатывает задание.', 409);
    job.busy = true;
    try { return await fn(job); } finally { job.busy = false; }
  }
}
const globalJobs = globalThis as typeof globalThis & { batchImportJobs?: JobStore; batchImportJobSweep?: ReturnType<typeof setInterval> };
export const jobs = globalJobs.batchImportJobs ??= new JobStore();
if (!globalJobs.batchImportJobSweep) {
  globalJobs.batchImportJobSweep = setInterval(() => jobs.prune(), 60000);
  globalJobs.batchImportJobSweep.unref();
}
export const clearJobsForOwner = (owner: string) => jobs.clearOwner(owner);
/** Call from the shared logout/vault-lock flow, whose files are outside this module's scope. */
export const clearBatchImportJobs = () => jobs.clear();
export function jobView(job: Job): JobView {
  const { owner: _owner, busy: _busy, bytes: _bytes, manualCandidateIds: _ids, ...view } = job;
  return view;
}
