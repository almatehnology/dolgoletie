import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { SyncError } from './validation';

export function syncResponse(value: unknown,status=200) {return NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});}
export function syncHttpError(error:unknown): Response {
  if(error instanceof Response) return error;
  if(error instanceof SyncError) return syncResponse({error:{code:error.code,message:error.message}},error.status);
  if(error instanceof ZodError) return syncResponse({error:{code:'SYNC_INVALID',message:'Некорректные параметры синхронизации'}},400);
  // Never echo crypto errors/objects: they may contain ephemeral access data.
  return syncResponse({error:{code:'SYNC_FAILED',message:'Синхронизация не выполнена. Проверьте файл, пароль и доступность хранилища.'}},400);
}
export async function readBoundedBody(request:Request,limit:number) {
  if(Number(request.headers.get('content-length') ?? 0)>limit) throw new SyncError('Слишком большой запрос',413);
  const reader=request.body?.getReader(); if(!reader) return Buffer.alloc(0);
  const chunks:Buffer[]=[];let bytes=0;
  try {
    while(true) {const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit) {await reader.cancel();throw new SyncError('Слишком большой запрос',413);}chunks.push(Buffer.from(value));}
    return Buffer.concat(chunks,bytes);
  } finally {reader.releaseLock();}
}
