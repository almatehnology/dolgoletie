import test from 'node:test';
import assert from 'node:assert/strict';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { buildBundle,parseBundle } from '../lib/sync/bundle';
import { safeArchivePath,sha256,stable } from '../lib/sync/validation';
import { data,op,person,date } from './sync-fixtures';
async function zip(entries:[string,Buffer][]) {const stream=new PassThrough(),a=archiver('zip');a.pipe(stream);const read=(async()=>{const parts:Buffer[]=[];for await(const p of stream)parts.push(p);return Buffer.concat(parts);})();for(const [name,buffer]of entries)a.append(buffer,{name,store:true});await a.finalize();return read;}
const identity={databaseId:'database',deviceId:'device'};
test('versioned full bundle roundtrip includes original and historical attachment objects',async()=>{
  const p=person(),root=op('root',null,p),fixture=data([p],[root]);
  const file=Buffer.from('%PDF-1.4\nOriginal'),hash=sha256(file);
  const scan={id:'scan',personId:p.id,filename:'паспорт.pdf',storedPath:`sha256:${hash}`,thumbPath:null,mimeType:'application/pdf',sizeBytes:file.length,uploadedAt:date};
  fixture.snapshots.PassportScan.push(scan);fixture.operations.push(op('scan-root',null,scan,[],'PassportScan'));
  const buffer=await buildBundle(fixture,new Map([[hash,file]]),identity),decoded=await parseBundle(buffer);
  assert.deepEqual(decoded.data,fixture);assert.deepEqual(decoded.files.get(hash),file);assert.equal(decoded.manifest.format,'dolgoletie-sync');
});
test('rejects hash corruption, missing originals, extra entries, duplicate paths and future versions',async()=>{
  const p=person(),fixture=data([p],[op('root',null,p)]),buffer=await buildBundle(fixture,new Map(),identity),parsed=await parseBundle(buffer);
  const encoded=Buffer.from(stable(fixture)),manifest=Buffer.from(stable(parsed.manifest));
  await assert.rejects(parseBundle(await zip([['manifest.json',manifest],['data.json',Buffer.from('{}')]])));
  await assert.rejects(parseBundle(await zip([['manifest.json',manifest],['data.json',encoded],['extra.txt',Buffer.from('x')]])));
  await assert.rejects(parseBundle(await zip([['manifest.json',manifest],['data.json',encoded],['data.json',encoded]])));
  await assert.rejects(parseBundle(await zip([['manifest.json',Buffer.from(stable({...parsed.manifest,version:2}))],['data.json',encoded]])));
  const missing={...parsed.manifest,attachments:[{sha256:'a'.repeat(64),path:`attachments/${'a'.repeat(64)}.bin`,bytes:1}]};
  await assert.rejects(parseBundle(await zip([['manifest.json',Buffer.from(stable(missing))],['data.json',encoded]])));
});
test('rejects traversal, absolute, Windows and ambiguous archive paths',()=>{
  for(const path of ['../data.json','/data.json','C:/data.json','folder\\data.json','./data.json','a//b','a/../b','a\0b']) assert.throws(()=>safeArchivePath(path));
});
test('snapshot inconsistency is rejected even when manifest hashes match',async()=>{
  const p=person(),fixture=data([p],[op('root',null,p)]),original=await parseBundle(await buildBundle(fixture,new Map(),identity));
  const bytes=Buffer.from(stable({...fixture,snapshots:{...fixture.snapshots,Person:[{...p,phone:'forged'}]}}));
  const manifest={...original.manifest,data:{path:'data.json',bytes:bytes.length,sha256:sha256(bytes)}};
  await assert.rejects(parseBundle(await zip([['manifest.json',Buffer.from(stable(manifest))],['data.json',bytes]])));
});
