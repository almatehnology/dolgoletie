import { requireUser } from '@/lib/auth/guards';
import { deleteJob } from '@/lib/sync/jobs';
import { syncHttpError,syncResponse } from '@/lib/sync/http';
export const runtime='nodejs';
export async function DELETE(_request:Request,context:{params:Promise<{id:string}>}) {
  try {const user=await requireUser();deleteJob((await context.params).id,`${user.id}:${user.version}`);return syncResponse({closed:true});}
  catch(error) {return syncHttpError(error);}
}
