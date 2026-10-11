import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSnapshotHistory,buildMergePlan,evaluateGraph } from '../lib/sync/merge';
import { data,op,person } from './sync-fixtures';
import { addJob,deleteJob,getJob,publicJob } from '../lib/sync/jobs';
import type { Bundle } from '../lib/sync/types';

test('three independent field writes converge in every input order despite skewed clocks',()=>{
  const base=person(),root=op('root',null,base),a=op('a',base,{...base,phone:'111'},['root']),b=op('b',base,{...base,notes:'B'},['root']),c=op('c',base,{...base,birthPlace:'C'},['root']);
  a.createdAt='2000-01-01T00:00:00.000Z';c.createdAt='2099-01-01T00:00:00.000Z';
  for(const order of [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]]) {
    const state=evaluateGraph([root,...order]).records.get('Person:person')!;
    assert.equal(state.registers.get('phone')![0].value,'111');assert.equal(state.registers.get('notes')![0].value,'B');assert.equal(state.registers.get('birthPlace')![0].value,'C');
    assert.equal([...state.registers.values()].filter(v=>v.length>1).length,0);
  }
});
test('initial adoption on another laptop does not turn unchanged fields into concurrent edits',()=>{
  const base=person(),root=op('root',null,base),adoption=op('adoption',null,base,['root']);
  const phone=op('phone',base,{...base,phone:'new phone'},['root']);
  const note=op('note',base,{...base,notes:'local note'},['adoption']);
  const plan=buildMergePlan(data([note.after!],[root,adoption,note]),data([phone.after!],[root,phone])).records[0];
  assert.equal(plan.conflicts.length,0);
  assert.equal(plan.proposed!.phone,'new phone');
  assert.equal(plan.proposed!.notes,'local note');
});
test('A-B-C-A does not repeat rejected scalar conflicts; resolutions reference every head',()=>{
  const base=person(),root=op('root',null,base),a=op('a',base,{...base,phone:'A'},['root']),b=op('b',base,{...base,notes:'B'},['root']);
  const abPlan=buildMergePlan(data([a.after!],[root,a]),data([b.after!],[root,b])).records[0];
  assert.equal(abPlan.conflicts.length,0);const ab=op('ab',a.after,abPlan.proposed,abPlan.heads);
  const c=op('c',base,{...base,phone:'C'},['root']);
  const conflict=buildMergePlan(data([ab.after!],[root,a,b,ab]),data([c.after!],[root,c])).records[0];
  assert.equal(conflict.conflicts[0].field,'phone');assert.deepEqual(conflict.heads,['ab','c']);
  // Keep-local is a no-op scalar image, but causally rejects C.
  const rejection=op('rejection',ab.after,ab.after,conflict.heads);
  const all=[root,a,b,ab,c,rejection],resolved=data([rejection.after!],all);
  assertSnapshotHistory(resolved);
  const receiveOnC=buildMergePlan(data([c.after!],[root,c]),resolved).records[0];
  assert.equal(receiveOnC.conflicts.length,0);assert.equal(receiveOnC.proposed!.phone,'A');
  assert.equal(buildMergePlan(resolved,data([c.after!],[root,c])).records.length,0);
  const newer=op('newer',c.after,{...c.after!,phone:'new-C'},['c']);
  assert.equal(buildMergePlan(resolved,data([newer.after!],[root,c,newer])).records[0].conflicts.length,1);
});
test('deletion requires confirmation without local edits and conflicts with concurrent editing',()=>{
  const base=person(),root=op('root',null,base),deleted=op('delete',base,null,['root']);
  const noEdits=buildMergePlan(data([base],[root]),data([],[root,deleted])).records[0];assert.equal(noEdits.deletion,true);assert.equal(noEdits.conflicts.length,0);
  const edited=op('edit',base,{...base,phone:'111'},['root']);
  const concurrent=buildMergePlan(data([edited.after!],[root,edited]),data([],[root,deleted])).records[0];
  assert.equal(concurrent.deletion,true);assert.equal(concurrent.conflicts.some(f=>f.field==='$exists'),true);
  const keep=op('keep',edited.after,edited.after,concurrent.heads);
  const resolved=data([edited.after!],[root,edited,deleted,keep]);assertSnapshotHistory(resolved);
  assert.equal(buildMergePlan(resolved,data([],[root,deleted])).records.length,0);
});
test('missing snapshot never implies deleting a local record; same names are candidates only',()=>{
  const p=person('local'),q=person('remote'),pRoot=op('p-root',null,p),qRoot=op('q-root',null,q);
  assert.equal(buildMergePlan(data([p],[pRoot]),data([],[])).records.length,0);
  const plan=buildMergePlan(data([p],[pRoot]),data([q],[qRoot]));assert.equal(plan.records[0].entityId,'remote');assert.equal(plan.candidates.length,1);
  const merged=buildMergePlan(data([p],[pRoot]),data([q],[qRoot]),[{source:'remote',target:'local'}]);assert.equal(merged.records[0].entityId,'local');assert.deepEqual(merged.records[0].heads,['p-root','q-root']);
});
test('rejects missing dependencies, mutable IDs, cycles and alias cycles',()=>{
  const p=person(),root=op('root',null,p);
  assert.throws(()=>evaluateGraph([op('bad',p,p,['missing'])]));
  assert.throws(()=>evaluateGraph([root,{...root,after:{...p,phone:'different'}}]));
  assert.throws(()=>evaluateGraph([{...root,parents:['root']}]));
  assert.throws(()=>evaluateGraph([root],[{source:'a',target:'b'},{source:'b',target:'a'}]));
});
test('job previews never serialize root/password and expiry/deletion zero ephemeral key material',()=>{
  const p=person(),fixture=data([p],[op('root',null,p)]);
  const bundle={manifest:{data:{bytes:1}},data:fixture,files:new Map()} as unknown as Bundle;
  function make() {
    const root=Buffer.alloc(32,77),access={root,password:'ephemeral-secret'};
    const job=addJob({owner:'privacy-test',bundle,access,fingerprint:'fingerprint',plan:{records:[],candidates:[],aliases:[]},selectedAliases:[],accessPreview:{required:true,message:'Safe summary',details:access}});
    assert.equal(JSON.stringify(publicJob(job)).includes('ephemeral-secret'),false);
    assert.equal(JSON.stringify(publicJob(job)).includes('root'),false);
    return {job,root,access};
  }
  const first=make();deleteJob(first.job.id,'privacy-test');assert.deepEqual(first.root,Buffer.alloc(32));assert.equal(first.access.password,undefined);assert.equal(first.access.root,undefined);
  const expired=make();expired.job.createdAt=Date.now()-31*60*1000;assert.throws(()=>getJob(expired.job.id,'privacy-test'));assert.deepEqual(expired.root,Buffer.alloc(32));assert.equal(expired.access.password,undefined);
});
