import { z } from 'zod';
import { requireUser } from '@/lib/auth/guards';
import { getJob,publicJob } from '@/lib/sync/jobs';
import { previewSyncBundle,refreshSyncJob } from '@/lib/sync/service';
import { readBoundedBody,syncHttpError,syncResponse } from '@/lib/sync/http';
import { aliasSchema,idSchema,LIMITS,SyncError } from '@/lib/sync/validation';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const refresh=z.object({jobId:idSchema,aliases:z.array(aliasSchema).max(1000).optional()}).strict();
export async function POST(request:Request) {
  try {
    const user=await requireUser(),owner=`${user.id}:${user.version}`;
    if(request.headers.get('content-type')?.includes('application/json')) {
      const args=refresh.parse(JSON.parse((await readBoundedBody(request,1024*1024)).toString('utf8')));
      const job=await refreshSyncJob(getJob(args.jobId,owner),args.aliases);
      return syncResponse(publicJob(job));
    }
    const body=await readBoundedBody(request,LIMITS.bundle+16*1024*1024);
    const form=await new Request(request.url,{method:'POST',headers:{'Content-Type':request.headers.get('content-type')??''},body:new Uint8Array(body)}).formData();
    const file=form.get('file'),password=form.get('password');
    if(!(file instanceof File) || file.size===0 || (password!==null && (typeof password!=='string' || password.length>1024))) throw new SyncError('Выберите файл обмена');
    const job=await previewSyncBundle(Buffer.from(await file.arrayBuffer()),owner,typeof password==='string' && password ? password : undefined);
    return syncResponse(publicJob(job));
  } catch(error) {return syncHttpError(error);}
}
