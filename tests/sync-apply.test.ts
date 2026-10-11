import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { SyncJob } from '../lib/sync/jobs';
import type { Decisions, Snapshot, SyncData } from '../lib/sync/types';
import { emptySnapshots } from '../lib/sync/types';
import { buildBundle, parseBundle } from '../lib/sync/bundle';
import { buildMergePlan, evaluateGraph } from '../lib/sync/merge';
import { date, data as fixtureData, op, person } from './sync-fixtures';

let directory:string, prisma:PrismaClient, service:typeof import('../lib/sync/service'), state:typeof import('../lib/sync/state');
let journal:typeof import('../lib/sync/journal'), serial=0;
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'tdb-sync-'));
  // These values MUST precede imports of database/auth/vault/upload modules.
  process.env.DATABASE_URL=`file:${join(directory,'data.db')}`;process.env.DATA_DIR=directory;process.env.UPLOADS_DIR=join(directory,'uploads');
  prisma=(await import('../lib/db')).prisma;service=await import('../lib/sync/service');state=await import('../lib/sync/state');journal=await import('../lib/sync/journal');
  const {registerSyncAccessIntegration}=await import('../lib/sync/access');
  registerSyncAccessIntegration({preview:async()=>null,apply:async()=>({status:'unchanged'})});
});
after(async()=>{await prisma?.$disconnect();if(directory)await rm(directory,{recursive:true,force:true});});
afterEach(async()=>{const {clearOwnerJobs}=await import('../lib/sync/jobs');clearOwnerJobs('owner');});
async function capture(){return journal.withoutJournal(()=>prisma.$transaction(tx=>state.captureState(tx)));}
async function createPerson(){return await prisma.person.create({data:{lastName:`Фамилия${++serial}`,firstName:'Иван',phone:'base'}});}
async function incoming(id:string,mutate:(snapshot:Snapshot)=>Snapshot|null) {
  const local=await capture(),before=local.data.snapshots.Person.find(p=>p.id===id)!;
  const heads=evaluateGraph(local.data.operations,local.data.aliases).records.get(`Person:${id}`)!.heads;
  const change=op(`remote-${++serial}`,before,mutate(before),heads);
  const data:SyncData={...local.data,snapshots:{...local.data.snapshots,Person:local.data.snapshots.Person.filter(p=>p.id!==id)},operations:[...local.data.operations,change]};
  if(change.after)data.snapshots.Person.push(change.after);
  return {data,change,buffer:await buildBundle(data,local.files,{databaseId:local.databaseId,deviceId:'other-laptop'})};
}
function decisions(job:SyncJob,action:'accept'|'keep-local'|'defer'):Decisions {return Object.fromEntries(job.plan.records.map(r=>[r.key,{action}]));}

test('empty installation adopts shared database identity while keeping a distinct instance ID',async()=>{
  const p=person('seed-person'),remote=fixtureData([p],[op('seed-op',null,p)]);
  const buffer=await buildBundle(remote,new Map(),{databaseId:'shared-origin',deviceId:'seed-device'}),job=await service.previewSyncBundle(buffer,'owner');
  await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept'));
  assert.equal((await capture()).databaseId,'shared-origin');assert.notEqual(await journal.getInstanceId(),'seed-device');
});

test('SQL apply merges independent fields, persists all graph heads and is receipt-idempotent',async()=>{
  const p=await createPerson(),remote=await incoming(p.id,s=>({...s,notes:'from-B'}));
  await prisma.person.update({where:{id:p.id},data:{phone:'from-A'}});
  const job=await service.previewSyncBundle(remote.buffer,'owner');
  assert.equal(job.plan.records[0].conflicts.length,0);
  const report=await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept'));
  assert.equal(report.complete,true);
  const merged=await prisma.person.findUniqueOrThrow({where:{id:p.id}});assert.equal(merged.phone,'from-A');assert.equal(merged.notes,'from-B');
  const count=await prisma.changeOperation.count();
  const replay=await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept'));
  assert.equal(replay.replayed,true);assert.equal(await prisma.changeOperation.count(),count);
  const local=await capture();const replayPlan=buildMergePlan(local.data,remote.data);assert.equal(replayPlan.records.length,0);
});
test('deferred operations are NOT acknowledged; explicit keep-local resolves rejected conflicts permanently',async()=>{
  const p=await createPerson(),remote=await incoming(p.id,s=>({...s,phone:'from-B'}));
  await prisma.person.update({where:{id:p.id},data:{phone:'from-A'}});
  let job=await service.previewSyncBundle(remote.buffer,'owner');assert.equal(job.plan.records[0].conflicts[0].field,'phone');
  const report=await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'defer'));assert.equal(report.complete,false);assert.equal(report.deferred,1);
  assert.equal(await prisma.changeOperation.findUnique({where:{id:remote.change.id}}),null);
  job=await service.refreshSyncJob(job);assert.equal(job.plan.records.length,1);
  const keep=await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'keep-local'));assert.equal(keep.complete,true);
  assert.equal((await prisma.person.findUniqueOrThrow({where:{id:p.id}})).phone,'from-A');
  const again=await service.previewSyncBundle(remote.buffer,'owner');assert.equal(again.plan.records.length,0);
});
test('every remote delete requires explicit confirmation even without local changes',async()=>{
  const p=await createPerson(),remote=await incoming(p.id,()=>null),job=await service.previewSyncBundle(remote.buffer,'owner');
  assert.equal(job.plan.records[0].deletion,true);
  await assert.rejects(service.applySyncJob(job.id,'owner',job.fingerprint,{}),/явного решения/);
  assert.notEqual(await prisma.person.findUnique({where:{id:p.id}}),null);
  const report=await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept'));assert.equal(report.complete,true);assert.equal(await prisma.person.findUnique({where:{id:p.id}}),null);
});
test('stale preview and forged job owner cannot mutate data',async()=>{
  const p=await createPerson(),remote=await incoming(p.id,s=>({...s,notes:'B'})),job=await service.previewSyncBundle(remote.buffer,'owner');
  await assert.rejects(service.applySyncJob(job.id,'another-owner',job.fingerprint,decisions(job,'accept')));
  await prisma.person.update({where:{id:p.id},data:{phone:'new local'}});
  await assert.rejects(service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept')),/изменились/);
  assert.equal((await prisma.person.findUniqueOrThrow({where:{id:p.id}})).notes,null);
});
test('new photo/document original is staged through upload helpers and history can be exported again',async()=>{
  const p=await createPerson(),local=await capture(),pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
  const {sha256}=await import('../lib/sync/validation');const hash=sha256(pdf);
  const scan:Snapshot={id:`scan-${++serial}`,personId:p.id,filename:'документ.pdf',storedPath:`sha256:${hash}`,thumbPath:null,mimeType:'application/pdf',sizeBytes:pdf.length,uploadedAt:date};
  const data:SyncData={...local.data,snapshots:{...local.data.snapshots,PassportScan:[...local.data.snapshots.PassportScan,scan]},operations:[...local.data.operations,op(`scan-op-${++serial}`,null,scan,[],'PassportScan')]};
  const files=new Map(local.files);files.set(hash,pdf);
  const buffer=await buildBundle(data,files,{databaseId:local.databaseId,deviceId:'B'}),job=await service.previewSyncBundle(buffer,'owner');
  await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept'));
  const stored=await prisma.passportScan.findUniqueOrThrow({where:{id:scan.id}});assert.notEqual(stored.storedPath,scan.storedPath);
  const {readScanFile}=await import('../lib/uploads');assert.deepEqual(await readScanFile(stored.storedPath),pdf);
  const exported=await service.exportSyncBundle(),{decodeVaultBundle}=await import('../lib/crypto/bundle');
  const parsed=await parseBundle((await decodeVaultBundle(exported.buffer)).payload);assert.deepEqual(parsed.files.get(hash),pdf);
});
test('manual alias persists identity and survives export plus future edits of the original ID',async()=>{
  const p=await createPerson(),local=await capture(),source={...local.data.snapshots.Person.find(s=>s.id===p.id)!,id:`independent-${++serial}`};
  const remote:SyncData={snapshots:{...emptySnapshots(),Person:[source]},operations:[op(`source-root-${++serial}`,null,source)],aliases:[]};
  // Independent database: omitted records never imply deletion.
  const buffer=await buildBundle(remote,new Map(),{databaseId:'independent-database',deviceId:'B'});
  let job=await service.previewSyncBundle(buffer,'owner');assert.ok(job.plan.candidates.some(c=>c.localId===p.id&&c.incomingId===source.id));
  job=await service.refreshSyncJob(job,[{source:source.id,target:p.id}]);
  await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept'));
  const stored=await capture();assert.ok(stored.data.aliases.some(a=>a.source===source.id&&a.target===p.id));assert.equal(await prisma.person.findUnique({where:{id:source.id}}),null);
  const changed=op(`source-edit-${++serial}`,source,{...source,phone:'future'},[remote.operations[0].id]);
  const later:SyncData={...remote,snapshots:{...remote.snapshots,Person:[changed.after!]},operations:[...remote.operations,changed]};
  const plan=buildMergePlan(stored.data,later);assert.equal(plan.records[0].entityId,p.id);assert.equal(plan.records[0].conflicts[0].field,'phone');
});
test('post-commit access failure stays pending and retries completion without replaying record mutations',async()=>{
  const {registerSyncAccessIntegration}=await import('../lib/sync/access');let calls=0;
  registerSyncAccessIntegration({preview:async()=>({required:true,message:'Access'}),apply:async()=>({status:'applied'}),postCommit:async()=>{if(++calls===1)throw new Error('interrupted');return {status:'applied'};}});
  const p=await createPerson(),remote=await incoming(p.id,s=>({...s,notes:'with access'})),job=await service.previewSyncBundle(remote.buffer,'owner');
  const args={choice:'incoming' as const};
  const pending=await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept'),args);assert.equal(pending.complete,false);assert.equal(pending.access?.status,'pending');
  const count=await prisma.changeOperation.count(),done=await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept'),args);
  assert.equal(done.complete,true);assert.equal(await prisma.changeOperation.count(),count);
  registerSyncAccessIntegration({preview:async()=>null,apply:async()=>({status:'unchanged'})});
});
test('independently created participation IDs for the same pair require selection without unique-key failure',async()=>{
  const p=await createPerson(),event=await prisma.event.create({data:{title:'Экскурсия',location:'Место',startDate:new Date(date),endDate:new Date(date)}}),base=await capture();
  const incomingPart:Snapshot={id:`part-B-${++serial}`,personId:p.id,eventId:event.id,paymentStatus:'UNPAID',prepaidAmount:null,totalDue:null,notes:null,createdAt:date};
  const localPart=await prisma.participation.create({data:{personId:p.id,eventId:event.id}});
  const remote:SyncData={...base.data,snapshots:{...base.data.snapshots,Participation:[...base.data.snapshots.Participation,incomingPart]},operations:[...base.data.operations,op(`part-root-${++serial}`,null,incomingPart,[],'Participation')]};
  const job=await service.previewSyncBundle(await buildBundle(remote,base.files,{databaseId:base.databaseId,deviceId:'B'}),'owner');assert.ok(job.plan.records[0].constraint);
  await assert.rejects(service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept')),/два участия/);
  const kept=await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'keep-local'));assert.equal(kept.complete,true);
  assert.notEqual(await prisma.participation.findUnique({where:{id:localPart.id}}),null);assert.equal(await prisma.participation.findUnique({where:{id:incomingPart.id}}),null);
});
test('a parent delete cannot silently cascade onto newly created local or deferred relations',async()=>{
  const p=await createPerson(),event=await prisma.event.create({data:{title:'Новое мероприятие',location:'Место',startDate:new Date(date),endDate:new Date(date)}}),remote=await incoming(p.id,()=>null);
  const child=await prisma.participation.create({data:{personId:p.id,eventId:event.id}}),job=await service.previewSyncBundle(remote.buffer,'owner');
  await assert.rejects(service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'accept')),/сохранённые связи/);
  assert.notEqual(await prisma.participation.findUnique({where:{id:child.id}}),null);assert.notEqual(await prisma.person.findUnique({where:{id:p.id}}),null);
  assert.equal(await prisma.changeOperation.findUnique({where:{id:remote.change.id}}),null);
  await service.applySyncJob(job.id,'owner',job.fingerprint,decisions(job,'keep-local'));
});
test('deferring a new person also defers dependent scan/participation operations without acknowledgement',async()=>{
  const base=await capture(),p={...base.data.snapshots.Person[0],id:`deferred-person-${++serial}`},event=base.data.snapshots.Event[0];
  const part:Snapshot={id:`deferred-part-${++serial}`,personId:p.id,eventId:event.id,paymentStatus:'UNPAID',prepaidAmount:null,totalDue:null,notes:null,createdAt:date};
  const personOp=op(`deferred-person-op-${++serial}`,null,p),partOp=op(`deferred-part-op-${++serial}`,null,part,[],'Participation');
  const remote:SyncData={...base.data,snapshots:{...base.data.snapshots,Person:[...base.data.snapshots.Person,p],Participation:[...base.data.snapshots.Participation,part]},operations:[...base.data.operations,personOp,partOp]};
  const job=await service.previewSyncBundle(await buildBundle(remote,base.files,{databaseId:base.databaseId,deviceId:'B'}),'owner'),choices=decisions(job,'accept');choices[`Person:${p.id}`]={action:'defer'};
  const report=await service.applySyncJob(job.id,'owner',job.fingerprint,choices);assert.equal(report.deferred,2);assert.equal(report.complete,false);
  assert.equal(await prisma.changeOperation.findUnique({where:{id:personOp.id}}),null);assert.equal(await prisma.changeOperation.findUnique({where:{id:partOp.id}}),null);
});
test('pending admin mode change exposes only a safe token, stays incomplete and does not create repeated transfers',async()=>{
  const {registerSyncAccessIntegration}=await import('../lib/sync/access');let needed=true,calls=0;
  const token='11111111-1111-1111-1111-111111111111';
  registerSyncAccessIntegration({preview:async()=>needed?{required:true,message:'Admin needed'}:null,apply:async()=>({status:'applied'}),postCommit:async()=>{calls++;return needed?{status:'pending',requiresAdmin:true,adminToken:token}:{status:'applied'};}});
  const base=await capture(),buffer=await buildBundle(base.data,base.files,{databaseId:base.databaseId,deviceId:'B'}),job=await service.previewSyncBundle(buffer,'owner');
  const pending=await service.applySyncJob(job.id,'owner',job.fingerprint,{}, {choice:'incoming'});assert.equal(pending.complete,false);assert.equal(pending.access?.adminToken,token);
  const repeat=await service.applySyncJob(job.id,'owner',job.fingerprint,{}, {choice:'incoming'});assert.equal(repeat.access?.requiresAdmin,true);assert.equal(calls,1);
  needed=false;const completed=await service.applySyncJob(job.id,'owner',job.fingerprint,{}, {choice:'incoming'});assert.equal(completed.complete,true);assert.equal(calls,2);
  registerSyncAccessIntegration({preview:async()=>null,apply:async()=>({status:'unchanged'})});
});
