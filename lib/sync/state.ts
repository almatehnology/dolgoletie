import type { Prisma } from '@prisma/client';
import { readScanFile } from '@/lib/uploads';
import { storageGeneration } from '@/lib/storage/paths';
import { ENTITIES, emptySnapshots, type Alias, type Entity, type Operation, type Snapshot, type SyncData } from './types';
import { safeStoragePath, sha256, stable, SyncError } from './validation';

export const MODELS = { Person:'person', Event:'event', Excursion:'excursion', Participation:'participation', PassportScan:'passportScan' } as const;
export interface RetainedAttachment { sha256: string; path: string; mimeType: string; bytes: number }
export type Delegate = {
  findMany(args?: Record<string,unknown>): Promise<Snapshot[]>;
  upsert(args: Record<string,unknown>): Promise<Snapshot>;
  deleteMany(args: Record<string,unknown>): Promise<unknown>;
};
export function delegate(tx: Prisma.TransactionClient, entity: Entity) { return tx[MODELS[entity]] as unknown as Delegate; }
function json<T>(value: unknown): T { return JSON.parse(JSON.stringify(value)) as T; }

/** All scalar tables, journal and retention metadata are read in the same
 * interactive transaction. Files remain immutable and retained by the upload
 * store, and are copied into memory before the read transaction is released. */
export async function captureState(tx: Prisma.TransactionClient) {
  const snapshots=emptySnapshots();
  for(const entity of ENTITIES) snapshots[entity]=json<Snapshot[]>(await delegate(tx,entity).findMany({orderBy:{id:'asc'}}));
  const rows=await tx.changeOperation.findMany({orderBy:{id:'asc'}});
  const operations: Operation[]=rows.map(o=>({ ...o, entity:o.entity as Entity, before:o.before?JSON.parse(o.before):null, after:o.after?JSON.parse(o.after):null, parents:JSON.parse(o.parents), createdAt:o.createdAt.toISOString() }));
  const receipts=await tx.syncReceipt.findMany({where:{OR:[{id:{startsWith:'sync-attachment:'}},{id:{startsWith:'sync-alias:'}}]}});
  const retained=new Map<string,RetainedAttachment>(), aliases: Alias[]=[];
  for(const receipt of receipts) {
    if(receipt.id.startsWith('sync-attachment:')) { const value=JSON.parse(receipt.result) as RetainedAttachment; retained.set(value.sha256,value); }
    else aliases.push(JSON.parse(receipt.result) as Alias);
  }
  const files=new Map<string,Buffer>(), pathHashes=new Map<string,string>();
  async function canonicalize(snapshot: Snapshot | null) {
    if(!snapshot) return null;
    const stored=String(snapshot.storedPath), contentHash=/^sha256:([a-f0-9]{64})$/.exec(stored)?.[1];
    let hash=contentHash ?? pathHashes.get(stored);
    if(!hash || !files.has(hash)) {
      const path=contentHash ? retained.get(contentHash)?.path : stored;
      if(!path) throw new SyncError('Не найден сохранённый оригинал вложения из истории',409);
      let buffer: Buffer;
      try { buffer=await readScanFile(safeStoragePath(path)); }
      catch { throw new SyncError('Оригинал вложения отсутствует. Выгрузка остановлена.',409); }
      hash=sha256(buffer);
      if((contentHash && contentHash!==hash) || buffer.length!==snapshot.sizeBytes) throw new SyncError('Оригинал вложения повреждён',409);
      files.set(hash,buffer); pathHashes.set(stored,hash);
      retained.set(hash,{sha256:hash,path,mimeType:String(snapshot.mimeType),bytes:buffer.length});
    }
    return { ...snapshot,storedPath:`sha256:${hash}`,thumbPath:null };
  }
  for(let i=0;i<snapshots.PassportScan.length;i++) snapshots.PassportScan[i]=(await canonicalize(snapshots.PassportScan[i]))!;
  for(const op of operations) if(op.entity==='PassportScan') { op.before=await canonicalize(op.before); op.after=await canonicalize(op.after); }
  const metadata=await tx.databaseMetadata.findUnique({where:{id:'main'}});
  if(!metadata) throw new SyncError('Журнал синхронизации не инициализирован',409);
  const data: SyncData={snapshots,operations,aliases:aliases.sort((a,b)=>a.source.localeCompare(b.source))};
  return {data, files, retained, databaseId:metadata.databaseId, fingerprint:sha256(stable({data,generation:storageGeneration()??null}))};
}
