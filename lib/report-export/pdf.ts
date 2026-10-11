import PDFDocument from 'pdfkit';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { assertReportSize, ReportError, type ReportOrientation, type TableReport } from './model';

const MARGIN = 36;
const PADDING = 4;
const MAX_PAGES = 500;
const MAX_BYTES = 50 * 1024 * 1024;

/** Wrap with the actual embedded font, including tokens wider than a column. */
export function wrapPdfText(doc: PDFKit.PDFDocument, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    const words = paragraph.match(/\S+|\s+/gu) ?? [];
    for (const word of words) {
      if (doc.widthOfString(line + word) <= width) {
        line += word;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = '';
      if (!word.trim()) continue;
      if (doc.widthOfString(word) <= width) {
        line = word;
      } else {
        // Iterate code points so a split never damages a surrogate pair.
        for (const character of word) {
          if (line && doc.widthOfString(line + character) > width) {
            lines.push(line);
            line = '';
          }
          line += character;
        }
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function columnWidths(report: TableReport, available: number): number[] {
  const minimums = report.columns.map((column) => column.type === 'date' ? 46 : column.type === 'gender' ? 36 : 24);
  const minimumTotal = minimums.reduce((a, b) => a + b, 0);
  const scale = Math.min(1, available / minimumTotal);
  const weights = report.columns.map((column, index) => {
    const values = report.rows.slice(0, 100).map((row) => row[index].length);
    const typical = values.length ? values.reduce((a, b) => a + Math.min(b, 100), 0) / values.length : 12;
    return Math.sqrt(Math.max(column.label.length, Math.min(typical, 45)));
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((weight, index) => minimums[index] * scale + Math.max(0, available - minimumTotal) * weight / sum);
}

export async function generateReportPdf(report: TableReport, orientation: ReportOrientation): Promise<Buffer> {
  assertReportSize(report);
  const doc = new PDFDocument({
    size: 'A4', layout: orientation, margin: MARGIN, bufferPages: true,
    info: { Title: report.title, Creator: 'Долголетие', Producer: 'Долголетие' },
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let outputError: Error | undefined;
  doc.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) outputError ??= new ReportError('REPORT_LIMIT', 'PDF слишком большой. Разделите экспорт на части.', 413);
    if (!outputError) chunks.push(chunk);
  });
  const finished = new Promise<Buffer>((resolveBuffer, reject) => {
    doc.on('end', () => outputError ? reject(outputError) : resolveBuffer(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  // A drawing failure must not leave a rejected stream promise unobserved.
  void finished.catch(() => undefined);
  try {
    doc.registerFont('ReportRegular', resolve(process.cwd(), 'assets/fonts/PTSans-Regular.ttf'));
    doc.registerFont('ReportBold', resolve(process.cwd(), 'assets/fonts/PTSans-Bold.ttf'));
    doc.font('ReportRegular').fillColor('#1a1a1a');
    const width = doc.page.width - MARGIN * 2;
    const bottom = () => doc.page.height - MARGIN - 12;
    let pages = 1;
    const newPage = () => {
      if (++pages > MAX_PAGES) throw new ReportError('REPORT_LIMIT', `PDF содержит больше ${MAX_PAGES} страниц. Разделите экспорт на части.`, 413);
      doc.addPage();
      doc.y = MARGIN;
    };
    const flowText = (text: string, size: number, bold = false) => {
      doc.font(bold ? 'ReportBold' : 'ReportRegular').fontSize(size);
      const height = doc.currentLineHeight(true) + 1;
      for (const line of wrapPdfText(doc, text, width)) {
        if (doc.y + height > bottom()) newPage();
        const y = doc.y;
        doc.text(line, MARGIN, y, { lineBreak: false });
        doc.y = y + height;
      }
    };
    flowText(report.title, 16, true);
    doc.y += 3;
    flowText(report.subtitle, 10);
    doc.y += 8;
    for (const item of report.summary) {
      flowText(`${item.label}: ${item.value}`, 9);
      doc.y += 3;
    }
    if (report.summary.length) doc.y += 6;

    const widths = columnWidths(report, width);
    const size = report.columns.length <= 5 ? 9 : report.columns.length <= 9 ? 8 : 7.5;
    doc.font('ReportRegular').fontSize(size);
    const lineHeight = doc.currentLineHeight(true) + 1;
    doc.font('ReportBold');
    const headings = report.columns.map((column, index) => wrapPdfText(doc, column.label, widths[index] - PADDING * 2));
    const headingHeight = Math.max(...headings.map((lines) => lines.length)) * lineHeight + PADDING * 2;
    const drawCells = (cells: string[][], height: number, header: boolean) => {
      const y = doc.y;
      let x = MARGIN;
      cells.forEach((lines, index) => {
        if (header) doc.rect(x, y, widths[index], height).fill('#eef2ff');
        doc.strokeColor('#d1d5db').lineWidth(0.4).rect(x, y, widths[index], height).stroke();
        doc.fillColor('#1a1a1a').font(header ? 'ReportBold' : 'ReportRegular').fontSize(size);
        lines.forEach((line, offset) => doc.text(line, x + PADDING, y + PADDING + offset * lineHeight, { lineBreak: false }));
        x += widths[index];
      });
      doc.y = y + height;
    };
    let bodyStart = 0;
    const drawHeadings = () => {
      if (doc.y + headingHeight + lineHeight + PADDING * 2 > bottom()) newPage();
      drawCells(headings, headingHeight, true);
      bodyStart = doc.y;
    };
    const nextTablePage = () => { newPage(); drawHeadings(); };
    drawHeadings();

    for (let index = 0; index < report.rows.length; index++) {
      doc.font('ReportRegular').fontSize(size);
      const cells = report.rows[index].map((value, column) => wrapPdfText(doc, value, widths[column] - PADDING * 2));
      const lines = Math.max(...cells.map((cell) => cell.length));
      const rowHeight = lines * lineHeight + PADDING * 2;
      if (doc.y + rowHeight > bottom() && doc.y > bodyStart) nextTablePage();
      let offset = 0;
      while (offset < lines) {
        const capacity = Math.floor((bottom() - doc.y - PADDING * 2) / lineHeight);
        if (capacity < 1) { nextTablePage(); continue; }
        const count = Math.min(capacity, lines - offset);
        drawCells(cells.map((cell) => cell.slice(offset, offset + count)), count * lineHeight + PADDING * 2, false);
        offset += count;
        if (offset < lines) nextTablePage();
      }
      if (index % 100 === 99) await setImmediate();
    }
    if (!report.rows.length) {
      doc.font('ReportRegular').fontSize(9);
      if (doc.y + 24 > bottom()) nextTablePage();
      const y = doc.y;
      doc.text(report.emptyMessage, MARGIN + PADDING, y + 6, { lineBreak: false });
      doc.y = y + 24;
    }
    const range = doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page++) {
      doc.switchToPage(page);
      doc.font('ReportRegular').fontSize(8).fillColor('#6b7280');
      const label = `${page + 1} / ${range.count}`;
      doc.text(label, (doc.page.width - doc.widthOfString(label)) / 2, doc.page.height - 25, { lineBreak: false });
    }
    doc.end();
    return await finished;
  } catch (error) {
    (doc as unknown as Readable).destroy();
    throw error;
  }
}
