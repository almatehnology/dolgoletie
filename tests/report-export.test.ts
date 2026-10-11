import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {
  buildTableReport, parseReportRequest, reportDate, ReportError, MAX_REPORT_PEOPLE, MAX_CELL_CHARACTERS,
  type EventRecord, type PersonRecord, type ReportRequest,
} from '../lib/report-export/model';
import { loadTableReport, type ReportRepository } from '../lib/report-export/service';
import { handleReportExport } from '../lib/report-export/http';
import { generateReportPdf, wrapPdfText } from '../lib/report-export/pdf';
import { generateReportXlsx } from '../lib/report-export/xlsx';
import {
  exportPreferenceKey, normalizeExportPreferences, loadExportPreferences, saveExportPreferences,
} from '../lib/report-export/preferences';
import { togglePageSelection, togglePersonSelection, selectedOnPageCount } from '../lib/report-export/selection';
import { PERSON_FIELDS } from '../lib/person-fields';

// Pure tests never import the DB/auth layer. The separate repository test sets
// temporary absolute storage paths before dynamically importing either layer.
const people: PersonRecord[] = [{
  id: 'person-1', lastName: 'Иванова', firstName: 'Анна', middleName: 'Сергеевна',
  phone: '+7 001 002 03 04', passportNumber: '0012 000034', birthDate: '1984-02-29',
  passportIssuedAt: new Date('2024-02-29T00:00:00Z'), gender: 'FEMALE',
  registrationAddress: 'Улица Длинная, дом 17', notes: '=HYPERLINK("https://example.com")',
}];
const event: EventRecord = {
  title: 'Осенняя поездка', startDate: '2026-10-11', endDate: '2026-10-12',
  location: 'Мендоса', cost: '1000', currency: 'RUB', program: 'Поездка и прогулка',
  isOutbound: true, accommodationPlace: 'Гостиница', transportType: 'BUS', transportInfo: 'Выезд в 08:00',
  excursions: [{ name: 'Город', cost: '200' }], people,
};
function request(overrides: Record<string, unknown> = {}): ReportRequest {
  return parseReportRequest({
    context: 'people', personIds: ['person-1'], fields: ['lastName', 'birthDate', 'phone', 'passportNumber'],
    format: 'pdf', orientation: 'portrait', ...overrides,
  });
}
function eventRequest(context: 'event-details' | 'event-participants'): ReportRequest {
  return request({ context, personIds: undefined, eventId: 'event-1' });
}
const repository: ReportRepository = {
  findPeople: async () => people,
  findEvent: async () => event,
};
function post(body: unknown): Request {
  return new Request('http://localhost/api/reports/export', { method: 'POST', body: JSON.stringify(body) });
}
const canExtractPdf = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
async function readWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS 4's declaration calls a Node Buffer an ArrayBuffer; its runtime
  // accepts the Node Buffer returned by writeBuffer.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}
async function pdfText(buffer: Buffer, layout = true): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'report-export-pdf-'));
  try {
    const file = join(directory, 'report.pdf');
    await writeFile(file, buffer);
    return execFileSync('pdftotext', [layout ? '-layout' : '-raw', file, '-'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('only registered card fields are accepted; order is preserved and empty/duplicate fields rejected', () => {
  assert.deepEqual(request({ fields: ['passportNumber', 'phone', 'birthDate'] }).fields, ['passportNumber', 'phone', 'birthDate']);
  for (const fields of [[], ['phone', 'phone'], ['paymentStatus'], ['totalDue'], ['scans'], ['__proto__']]) {
    assert.throws(() => request({ fields }), ReportError);
  }
  assert.throws(() => request({ format: 'csv' }), ReportError);
  assert.throws(() => request({ orientation: 'sideways' }), ReportError);
  assert.throws(() => request({ context: 'unknown' }), ReportError);
  assert.throws(() => request({ context: ['people'] }), ReportError);
  assert.throws(() => request({ context: { toString: 'people' } }), ReportError);
  assert.throws(() => request({ limit: 50 }), ReportError);
});

test('people require explicit nonempty IDs; events require an event and never accept a participant subset', () => {
  for (const personIds of [[], undefined, [''], [' a '], [42]]) assert.throws(() => request({ personIds }), ReportError);
  assert.deepEqual(request({ personIds: ['b', 'a', 'b'] }).personIds, ['b', 'a']);
  assert.throws(() => request({ eventId: 'event-1' }), ReportError);
  assert.throws(() => request({ context: 'event-participants', eventId: 'event-1' }), ReportError);
  assert.throws(() => request({ context: 'event-details', personIds: undefined, eventId: '' }), ReportError);
  assert.throws(() => request({ personIds: Array.from({ length: MAX_REPORT_PEOPLE + 1 }, (_, i) => `p${i}`) }),
    (error: unknown) => error instanceof ReportError && error.status === 413);
});

test('birth and passport dates never shift with timezone, and shared model retains text values', () => {
  assert.equal(reportDate('1984-02-29'), '29.02.1984');
  assert.equal(reportDate(new Date('2024-02-29T00:00:00Z')), '29.02.2024');
  const report = buildTableReport(request({ fields: ['passportNumber', 'phone', 'birthDate', 'gender', 'passportIssuedAt'] }), people);
  assert.deepEqual(report.rows[0], ['0012 000034', '+7 001 002 03 04', '29.02.1984', 'Женский', '29.02.2024']);
  assert.deepEqual(report.columns.map((column) => column.label),
    ['Серия и номер паспорта', 'Телефон', 'Дата рождения', 'Пол', 'Дата выдачи паспорта']);
});

test('explicit selection exceeds a UI page and preserves request order', async () => {
  const ids = Array.from({ length: 125 }, (_, i) => `p${i}`);
  const report = await loadTableReport(request({ personIds: ids, fields: ['lastName'] }), {
    ...repository,
    findPeople: async (requested) => {
      assert.deepEqual(requested, ids);
      return [...ids].reverse().map((id) => ({ id, lastName: id }));
    },
  });
  assert.equal(report.rows.length, 125);
  assert.deepEqual(report.rows.map((row) => row[0]), ids);
});

test('deleted/missing selected people fail explicitly rather than producing a partial report', async () => {
  for (const records of [[], [{ ...people[0], deletedAt: '2026-10-11' }]]) {
    await assert.rejects(loadTableReport(request(), { ...repository, findPeople: async () => records }),
      (error: unknown) => error instanceof ReportError && error.code === 'PEOPLE_UNAVAILABLE');
  }
});

test('event contexts include every participant, including archived cards, with distinct summaries', async () => {
  const attendees = [...people, { ...people[0], id: 'archived', lastName: 'Архивный', deletedAt: '2026-10-11' }];
  const repo = { ...repository, findEvent: async () => ({ ...event, people: attendees }) };
  const details = await loadTableReport(eventRequest('event-details'), repo);
  const participants = await loadTableReport(eventRequest('event-participants'), repo);
  assert.equal(details.rows.length, 2);
  assert.deepEqual(details.rows, participants.rows);
  assert.equal(participants.summary.length, 0);
  assert.equal(participants.title, event.title);
  assert.equal(participants.subtitle, '11.10.2026 – 12.10.2026');
  assert.ok(details.summary.some((item) => item.label === 'Программа' && item.value === event.program));
  assert.ok(details.summary.some((item) => item.label === 'Экскурсия'));
  assert.ok(details.summary.some((item) => item.label === 'Транспорт' && item.value === 'Автобус'));
  assert.equal(details.columns.some((column) => /оплат|сумм/i.test(column.label)), false);
  await assert.rejects(loadTableReport(eventRequest('event-details'), { ...repository, findEvent: async () => null }),
    (error: unknown) => error instanceof ReportError && error.status === 404);
});

test('empty events produce a report with columns and an explicit empty-list message', async () => {
  for (const context of ['event-details', 'event-participants'] as const) {
    const report = await loadTableReport(eventRequest(context), { ...repository, findEvent: async () => ({ ...event, people: [] }) });
    assert.equal(report.rows.length, 0);
    assert.equal(report.columns.length, 4);
    assert.match(report.emptyMessage, /нет участников/);
    const workbook = await readWorkbook(await generateReportXlsx(report, 'portrait'));
    assert.ok(workbook.getWorksheet(1)!.getSheetValues().flat(2).includes(report.emptyMessage));
    assert.equal((await generateReportPdf(report, 'portrait')).subarray(0, 5).toString(), '%PDF-');
  }
});

test('format size limits reject long cells and oversized event lists instead of truncating', () => {
  assert.throws(() => buildTableReport(request({ fields: ['notes'] }), [{ id: 'p', notes: 'x'.repeat(MAX_CELL_CHARACTERS + 1) }]),
    (error: unknown) => error instanceof ReportError && error.status === 413);
  const many = Array.from({ length: MAX_REPORT_PEOPLE + 1 }, (_, i) => ({ id: `p${i}` }));
  assert.throws(() => buildTableReport(eventRequest('event-details'), many, { ...event, people: many }), ReportError);
});

test('XLSX values match the common model, preserve zeroes/formula-like strings and contain one sheet and no attachments', async () => {
  const report = buildTableReport(request({ fields: ['phone', 'passportNumber', 'notes', 'birthDate'] }), people);
  for (const orientation of ['portrait', 'landscape'] as const) {
    const buffer = await generateReportXlsx(report, orientation);
    const workbook = await readWorkbook(buffer);
    assert.equal(workbook.worksheets.length, 1);
    const sheet = workbook.getWorksheet(1)!;
    const headerRow = sheet.views[0].state === 'frozen' ? sheet.views[0].ySplit! : 0;
    assert.deepEqual((sheet.getRow(headerRow).values as unknown[]).slice(1), report.columns.map((column) => column.label));
    assert.deepEqual((sheet.getRow(headerRow + 1).values as unknown[]).slice(1), report.rows[0]);
    for (let index = 1; index <= 4; index++) {
      const cell = sheet.getRow(headerRow + 1).getCell(index);
      assert.equal(cell.type, ExcelJS.ValueType.String);
      assert.equal(cell.numFmt, '@');
      assert.equal(cell.alignment.wrapText, true);
    }
    assert.equal(sheet.pageSetup.paperSize, 9);
    assert.equal(sheet.pageSetup.orientation, orientation);
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    assert.equal(sheet.pageSetup.fitToHeight, 0);
    assert.equal(sheet.pageSetup.printTitlesRow, `${headerRow}:${headerRow}`);
    assert.deepEqual(sheet.autoFilter, `A${headerRow}:D${headerRow + 1}`);
    assert.equal(sheet.getImages().length, 0);
    assert.equal(workbook.model.media?.length ?? 0, 0);
  }
});

test('XLSX refuses a cell that cannot be printed in one row and flows long summary across rows', async () => {
  const report = buildTableReport(request({ fields: ['notes'] }), [{ id: 'p', notes: 'длинное поле '.repeat(1000) }]);
  await assert.rejects(generateReportXlsx(report, 'portrait'), (error: unknown) => error instanceof ReportError && error.status === 413);
  const longEvent = { ...event, program: 'Программа '.repeat(2000) };
  const details = buildTableReport(eventRequest('event-details'), people, longEvent);
  const workbook = await readWorkbook(await generateReportXlsx(details, 'landscape'));
  const sheet = workbook.getWorksheet(1)!;
  assert.equal(sheet.views[0].state === 'frozen' ? sheet.views[0].ySplit : 0, 1);
  assert.match(sheet.pageSetup.printArea!, /^A2:/);
  assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), details.columns.map((column) => column.label));
  workbook.getWorksheet(1)!.eachRow((row) => assert.ok((row.height ?? 0) <= 409));
  const firstCells: string[] = [];
  workbook.getWorksheet(1)!.eachRow((row) => firstCells.push(String(row.getCell(1).value ?? '')));
  const texts = firstCells.join('');
  assert.equal(texts.replace(/\n/g, '').includes(longEvent.program), true);
});

test('PDF wrapper handles long unbroken tokens and explicit line breaks with the actual font', () => {
  const doc = new PDFDocument();
  doc.font('assets/fonts/PTSans-Regular.ttf').fontSize(9);
  const token = 'Оченьдлинноенепрерывноезначение'.repeat(100);
  const lines = wrapPdfText(doc, token, 45);
  assert.equal(lines.join(''), token);
  assert.ok(lines.every((line) => doc.widthOfString(line) <= 45.01));
  assert.deepEqual(wrapPdfText(doc, 'Первая\n\nПоследняя', 200), ['Первая', '', 'Последняя']);
  doc.end();
});

test('PDF uses both A4 orientations, repeated table headings, page numbers, and retains a multi-page cell tail', async () => {
  const report = buildTableReport(request({ fields: ['lastName', 'registrationAddress'] }),
    Array.from({ length: 125 }, (_, index) => ({ id: `p${index}`, lastName: `Человек ${index}`,
      registrationAddress: index === 1 ? `${'Длинный адрес '.repeat(1200)}КОНЕЦАДРЕСА` : 'Короткий адрес' })));
  for (const orientation of ['portrait', 'landscape'] as const) {
    const buffer = await generateReportPdf(report, orientation);
    const source = buffer.toString('latin1');
    assert.ok(source.startsWith('%PDF-'));
    const pageCount = (source.match(/\/Type \/Page\b/g) ?? []).length;
    assert.ok(pageCount > 3);
    assert.match(source, orientation === 'portrait' ? /\/MediaBox \[0 0 595\.28 841\.89\]/ : /\/MediaBox \[0 0 841\.89 595\.28\]/);
    assert.equal(source.includes('/Subtype /Image'), false);
    if (canExtractPdf) {
      const text = await pdfText(buffer);
      assert.match(text, /КОНЕЦАДРЕСА/);
      assert.match(text, /Человек 124/);
      assert.ok((text.match(/Фамилия/g) ?? []).length >= pageCount);
      for (let number = 1; number <= pageCount; number++) assert.match(text, new RegExp(`${number} / ${pageCount}`));
    }
  }
});

test('all registered fields fit a portrait PDF and a long program retains its tail', async () => {
  const input = eventRequest('event-details');
  input.fields = PERSON_FIELDS.map((field) => field.key);
  const report = buildTableReport(input, people, { ...event, program: `${'Описание программы '.repeat(1200)}КОНЕЦПРОГРАММЫ` });
  const buffer = await generateReportPdf(report, 'portrait');
  if (canExtractPdf) {
    const text = await pdfText(buffer);
    assert.match(text, /КОНЕЦПРОГРАММЫ/);
    const raw = (await pdfText(buffer, false)).replace(/\s/g, '');
    assert.match(raw, /Иванова/);
    assert.match(text, /0012/);
  }
});

test('short event summary shares the first PDF page with participants', async () => {
  const report = buildTableReport(eventRequest('event-details'), people, event);
  const buffer = await generateReportPdf(report, 'portrait');
  assert.equal((buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, 1);
  if (canExtractPdf) {
    const text = await pdfText(buffer);
    assert.match(text, /Осенняя поездка/);
    assert.match(text, /Поездка и прогулка/);
    assert.match(text, /Иванова/);
  }
});

test('API preserves thrown authentication Responses before parsing or database access', async () => {
  for (const status of [401, 403, 423]) {
    const denied = Response.json({ error: { message: 'Доступ запрещён' } }, { status });
    const response = await handleReportExport(post(request()), {
      authorize: async () => { throw denied; },
      repository: { findPeople: async () => assert.fail('DB must not be read'), findEvent: async () => assert.fail('DB must not be read') },
    });
    assert.equal(response, denied);
  }
});

test('API returns readable validation, missing-people and malformed-body errors', async () => {
  const authorize = async () => undefined;
  const malformed = new Request('http://localhost/api/reports/export', { method: 'POST', body: '{' });
  for (const [body, status] of [[{ ...request(), fields: [] }, 400], [{ ...request(), personIds: [] }, 400]] as const) {
    const response = await handleReportExport(post(body), { authorize, repository });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error.message, 'string');
  }
  assert.equal((await handleReportExport(malformed, { authorize, repository })).status, 400);
  assert.equal((await handleReportExport(post(request()), { authorize, repository: { ...repository, findPeople: async () => [] } })).status, 409);
  assert.equal((await handleReportExport(new Request('http://localhost/', { method: 'POST', body: ' '.repeat(2 * 1024 * 1024 + 1) }), { authorize, repository })).status, 413);
});

test('API downloads each context/format/orientation as a private correctly named file', async () => {
  for (const context of ['people', 'event-details', 'event-participants'] as const) {
    for (const format of ['pdf', 'xlsx'] as const) {
      for (const orientation of ['portrait', 'landscape'] as const) {
        const input = context === 'people' ? request({ format, orientation }) : { ...eventRequest(context), format, orientation };
        const response = await handleReportExport(post(input), { authorize: async () => undefined, repository });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.match(response.headers.get('content-disposition')!, new RegExp(`\\.${format}`));
        assert.equal(response.headers.get('content-type'), format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const buffer = Buffer.from(await response.arrayBuffer());
        assert.ok(buffer.length > 1000);
        assert.equal(response.headers.get('content-length'), String(buffer.length));
      }
    }
  }
});

test('page/search selection preserves other pages and reports actual page counts', () => {
  const first = Array.from({ length: 50 }, (_, i) => `p${i}`);
  const second = Array.from({ length: 50 }, (_, i) => `p${i + 50}`);
  let selected = togglePageSelection(new Set(), first);
  selected = togglePageSelection(selected, second);
  assert.equal(selected.size, 100);
  assert.equal(selectedOnPageCount(selected, ['not-found', 'p5']), 1);
  selected = togglePersonSelection(selected, 'new-search-result');
  selected = togglePageSelection(selected, second);
  assert.equal(selected.size, 51);
  assert.ok(selected.has('new-search-result'));
  assert.ok(first.every((id) => selected.has(id)));
  assert.equal(selectedOnPageCount(selected, second), 0);
  assert.deepEqual(togglePageSelection(selected, []), selected);
});

test('API filenames sanitize paths and preserve Unicode code points at the length limit', async () => {
  const title = `${'а'.repeat(99)}🌎/\nотчёт`;
  const response = await handleReportExport(post(eventRequest('event-details')), {
    authorize: async () => undefined,
    repository: { ...repository, findEvent: async () => ({ ...event, title }) },
    render: async () => Buffer.from('report'),
  });
  assert.equal(response.status, 200);
  const filename = decodeURIComponent(response.headers.get('content-disposition')!.split("UTF-8''")[1]);
  assert.ok(Buffer.byteLength(filename, 'utf8') <= 180);
  assert.ok(filename.endsWith('.pdf'));
  assert.ok(!/[\\/\n\uFFFD]/.test(filename));
});

test('preferences normalize obsolete fields and separate all contexts and user/database scopes', () => {
  assert.deepEqual(normalizeExportPreferences({ fields: ['phone', 'obsolete', 'phone', 'birthDate'], format: 'xlsx', orientation: 'landscape' }),
    { fields: ['phone', 'birthDate'], format: 'xlsx', orientation: 'landscape' });
  assert.ok(normalizeExportPreferences({ fields: [] }).fields.length > 0);
  assert.notEqual(exportPreferenceKey('people'), exportPreferenceKey('event-details'));
  assert.notEqual(exportPreferenceKey('event-details'), exportPreferenceKey('event-participants'));
  assert.notEqual(exportPreferenceKey('people', 'user1/db1'), exportPreferenceKey('people', 'user2/db1'));
  assert.notEqual(exportPreferenceKey('people', 'user1/db1'), exportPreferenceKey('people', 'user1/db2'));
  const storage = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  } });
  try {
    const preferences = { fields: ['phone'] as const, format: 'xlsx' as const, orientation: 'landscape' as const };
    saveExportPreferences('people', { ...preferences, fields: [...preferences.fields] }, 'user/db');
    assert.deepEqual(loadExportPreferences('people', 'user/db').fields, ['phone']);
    assert.equal(loadExportPreferences('event-details', 'user/db').format, 'pdf');
    storage.set(exportPreferenceKey('people', 'broken'), 'invalid JSON');
    assert.ok(loadExportPreferences('people', 'broken').fields.length > 0);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw new Error('Blocked'); } } });
    assert.doesNotThrow(() => saveExportPreferences('people', normalizeExportPreferences(null)));
    assert.ok(loadExportPreferences('people').fields.length > 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
