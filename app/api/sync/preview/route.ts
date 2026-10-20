import { z } from 'zod';
import { requireUser } from '@/lib/auth/guards';
import { getJob,publicJob } from '@/lib/sync/jobs';
import { previewSyncBundle,refreshSyncJob } from '@/lib/sync/service';
import { readBoundedBody,syncHttpError,syncResponse } from '@/lib/sync/http';
import { aliasSchema,idSchema,SyncError } from '@/lib/sync/validation';
import { readUploadForm } from '@/lib/http-upload';
import { assertSameOrigin } from '@/lib/auth/errors';
import { ARCHIVE_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } from '@/lib/transfer-limits';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const refresh=z.object({jobId:idSchema,aliases:z.array(aliasSchema).max(1000).optional()}).strict();
export async function POST(request:Request) {
  try {
    assertSameOrigin(request);
    const user=await requireUser(),owner=`${user.id}:${user.version}`;
    if(request.headers.get('content-type')?.includes('application/json')) {
      const args=refresh.parse(JSON.parse((await readBoundedBody(request,1024*1024)).toString('utf8')));
      const job=await refreshSyncJob(getJob(args.jobId,owner),args.aliases);
      return syncResponse(publicJob(job));
    }
    const form=await readUploadForm(request,UPLOAD_REQUEST_MAX_BYTES);
    const file=form.get('file'),password=form.get('password');
    if(!(file instanceof File) || file.size===0 || (password!==null && (typeof password!=='string' || password.length>1024))) throw new SyncError('Выберите файл обмена');
    if(file.size>ARCHIVE_MAX_BYTES) throw new SyncError('Размер файла не должен превышать 1 ГиБ.',413);
    const job=await previewSyncBundle(Buffer.from(await file.arrayBuffer()),owner,typeof password==='string' && password ? password : undefined);
    return syncResponse(publicJob(job));
  } catch(error) {return syncHttpError(error);}
}
