import { prisma } from '@/lib/db';
import { saveScanFile } from '@/lib/uploads';
import { decodeVaultBundle, encodeVaultBundle } from '@/lib/crypto/bundle';
import { vaultLock } from '@/lib/storage/vault';
import { withAuthOperation } from '@/lib/auth/mutex';
import { applySyncAccess, completeSyncAccess, hasSyncAccessPostCommit, previewSyncAccess, type AccessDecision, type AccessResult } from './access';
import { buildBundle, parseBundle } from './bundle';
import { addJob, clearJobAccess, getJob, type SyncJob } from './jobs';
import { ensureJournalBaseline, getInstanceId, recordChange, withoutJournal } from './journal';
import { aliasResolver, buildMergePlan, recordKey } from './merge';
import { captureState, delegate } from './state';
import { ENTITIES, type Alias, type ApplyResult, type Decisions, type Entity, type RecordPlan, type Snapshot } from './types';
import { idSchema, stable, SyncError, validateSnapshot } from './validation';
import { ARCHIVE_MAX_BYTES } from '@/lib/transfer-limits';

export async function exportSyncBundle() {
  return withAuthOperation(async()=>{
  await ensureJournalBaseline();
  const deviceId=await getInstanceId();
  const captured=await withoutJournal(()=>prisma.$transaction(tx=>captureState(tx),{timeout:300000}));
  const payload=await buildBundle(captured.data,captured.files,{databaseId:captured.databaseId,deviceId});
  const buffer=await encodeVaultBundle(payload);
  return {buffer,filename:`dolgoletie-${new Date().toISOString().slice(0,10)}.tdbsync`};
  });
}

export async function previewSyncBundle(buffer: Buffer,owner: string,password?: string) {
  if(buffer.length>ARCHIVE_MAX_BYTES) throw new SyncError('Размер файла не должен превышать 1 ГиБ.',413);
  const {payload,access}=await decodeVaultBundle(buffer,password);
  try {
  const bundle=await parseBundle(payload);
  return await withAuthOperation(async()=>{
  await ensureJournalBaseline();
  const result=await withoutJournal(()=>prisma.$transaction(async tx=>{
    const local=await captureState(tx);
    return {fingerprint:local.fingerprint,plan:buildMergePlan(local.data,bundle.data),accessPreview:await previewSyncAccess(access,tx)};
  },{timeout:300000}));
  return addJob({owner,bundle,access,...result,selectedAliases:[]});
  });
  } catch(error) {clearJobAccess(access);throw error;}
}

export async function refreshSyncJob(job: SyncJob,aliases: Alias[]=job.selectedAliases) {
  if(job.busy) throw new SyncError('Задание уже применяется',409);
  job.busy=true;
  try {return await withAuthOperation(async()=>{
  const candidates=new Set(job.plan.candidates.map(c=>`${c.incomingId}\0${c.localId}`));
  for(const alias of aliases) if(!job.selectedAliases.some(a=>stable(a)===stable(alias)) && !candidates.has(`${alias.source}\0${alias.target}`)) throw new SyncError('Объединять можно только показанные карточки-кандидаты');
  const result=await withoutJournal(()=>prisma.$transaction(async tx=>{
    const local=await captureState(tx);
    return {fingerprint:local.fingerprint,plan:buildMergePlan(local.data,job.bundle.data,aliases),accessPreview:await previewSyncAccess(job.access,tx)};
  },{timeout:300000}));
  Object.assign(job,result,{selectedAliases:aliases});
  return job;
  });}finally{job.busy=false;}
}

function chosenRecords(records: RecordPlan[],decisions: Decisions) {
  const keys=new Set(records.map(r=>r.key));
  if(Object.keys(decisions).some(key=>!keys.has(key))) throw new SyncError('Решение относится к записи, которой нет в плане');
  const chosen=new Map<string,{record:RecordPlan;after:Snapshot|null;deferred:boolean}>();
  for(const r of records) {
    const decision=decisions[r.key];
    if(!decision && (r.conflicts.length || r.deletion || r.constraint)) throw new SyncError('Каждое удаление и конфликт требуют явного решения');
    const action=decision?.action ?? 'accept';
    if(action==='defer') {chosen.set(r.key,{record:r,after:r.before,deferred:true});continue;}
    let after:Snapshot|null;
    if(action==='keep-local') after=r.before ? {...r.before} : null;
    else {
      const values={...r.values}; let exists=r.proposed!==null;
      for(const conflict of r.conflicts) {
        if(!decision?.fields || !Object.hasOwn(decision.fields,conflict.field)) throw new SyncError(`Выберите значение поля ${conflict.field}`);
        const value=decision.fields[conflict.field];
        if(!conflict.options.some(o=>stable(o.value)===stable(value)) && stable(value)!==stable(conflict.local)) throw new SyncError('Выбрано значение, которого нет в плане');
        if(conflict.field==='$exists') exists=value===true; else values[conflict.field]=value;
      }
      if(decision?.fields && Object.keys(decision.fields).some(f=>!r.conflicts.some(c=>c.field===f))) throw new SyncError('Нельзя изменить поле вне конфликта');
      after=exists ? values : null;
    }
    if(after) validateSnapshot(r.entity,after);
    chosen.set(r.key,{record:r,after,deferred:false});
  }
  return chosen;
}

function validateRelations(final: Map<Entity,Map<string,Snapshot>>) {
  const pairs=new Set<string>();
  for(const entity of ENTITIES) for(const row of final.get(entity)!.values()) {
    if(row.personId && !final.get('Person')!.has(String(row.personId))) throw new SyncError('Удаление человека затрагивает сохранённые связи. Оставьте человека или сначала разрешите удаления его связей.',409);
    if(row.eventId && !final.get('Event')!.has(String(row.eventId))) throw new SyncError('Удаление мероприятия затрагивает сохранённые связи. Оставьте мероприятие или разрешите удаления его связей.',409);
    if(entity==='Participation') {
      const pair=`${row.personId}\0${row.eventId}`;
      if(pairs.has(pair)) throw new SyncError('У человека два участия в одном мероприятии. Оставьте одно, другое отклоните или отложите.',409);
      pairs.add(pair);
    }
  }
}

export async function applySyncJob(jobId:string,owner:string,fingerprint:string,decisions:Decisions,accessDecision?:AccessDecision):Promise<ApplyResult> {
  const job=getJob(jobId,owner);
  if(job.busy) throw new SyncError('Задание уже применяется',409);
  job.busy=true;
  try {
    const receiptId=`sync-bundle:${job.bundle.manifest.bundleId}`;
    const finishAccess=async (saved:ApplyResult):Promise<ApplyResult>=>{
      if(saved.access?.status!=='pending') return saved;
      if(saved.access.requiresAdmin) {
        const stillNeeded=await withoutJournal(()=>prisma.$transaction(tx=>previewSyncAccess(job.access,tx),{timeout:300000}));
        if(stillNeeded) return saved;
      }
      let access:AccessResult;
      try { access=await completeSyncAccess(job.access,accessDecision,saved.access); }
      catch { return saved; }
      const report={...saved,access:safeAccessResult(access),complete:saved.deferred===0 && !['pending','deferred'].includes(access.status)};
      await withoutJournal(()=>prisma.$transaction(async tx=>{ await tx.syncReceipt.update({where:{id:receiptId},data:{result:stable({...report,digest:job.bundle.digest})}}); },{timeout:300000}));
      if(access.requiresLogin) {clearJobAccess(job.access);await vaultLock();}
      return report;
    };
    const receipt=await prisma.syncReceipt.findUnique({where:{id:receiptId}});
    if(receipt) {
      const saved=JSON.parse(receipt.result) as ApplyResult & {digest:string};
      if(saved.digest!==job.bundle.digest) throw new SyncError('ID пакета повторён с другим содержимым',409);
      if(saved.complete) {const {digest:_,...result}=saved;return {...result,replayed:true};}
      if(saved.access?.status==='pending') {const {digest:_,...result}=saved;return finishAccess(result);}
    }
    const applied=await withAuthOperation(async()=>{
    const queuedReceipt=await prisma.syncReceipt.findUnique({where:{id:receiptId}});
    if(queuedReceipt) {
      const {digest,...saved}=JSON.parse(queuedReceipt.result) as ApplyResult & {digest:string};
      if(digest!==job.bundle.digest) throw new SyncError('ID пакета повторён с другим содержимым',409);
      if(saved.complete || saved.access?.status==='pending') return saved.complete ? {...saved,replayed:true} : saved;
    }
    if(fingerprint!==job.fingerprint) throw new SyncError('Предпросмотр изменился. Обновите план.',409,'SYNC_STALE');
    const captured=await withoutJournal(()=>prisma.$transaction(tx=>captureState(tx),{timeout:300000}));
    if(captured.fingerprint!==fingerprint) throw new SyncError('Локальные данные изменились. Обновите план и повторите выбор.',409,'SYNC_STALE');
    const chosen=chosenRecords(job.plan.records,decisions);
    // Defer creations/reassignments depending on a deferred person/event.
    let changed=true;
    while(changed) {
      changed=false;
      for(const selection of chosen.values()) {
        if(selection.deferred || !selection.after) continue;
        const after=selection.after;
        for(const [field,entity] of [['personId','Person'],['eventId','Event']] as const) {
          const id=after[field];
          const dependency=id && chosen.get(recordKey(entity,String(id)));
          if(dependency && ((!dependency.after) || (dependency.deferred && (!dependency.record.before || dependency.record.mergedIds.length)))) {selection.deferred=true;selection.after=selection.record.before;changed=true;}
        }
      }
    }
    const accepted=[...chosen.values()].filter(s=>!s.deferred), deferred=chosen.size-accepted.length;
    const resolve=aliasResolver(job.plan.aliases);
    const final=new Map(ENTITIES.map(e=>[e,new Map(captured.data.snapshots[e].map(s=>[s.id,s]))]));
    for(const {record,after} of accepted) {
      if(after) final.get(record.entity)!.set(record.entityId,after); else final.get(record.entity)!.delete(record.entityId);
      for(const id of record.mergedIds) final.get('Person')!.delete(id);
    }
    validateRelations(final);
    const acceptedOps=new Set(accepted.flatMap(s=>s.record.incoming));
    const incomingOps=job.bundle.data.operations.filter(o=>acceptedOps.has(o.id));
    const prepared=new Map(captured.retained), thumbs=new Map<string,string|null>();
    const scanImages=[...accepted.filter(s=>s.record.entity==='PassportScan' && s.after).map(s=>s.after!),...incomingOps.filter(o=>o.entity==='PassportScan').flatMap(o=>[o.before,o.after].filter(s=>s!==null) as Snapshot[])];
    for(const scan of scanImages) {
      const hash=String(scan.storedPath).slice(7);
      if(prepared.has(hash)) continue;
      const buffer=job.bundle.files.get(hash);
      if(!buffer) throw new SyncError('Не найден оригинал вложения');
      const personId=resolve(String(scan.personId)); idSchema.parse(personId);
      // saveScanFile allocates a fresh immutable object in the active store;
      // the crypto-aware upload helper owns every write, including previews.
      const saved=await saveScanFile(personId,String(scan.filename),buffer);
      if(saved.sha256!==hash || saved.sizeBytes!==scan.sizeBytes || saved.mimeType!==scan.mimeType) throw new SyncError('Содержимое вложения не соответствует метаданным');
      prepared.set(hash,{sha256:hash,path:saved.storedPath,mimeType:saved.mimeType,bytes:saved.sizeBytes}); thumbs.set(hash,saved.thumbPath);
    }
    return await withoutJournal(()=>prisma.$transaction(async tx=>{
      const concurrent=await tx.syncReceipt.findUnique({where:{id:receiptId}});
      if(concurrent) {
        const saved=JSON.parse(concurrent.result) as ApplyResult & {digest:string};
        if(saved.digest!==job.bundle.digest) throw new SyncError('ID пакета повторён с другим содержимым',409);
        if(saved.complete) {const {digest:_,...result}=saved;return {...result,replayed:true};}
      }
      const current=await captureState(tx);
      if(current.fingerprint!==fingerprint) throw new SyncError('Данные изменились во время подготовки. Обновите план.',409,'SYNC_STALE');
      for(const op of incomingOps) await tx.changeOperation.create({data:{...op,before:op.before?stable(op.before):null,after:op.after?stable(op.after):null,parents:stable(op.parents),createdAt:new Date(op.createdAt)}});
      // Explicit child-first deletes prevent a database cascade from removing
      // locally created or deferred relations behind the confirmation screen.
      for(const entity of ['PassportScan','Participation','Excursion','Person','Event'] as const) for(const selection of accepted.filter(s=>s.record.entity===entity && !s.after)) await delegate(tx,entity).deleteMany({where:{id:selection.record.entityId}});
      // Reinsert selected participation IDs so a valid pair reassignment/swap
      // cannot violate the unique key transiently between two updates.
      await tx.participation.deleteMany({where:{id:{in:accepted.filter(s=>s.record.entity==='Participation' && s.after).map(s=>s.record.entityId)}}});
      for(const entity of ['Person','Event','Excursion','Participation','PassportScan'] as const) for(const {record,after} of accepted.filter(s=>s.record.entity===entity && s.after)) {
        const data={...after!};
        if(entity==='PassportScan') {const hash=String(data.storedPath).slice(7); data.storedPath=prepared.get(hash)!.path;data.thumbPath=thumbs.get(hash) ?? null;}
        await delegate(tx,entity).upsert({where:{id:record.entityId},create:data,update:data});
      }
      for(const {record,after} of accepted) {
        // Always emit a resolution, including no-op acceptance/rejection.
        // Its full after image resolves every field against ALL graph heads.
        await recordChange(tx,record.entity,record.entityId,record.before,after,record.heads);
        for(const source of record.mergedIds) await tx.person.deleteMany({where:{id:source}});
      }
      for(const alias of job.plan.aliases) {
        if(!accepted.some(s=>s.record.entity==='Person' && s.record.entityId===resolve(alias.target))) continue;
        await tx.syncReceipt.upsert({where:{id:`sync-alias:${alias.source}`},create:{id:`sync-alias:${alias.source}`,result:stable(alias)},update:{result:stable(alias)}});
      }
      for(const attachment of prepared.values()) await tx.syncReceipt.upsert({where:{id:`sync-attachment:${attachment.sha256}`},create:{id:`sync-attachment:${attachment.sha256}`,result:stable(attachment)},update:{result:stable(attachment)}});
      // An empty installation joins the exported database. Its instance ID
      // remains local; independently populated databases retain their identity.
      if(current.data.operations.length===0 && ENTITIES.every(e=>current.data.snapshots[e].length===0)) await tx.databaseMetadata.update({where:{id:'main'},data:{databaseId:job.bundle.manifest.databaseId}});
      const accessResult=accessDecision?.choice==='defer' ? {status:'deferred' as const} : await applySyncAccess(job.access,accessDecision,tx);
      const access=accessResult ? safeAccessResult({...accessResult,status:hasSyncAccessPostCommit() && accessResult.status==='applied' ? 'pending' as const : accessResult.status}) : undefined;
      const report: ApplyResult={bundleId:job.bundle.manifest.bundleId,applied:accepted.length,deferred,complete:deferred===0 && !['deferred','pending'].includes(access?.status ?? ''),access};
      const result=stable({...report,digest:job.bundle.digest});
      await tx.syncReceipt.upsert({where:{id:receiptId},create:{id:receiptId,result},update:{result}});
      return report;
    },{timeout:300000}));
    });
    return finishAccess(applied);
  } finally {job.busy=false;}
}
function safeAccessResult(value:AccessResult):AccessResult {
  if(!['unchanged','applied','deferred','pending'].includes(value.status)) throw new SyncError('Некорректный результат переноса доступа',409);
  return {status:value.status,requiresLogin:value.requiresLogin===true,requiresAdmin:value.requiresAdmin===true,...(value.adminToken && /^[a-f0-9-]{36}$/.test(value.adminToken)?{adminToken:value.adminToken}:{})};
}
