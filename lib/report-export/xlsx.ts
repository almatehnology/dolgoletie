import ExcelJS from 'exceljs';
import { setImmediate } from 'node:timers/promises';
import { assertReportSize, ReportError, type ReportOrientation, type TableReport } from './model';

function characterWidth(character: string): number {
  if (/\s/u.test(character)) return 0.7;
  if (/[MWmw@%ЖЩШЮФжщшюф]/u.test(character)) return 2;
  if ((character.codePointAt(0) ?? 0) >= 0x2e80) return 2.5;
  if (/[0-9]/.test(character)) return 1.1;
  return 1.4;
}

// Column widths are measured in default-font characters, not string.length.
// Conservative glyph widths and word boundaries leave room for font fallback
// in Excel/LibreOffice, which otherwise clips text at a fixed custom row height.
function wrappedLines(text: string, width: number, fontSize = 10): string[] {
  const available = Math.max(1, (width - 2) * 10 / fontSize);
  const measure = (value: string) => Array.from(value).reduce((sum, character) => sum + characterWidth(character), 0);
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n?|\n/)) {
    let line = '';
    let units = 0;
    for (const token of paragraph.match(/\S+|\s+/gu) ?? []) {
      const tokenWidth = measure(token);
      if (units + tokenWidth <= available) {
        line += token;
        units += tokenWidth;
        continue;
      }
      if (line) { lines.push(line); line = ''; units = 0; }
      for (const character of token) {
        const characterUnits = characterWidth(character);
        if (line && units + characterUnits > available) { lines.push(line); line = ''; units = 0; }
        line += character;
        units += characterUnits;
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function generateReportXlsx(report: TableReport, orientation: ReportOrientation): Promise<Buffer> {
  assertReportSize(report);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Долголетие';
  workbook.title = report.title;
  const sheet = workbook.addWorksheet('Отчёт', {
    pageSetup: { paperSize: 9, orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: 'Страница &P из &N' },
  });
  sheet.columns = report.columns.map((column, index) => ({
    width: Math.max(14, Math.min(42, Math.max(column.label.length,
      ...report.rows.slice(0, 100).map((row) => Math.min(row[index].length, 42))) + 2)),
    style: { numFmt: '@', font: { name: 'Arial', size: 10 }, alignment: { vertical: 'top', wrapText: true } },
  }));
  const columns = report.columns.length;
  const fullWidth = sheet.columns.reduce((sum, column) => sum + (column.width ?? 14), 0);
  const mergedHeight = (text: string, size: number) => Math.max(20, wrappedLines(text, fullWidth, size).length * (size + 5) + 5);
  const summaryRows: { text: string; bold: boolean; size: number }[] = [];
  const addMerged = (text: string, bold = false, size = 10) => {
    const row = sheet.addRow([text]);
    if (columns > 1) sheet.mergeCells(row.number, 1, row.number, columns);
    row.getCell(1).font = { name: 'Arial', size, bold };
    row.height = mergedHeight(text, size);
    return row;
  };
  const addSummary = (text: string, bold = false, size = 10) => {
    // Excel caps a printed row at 409 points. Flow long summary text across
    // merged rows instead of clipping it or reserving a separate cover sheet.
    const maxLines = Math.floor(380 / (size + 5));
    const lines = wrappedLines(text, fullWidth, size);
    for (let start = 0; start < lines.length; start += maxLines) summaryRows.push({ text: lines.slice(start, start + maxLines).join('\n'), bold, size });
  };
  addSummary(report.title, true, 14);
  addSummary(report.subtitle);
  report.summary.forEach(({ label, value }) => addSummary(`${label}: ${value}`));
  const labels = report.columns.map((column) => column.label);
  const headerHeight = Math.max(...report.columns.map((column, index) => wrappedLines(column.label, sheet.columns[index].width ?? 14).length)) * 15 + 8;
  const styleHeader = (row: ExcelJS.Row) => {
    row.height = headerHeight;
    row.eachCell((cell) => {
      cell.font = { name: 'Arial', size: 10, bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
    });
  };
  const frozenHeight = summaryRows.reduce((sum, row) => sum + mergedHeight(row.text, row.size), 0) + 8 + headerHeight;
  const useFixedHeading = frozenHeight > 240;
  if (useFixedHeading) {
    // Excel freezes every row above a heading. A long program would fill the
    // whole screen. This compact fixed bar is excluded from the print area;
    // the original summary and table retain their print order.
    styleHeader(sheet.addRow(labels));
  }
  summaryRows.forEach((row) => addMerged(row.text, row.bold, row.size));
  sheet.addRow([]).height = 8;
  const header = sheet.addRow(labels);
  styleHeader(header);
  const headerNumber = header.number;
  for (let index = 0; index < report.rows.length; index++) {
    const values = report.rows[index];
    const height = Math.max(...values.map((value, column) => wrappedLines(value, sheet.columns[column].width ?? 14).length)) * 15 + 5;
    if (height > 409) {
      throw new ReportError('REPORT_LIMIT', 'Текст одного из полей слишком длинный для печатной строки XLSX. Выберите PDF или исключите это поле.', 413);
    }
    const row = sheet.addRow(values);
    row.height = Math.max(20, height);
    row.eachCell({ includeEmpty: true }, (cell) => {
      // String values and the text number format preserve leading zeroes,
      // passports, phone prefixes, and strings starting with =, +, -, or @.
      cell.numFmt = '@';
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E7EB' } } };
    });
    if (index % 100 === 99) await setImmediate();
  }
  if (!report.rows.length) addMerged(report.emptyMessage);
  sheet.views = [{ state: 'frozen', ySplit: useFixedHeading ? 1 : headerNumber, activeCell: `A${headerNumber + 1}` }];
  sheet.autoFilter = { from: { row: headerNumber, column: 1 }, to: { row: headerNumber + report.rows.length, column: columns } };
  sheet.pageSetup.printTitlesRow = `${headerNumber}:${headerNumber}`;
  sheet.pageSetup.printArea = `A${useFixedHeading ? 2 : 1}:${sheet.getColumn(columns).letter}${sheet.rowCount}`;
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  if (buffer.length > 50 * 1024 * 1024) throw new ReportError('REPORT_LIMIT', 'XLSX слишком большой. Разделите экспорт на части.', 413);
  return buffer;
}
