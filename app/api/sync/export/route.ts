import { requireUser } from '@/lib/auth/guards';
import { exportSyncBundle } from '@/lib/sync/service';
import { syncHttpError } from '@/lib/sync/http';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET() {
  try {
    await requireUser();
    const {buffer,filename}=await exportSyncBundle();
    return new Response(new Uint8Array(buffer),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store','Content-Length':String(buffer.length)}});
  } catch(error) {return syncHttpError(error);}
}
