import { requireUser } from '@/lib/auth/guards';
import { handleReportExport } from '@/lib/report-export/http';
import { reportRepository } from '@/lib/report-export/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleReportExport(request, {
    authorize: async () => { await requireUser(); },
    repository: reportRepository,
  });
}
