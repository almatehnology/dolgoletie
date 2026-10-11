import archiver from 'archiver';
import unzipper from 'unzipper';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { assertSnapshotHistory } from './merge';
import { ENTITIES, type Bundle, type BundleManifest, type SyncData } from './types';
import { dataSchema, LIMITS, manifestSchema, safeArchivePath, sha256, stable, SyncError, validateSnapshot } from './validation';

async function boundedRead(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > limit) { (stream as PassThrough).destroy(); throw new SyncError('Превышен допустимый размер файла обмена', 413); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

export async function buildBundle(data: SyncData, files: Map<string, Buffer>, identity: { databaseId: string; deviceId: string }): Promise<Buffer> {
  const encoded = Buffer.from(stable(data));
  if (encoded.length > LIMITS.json || files.size > LIMITS.entries - 2) throw new SyncError('История превышает допустимый размер файла обмена', 413);
  assertSnapshotHistory(data);
  const attachments = [...files].sort(([a],[b]) => a.localeCompare(b)).map(([hash,buffer]) => {
    if (sha256(buffer) !== hash || buffer.length > LIMITS.attachment || !buffer.length) throw new SyncError('Некорректное вложение');
    return { sha256: hash, bytes: buffer.length, path: `attachments/${hash}.bin` };
  });
  if (encoded.length + attachments.reduce((sum,f) => sum + f.bytes,0) > LIMITS.expanded) throw new SyncError('Слишком большой файл обмена',413);
  const manifest: BundleManifest = {
    format: 'dolgoletie-sync', version: 1, schemaVersion: 1, bundleId: randomUUID(), ...identity,
    createdAt: new Date().toISOString(), data: { path: 'data.json', bytes: encoded.length, sha256: sha256(encoded) }, attachments,
  };
  const stream = new PassThrough(), zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', err => stream.destroy(err)); zip.on('warning', err => stream.destroy(err)); zip.pipe(stream);
  const read = boundedRead(stream, LIMITS.bundle);
  zip.append(Buffer.from(stable(manifest)), { name: 'manifest.json', store: true });
  zip.append(encoded, { name: 'data.json', store: true });
  for (const attachment of attachments) zip.append(files.get(attachment.sha256)!, { name: attachment.path, store: true });
  try { await zip.finalize(); return await read; }
  catch (error) { zip.abort(); stream.destroy(); await read.catch(() => undefined); throw error; }
}

function checkZipDirectory(buffer: Buffer) {
  if (buffer.length > LIMITS.bundle || buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new SyncError('Не поддерживается такой файл обмена', buffer.length > LIMITS.bundle ? 413 : 400);
  let end = -1;
  for (let i = buffer.length-22; i >= Math.max(0,buffer.length-65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i+22+buffer.readUInt16LE(i+20) === buffer.length) { end=i; break; }
  }
  if (end < 0) throw new SyncError('Повреждён ZIP');
  const count = buffer.readUInt16LE(end+10), size = buffer.readUInt32LE(end+12), offset = buffer.readUInt32LE(end+16);
  if (buffer.readUInt16LE(end+4) || buffer.readUInt16LE(end+6) || buffer.readUInt16LE(end+8)!==count || count > LIMITS.entries || count < 2 || offset+size!==end) throw new SyncError('Недопустимая структура ZIP');
  let cursor=offset;
  for(let i=0;i<count;i++) {
    if(cursor+46>end || buffer.readUInt32LE(cursor)!==0x02014b50) throw new SyncError('Повреждён каталог ZIP');
    const compressed = buffer.readUInt32LE(cursor+20), expanded=buffer.readUInt32LE(cursor+24), localOffset=buffer.readUInt32LE(cursor+42);
    const flags=buffer.readUInt16LE(cursor+8), method=buffer.readUInt16LE(cursor+10), unixType=(buffer.readUInt32LE(cursor+38)>>>16)&0xf000;
    if ((flags&1) || ![0,8].includes(method) || unixType===0xa000 || expanded > LIMITS.json || localOffset+30>offset || compressed>LIMITS.bundle) throw new SyncError('Недопустимый объект ZIP');
    if(buffer.readUInt32LE(localOffset)!==0x04034b50) throw new SyncError('Повреждён заголовок ZIP');
    const nameBytes=buffer.readUInt16LE(cursor+28), extra=buffer.readUInt16LE(cursor+30), comment=buffer.readUInt16LE(cursor+32);
    const localName=buffer.readUInt16LE(localOffset+26), localExtra=buffer.readUInt16LE(localOffset+28);
    if(localOffset+30+localName+localExtra+compressed>offset || !buffer.subarray(cursor+46,cursor+46+nameBytes).equals(buffer.subarray(localOffset+30,localOffset+30+localName))) throw new SyncError('Несогласованные пути ZIP');
    cursor += 46+nameBytes+extra+comment;
  }
  if(cursor!==end) throw new SyncError('Повреждён каталог ZIP');
}

export async function parseBundle(payload: Buffer): Promise<Bundle> {
  checkZipDirectory(payload);
  const directory = await unzipper.Open.buffer(payload);
  const entries = new Map<string, typeof directory.files[number]>(); let expanded=0;
  for(const entry of directory.files) {
    safeArchivePath(entry.path);
    if(entry.type !== 'File' || entries.has(entry.path)) throw new SyncError('Повторяющийся путь или каталог в ZIP');
    expanded += entry.uncompressedSize;
    if(expanded > LIMITS.expanded) throw new SyncError('Превышен размер распакованного архива',413);
    entries.set(entry.path,entry);
  }
  const manifestEntry=entries.get('manifest.json');
  if(!manifestEntry) throw new SyncError('Это не файл ручной синхронизации');
  let manifest: BundleManifest;
  try { manifest=manifestSchema.parse(JSON.parse((await boundedRead(manifestEntry.stream(),4*1024*1024)).toString('utf8'))); }
  catch(error) { if(error instanceof SyncError) throw error; throw new SyncError('Неизвестная версия или повреждённый манифест. Обновите приложение.'); }
  const expected = [manifest.data,...manifest.attachments];
  if(expected.length+1!==entries.size || new Set(expected.map(e=>e.path)).size!==expected.length) throw new SyncError('Список файлов не соответствует манифесту');
  const decoded = new Map<string,Buffer>();
  for(const descriptor of expected) {
    safeArchivePath(descriptor.path);
    if(descriptor.path!=='data.json' && descriptor.path!==`attachments/${descriptor.sha256}.bin`) throw new SyncError('Недопустимый путь вложения');
    const entry=entries.get(descriptor.path);
    if(!entry || entry.uncompressedSize!==descriptor.bytes) throw new SyncError('Обязательный файл отсутствует или имеет другой размер');
    const buffer=await boundedRead(entry.stream(),descriptor.bytes);
    if(buffer.length!==descriptor.bytes || sha256(buffer)!==descriptor.sha256) throw new SyncError('Проверка целостности файла не пройдена');
    decoded.set(descriptor.path,buffer);
  }
  let data: SyncData;
  try { data=dataSchema.parse(JSON.parse(decoded.get('data.json')!.toString('utf8'))) as SyncData; }
  catch { throw new SyncError('Повреждённые или неподдерживаемые данные обмена'); }
  const files=new Map(manifest.attachments.map(f=>[f.sha256,decoded.get(f.path)!]));
  if(files.size!==manifest.attachments.length) throw new SyncError('Повторяющееся вложение');
  const snapshots=[...ENTITIES.flatMap(e=>data.snapshots[e].map(s=>({entity:e,snapshot:s}))), ...data.operations.flatMap(o=>[o.before,o.after].filter(s=>s!==null).map(s=>({entity:o.entity,snapshot:s!})))];
  for(const {entity,snapshot} of snapshots) {
    validateSnapshot(entity,snapshot);
    if(entity==='PassportScan') {
      const file=files.get(String(snapshot.storedPath).slice(7));
      if(!file || file.length!==snapshot.sizeBytes) throw new SyncError('Отсутствует обязательный оригинал вложения');
    }
  }
  for(const op of data.operations) if((op.before && op.before.id!==op.entityId) || (op.after && op.after.id!==op.entityId) || (!op.before && !op.after && !op.parents.length)) throw new SyncError('Некорректный объект операции');
  assertSnapshotHistory(data);
  return {manifest,data,files,digest:sha256(stable(manifest))};
}
