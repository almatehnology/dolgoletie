import { parseReportRequest, ReportError, type ReportFormat, type ReportOrientation, type TableReport } from './model';
import { loadTableReport, type ReportRepository } from './service';
import { generateReportPdf } from './pdf';
import { generateReportXlsx } from './xlsx';
import { safeDownloadName } from '@/lib/file-names';

interface ExportDependencies {
  authorize: () => Promise<unknown>;
  repository: ReportRepository;
  render?: (report: TableReport, format: ReportFormat, orientation: ReportOrientation) => Promise<Buffer>;
}

function errorResponse(error: ReportError): Response {
  return Response.json({ error: { code: error.code, message: error.message } }, {
    status: error.status, headers: { 'Cache-Control': 'private, no-store' },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const limit = 2 * 1024 * 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new ReportError('REPORT_LIMIT', 'Слишком большой запрос экспорта.', 413);
  if (!request.body) throw new ReportError('BAD_REQUEST', 'Укажите параметры отчёта.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ReportError('REPORT_LIMIT', 'Слишком большой запрос экспорта.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ReportError('BAD_REQUEST', 'Некорректный JSON.');
  }
}

export async function handleReportExport(request: Request, dependencies: ExportDependencies): Promise<Response> {
  try {
    await dependencies.authorize();
    const options = parseReportRequest(await readJson(request));
    const report = await loadTableReport(options, dependencies.repository);
    const render = dependencies.render ?? ((data, format, orientation) => format === 'pdf'
      ? generateReportPdf(data, orientation) : generateReportXlsx(data, orientation));
    const buffer = await render(report, options.format, options.orientation);
    const filename = encodeURIComponent(safeDownloadName(report.title, options.format)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': options.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': String(buffer.length),
        'Content-Disposition': `attachment; filename="report.${options.format}"; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    // Authentication guards deliberately throw a Response (401/403/locked).
    if (error instanceof Response) return error;
    if (error instanceof ReportError) return errorResponse(error);
    console.error('[report-export] Failed to generate report');
    return errorResponse(new ReportError('INTERNAL', 'Не удалось сформировать отчёт. Попробуйте ещё раз.', 500));
  }
}
