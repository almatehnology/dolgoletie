import { applyJob } from '@/lib/batch-import/apply';
import { applyRequestSchema, importOwner, importResponse, requestJson } from '@/lib/batch-import/http';
import { withAuthOperation } from '@/lib/auth/mutex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await importOwner(request);
    const data = applyRequestSchema.parse(await requestJson(request));
    const { id } = await context.params;
    return await withAuthOperation(async () => {
      const owner = await importOwner(request);
      return Response.json(await applyJob(owner, id, data.version), { headers: { 'Cache-Control': 'private, no-store' } });
    });
  } catch (error) { return importResponse(error); }
}
