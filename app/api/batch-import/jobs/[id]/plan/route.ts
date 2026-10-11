import { importOwner, importResponse, planRequestSchema, requestJson } from '@/lib/batch-import/http';
import { jobs, jobView } from '@/lib/batch-import/jobs';
import { ImportError } from '@/lib/batch-import/limits';
import { buildPlan } from '@/lib/batch-import/plan';
import { readPeople } from '@/lib/batch-import/database';
import { extractRows } from '@/lib/batch-import/rows';
import { duplicateSplitPassportColumns } from '@/lib/batch-import/headers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const owner = await importOwner(request);
    const data = planRequestSchema.parse(await requestJson(request));
    const id = (await context.params).id;
    return await jobs.locked(id, owner, async (job) => {
      if (job.result) throw new ImportError('ALREADY_APPLIED', 'Задание уже сохранено.', 409);
      if (job.revision !== data.revision) throw new ImportError('PLAN_VERSION', 'Задание изменилось. Обновите предварительный просмотр.', 409);
      const next = structuredClone(job);
      if (data.tables) {
        if (new Set(data.tables.map((s) => s.tableId)).size !== data.tables.length) throw new ImportError('TABLE_ID', 'Таблица указана повторно.');
        for (const selection of data.tables) {
          const table = next.tables.find((t) => t.id === selection.tableId);
          if (!table || selection.headerStart > selection.headerEnd || selection.headerEnd > (table.rows.at(-1)?.number ?? 0) || selection.headerEnd - selection.headerStart > 9) throw new ImportError('HEADER_RANGE', 'Недопустимая таблица или диапазон заголовков (до 10 строк).');
          if (selection.included && !selection.columns.some(Boolean)) throw new ImportError('NO_COLUMNS', 'Выберите хотя бы одну колонку в каждой включённой таблице.');
          table.selection = selection;
        }
        next.rowEdits = []; next.decisions = [];
      }
      if (next.tables.some((t) => t.selection.included && duplicateSplitPassportColumns(t.selection.columns).length)) throw new ImportError('DUPLICATE_PASSPORT_COLUMNS', 'Повторные колонки серии или номера паспорта: выберите по одной колонке каждого вида.');
      if (data.rowEdits) {
        const ids = new Set(extractRows(next.tables).map((r) => r.id));
        if (new Set(data.rowEdits.map((e) => e.rowId)).size !== data.rowEdits.length || data.rowEdits.some((e) => !ids.has(e.rowId) || (e.mergeWith && (!ids.has(e.mergeWith) || e.mergeWith === e.rowId)))) throw new ImportError('ROW_ID', 'Недопустимый или повторный идентификатор строки.');
        next.rowEdits = data.rowEdits; next.decisions = [];
      }
      const people = await readPeople();
      if (data.decisions) {
        const allowed = new Set(buildPlan(next, people).groups.map((g) => g.id));
        if (new Set(data.decisions.map((d) => d.groupId)).size !== data.decisions.length || data.decisions.some((d) => !allowed.has(d.groupId))) throw new ImportError('GROUP_ID', 'Решение содержит недопустимую или повторную группу.');
        next.decisions = data.decisions;
      }
      next.revision++;
      next.plan = buildPlan(next, people);
      jobs.checkSize(next);
      Object.assign(job, next);
      return Response.json(jobView(job));
    });
  } catch (error) { return importResponse(error); }
}
