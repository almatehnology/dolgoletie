import { importOwner, importResponse } from '@/lib/batch-import/http';
import { jobs, jobView } from '@/lib/batch-import/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const owner = await importOwner(request);
    return Response.json(jobView(jobs.get((await context.params).id, owner)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return importResponse(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const owner = await importOwner(request);
    jobs.delete((await context.params).id, owner);
    return new Response(null, { status: 204 });
  } catch (error) { return importResponse(error); }
}
