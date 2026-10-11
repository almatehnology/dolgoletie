import { z } from 'zod';
import { requireUser } from '@/lib/auth/guards';
import { applySyncJob } from '@/lib/sync/service';
import { readBoundedBody,syncHttpError,syncResponse } from '@/lib/sync/http';
import { idSchema } from '@/lib/sync/validation';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const argsSchema=z.object({
  jobId:idSchema,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  decisions:z.record(z.object({action:z.enum(['accept','keep-local','defer']),fields:z.record(z.union([z.string().max(1000000),z.number().finite(),z.boolean(),z.null()])).optional()}).strict()),
  accessDecision:z.object({choice:z.enum(['incoming','local','defer']),localPassword:z.string().max(1024).optional()}).strict().optional(),
}).strict();
export async function POST(request:Request) {
  try {
    const user=await requireUser();
    const args=argsSchema.parse(JSON.parse((await readBoundedBody(request,4*1024*1024)).toString('utf8')));
    return syncResponse(await applySyncJob(args.jobId,`${user.id}:${user.version}`,args.fingerprint,args.decisions,args.accessDecision));
  } catch(error) {return syncHttpError(error);}
}
