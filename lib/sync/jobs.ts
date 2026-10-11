import { randomUUID } from 'node:crypto';
import type { Alias, Bundle, MergePlan } from './types';
import type { AccessPreview } from './access';
import { SyncError } from './validation';

export interface SyncJob {
  id: string; owner: string; bundle: Bundle; access: unknown; createdAt: number;
  fingerprint: string; plan: MergePlan; accessPreview: AccessPreview | null; busy: boolean;
  selectedAliases: Alias[];
  expiry?: NodeJS.Timeout;
}
const globalJobs=globalThis as typeof globalThis & {tdbSyncJobs?:Map<string,SyncJob>};
const jobs=globalJobs.tdbSyncJobs ??= new Map<string,SyncJob>();
const TTL=30*60*1000, MAX_MEMORY=512*1024*1024;
export function clearJobAccess(access:unknown) {
  if(!access || typeof access!=='object') return;
  const value=access as {root?:Buffer;password?:string};
  if(Buffer.isBuffer(value.root)) value.root.fill(0);
  value.root=undefined;value.password=undefined;
}
function remove(job:SyncJob) {if(job.expiry)clearTimeout(job.expiry);clearJobAccess(job.access);jobs.delete(job.id);}
export function clearOwnerJobs(owner:string) {for(const job of jobs.values())if(job.owner===owner && !job.busy)remove(job);}
export function clearSyncJobs() { for(const job of jobs.values()) if(!job.busy) remove(job); }
function cleanup() { for(const job of jobs.values()) if(!job.busy && Date.now()-job.createdAt>TTL) remove(job); }
export function addJob(input: Omit<SyncJob,'id'|'createdAt'|'busy'>) {
  cleanup();
  const bytes=(b: Bundle)=>b.manifest.data.bytes+[...b.files.values()].reduce((n,f)=>n+f.length,0);
  if(jobs.size>=8 || [...jobs.values()].reduce((n,j)=>n+bytes(j.bundle),bytes(input.bundle))>MAX_MEMORY) {clearJobAccess(input.access);throw new SyncError('Слишком много открытых заданий. Закройте предыдущие.',413);}
  const job: SyncJob={...input,id:randomUUID(),createdAt:Date.now(),busy:false}; jobs.set(job.id,job);
  const expire=()=>{if(!jobs.has(job.id))return;if(job.busy){job.expiry=setTimeout(expire,1000);job.expiry.unref();return;}remove(job);};
  job.expiry=setTimeout(expire,TTL);job.expiry.unref();
  return job;
}
export function getJob(id: string, owner: string) {
  cleanup(); const job=jobs.get(id);
  if(!job || job.owner!==owner) throw new SyncError('Предпросмотр истёк. Выберите файл заново.',404,'SYNC_JOB_EXPIRED');
  return job;
}
export function deleteJob(id: string,owner: string) { const job=getJob(id,owner); if(job.busy) throw new SyncError('Задание применяется',409); remove(job); }
export function publicJob(job: SyncJob) {
  return { jobId:job.id,bundleId:job.bundle.manifest.bundleId,databaseId:job.bundle.manifest.databaseId,fingerprint:job.fingerprint,plan:job.plan,access:job.accessPreview ? { required: job.accessPreview.required, message: job.accessPreview.message, requiresProof:job.accessPreview.requiresProof } : null,expiresAt:new Date(job.createdAt+TTL).toISOString() };
}
