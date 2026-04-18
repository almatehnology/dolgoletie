import PDFDocument from 'pdfkit';
import { resolve } from 'node:path';

const FONTS_DIR = resolve(process.cwd(), 'assets', 'fonts');
const FONT_REGULAR = resolve(FONTS_DIR, 'PTSans-Regular.ttf');
const FONT_BOLD = resolve(FONTS_DIR, 'PTSans-Bold.ttf');

type Colors = typeof COLORS;

const COLORS = {
  text: '#1a1a1a',
  muted: '#6b7280',
  border: '#d1d5db',
  accent: '#2563eb',
  chipBg: '#eef2ff',
  sectionBg: '#f3f4f6',
};

interface InitOptions {
  title: string;
  subtitle?: string;
}

function initDoc({ title, subtitle }: InitOptions) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 48, bottom: 48, left: 48, right: 48 },
    info: { Title: title, Creator: 'Долголетие', Producer: 'Долголетие' },
  });
  doc.registerFont('Regular', FONT_REGULAR);
  doc.registerFont('Bold', FONT_BOLD);
  doc.font('Regular');

  // Шапка
  doc.font('Bold').fontSize(18).fillColor(COLORS.text).text(title, { lineGap: 2 });
  if (subtitle) {
    doc
      .moveDown(0.1)
      .font('Regular')
      .fontSize(10)
      .fillColor(COLORS.muted)
      .text(subtitle);
  }
  doc.moveDown(0.6);
  divider(doc);
  doc.moveDown(0.6);

  return doc;
}

function divider(doc: PDFKit.PDFDocument) {
  const { x, y } = { x: doc.page.margins.left, y: doc.y };
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc
    .save()
    .strokeColor(COLORS.border)
    .lineWidth(0.5)
    .moveTo(x, y)
    .lineTo(x + width, y)
    .stroke()
    .restore();
}

function sectionHeader(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.4);
  doc
    .font('Bold')
    .fontSize(11)
    .fillColor(COLORS.accent)
    .text(title.toUpperCase(), { characterSpacing: 0.6, lineGap: 2 });
  doc.moveDown(0.2);
}

/**
 * Рисует список ключ-значение в две колонки: `label` слева серым, `value` справа чёрным.
 * Разрыв страницы — автоматический.
 */
function kvList(
  doc: PDFKit.PDFDocument,
  items: Array<[label: string, value: string | null | undefined]>,
  opts: { labelWidth?: number } = {},
) {
  const filled = items.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (filled.length === 0) return;

  const labelWidth = opts.labelWidth ?? 170;
  const contentWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right - labelWidth - 8;
  const xLabel = doc.page.margins.left;
  const xValue = xLabel + labelWidth + 8;
  const lineGap = 3;

  for (const [label, value] of filled) {
    const y = doc.y;
    doc
      .font('Regular')
      .fontSize(10)
      .fillColor(COLORS.muted)
      .text(label, xLabel, y, { width: labelWidth, lineGap });

    const yAfterLabel = doc.y;
    doc
      .font('Regular')
      .fontSize(10.5)
      .fillColor(COLORS.text)
      .text(String(value), xValue, y, { width: contentWidth, lineGap });

    // Переходим на максимально нижнюю точку
    const yNext = Math.max(yAfterLabel, doc.y);
    doc.y = yNext + 2;
  }
}

function footer(doc: PDFKit.PDFDocument) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.height - doc.page.margins.bottom + 18;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    doc
      .font('Regular')
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(
        `Сформировано ${new Date().toLocaleString('ru-RU')} · Долголетие`,
        left,
        bottom,
        { width: right - left, align: 'left' },
      )
      .text(`${i - range.start + 1} / ${range.count}`, left, bottom, {
        width: right - left,
        align: 'right',
      });
  }
}

function bufferDoc(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolveP(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ======================================================================
// Person PDF
// ======================================================================

const GENDER_LABELS: Record<string, string> = {
  MALE: 'Мужской',
  FEMALE: 'Женский',
  OTHER: 'Иное',
};

const PAYMENT_LABELS: Record<string, string> = {
  UNPAID: 'Не оплачено',
  PREPAID: 'Предоплата',
  PAID: 'Оплачено',
};

const CURRENCY_SYMBOLS: Record<string, string> = { RUB: '₽', USD: '$' };

function fmtDate(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return null;
  // Календарные даты хранятся как UTC-полночь (из <input type="date">),
  // форматируем в UTC, иначе локаль сдвигает день.
  return d.toLocaleDateString('ru-RU', { timeZone: 'UTC' });
}

function fmtMoney(v: string | number | null | undefined, currency: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n) +
    ' ' + (CURRENCY_SYMBOLS[currency] ?? currency);
}

export interface PersonPdfData {
  lastName: string;
  firstName: string;
  middleName: string | null;
  phone: string | null;
  gender: string | null;
  birthPlace: string | null;
  registrationAddress: string | null;
  passportNumber: string | null;
  passportIssuedBy: string | null;
  passportIssuedAt: Date | string | null;
  passportExpiresAt: Date | string | null;
  passportDepartmentCode: string | null;
  passportDetails: string | null;
  notes: string | null;
  createdAt: Date | string;
  deletedAt: Date | string | null;
  participations: Array<{
    paymentStatus: string;
    prepaidAmount: string | null;
    totalDue: string | null;
    event: {
      title: string;
      startDate: Date | string;
      endDate: Date | string;
      location: string;
      currency: string;
    };
  }>;
}

export async function generatePersonPdf(p: PersonPdfData): Promise<Buffer> {
  const fullName = [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ');
  const doc = initDoc({
    title: fullName,
    subtitle:
      (p.deletedAt ? 'В архиве · ' : '') +
      'Карточка физлица · создана ' +
      (fmtDate(p.createdAt) ?? ''),
  });

  sectionHeader(doc, 'Личные данные');
  kvList(doc, [
    ['Фамилия', p.lastName],
    ['Имя', p.firstName],
    ['Отчество', p.middleName],
    ['Пол', p.gender ? GENDER_LABELS[p.gender] ?? p.gender : null],
    ['Место рождения', p.birthPlace],
    ['Телефон', p.phone],
  ]);

  sectionHeader(doc, 'Паспорт');
  kvList(doc, [
    ['Серия и номер', p.passportNumber],
    ['Кем выдан', p.passportIssuedBy],
    ['Дата выдачи', fmtDate(p.passportIssuedAt)],
    ['Срок действия', fmtDate(p.passportExpiresAt)],
    ['Код подразделения', p.passportDepartmentCode],
    ['Адрес по прописке', p.registrationAddress],
    ['Доп. реквизиты', p.passportDetails],
  ]);

  if (p.notes) {
    sectionHeader(doc, 'Примечания');
    doc.font('Regular').fontSize(10.5).fillColor(COLORS.text).text(p.notes, {
      lineGap: 3,
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    });
  }

  if (p.participations.length > 0) {
    sectionHeader(doc, `Мероприятия (${p.participations.length})`);
    for (const part of p.participations) {
      const line = `${part.event.title}`;
      const dates = `${fmtDate(part.event.startDate)} — ${fmtDate(part.event.endDate)}`;
      const sums: string[] = [];
      if (part.prepaidAmount) sums.push(`предоплата ${fmtMoney(part.prepaidAmount, part.event.currency)}`);
      if (part.totalDue) sums.push(`итого ${fmtMoney(part.totalDue, part.event.currency)}`);
      const payment = PAYMENT_LABELS[part.paymentStatus] ?? part.paymentStatus;

      doc.font('Bold').fontSize(10.5).fillColor(COLORS.text).text('• ' + line, { continued: false });
      doc
        .font('Regular')
        .fontSize(9.5)
        .fillColor(COLORS.muted)
        .text(
          `${dates} · ${part.event.location} · ${payment}${sums.length ? ' · ' + sums.join(' / ') : ''}`,
          { indent: 12, lineGap: 2 },
        );
      doc.moveDown(0.25);
    }
  }

  footer(doc);
  return bufferDoc(doc);
}

// ======================================================================
// Event PDF
// ======================================================================

const TRANSPORT_LABELS: Record<string, string> = {
  BUS: 'Автобус',
  TRAIN: 'Поезд',
  PLANE: 'Самолёт',
  OTHER: 'Другое',
};

const MEAL_LABELS: Record<string, string> = {
  NONE: 'Без питания',
  BREAKFAST: 'Завтрак',
  HALF_BOARD: 'Полупансион',
  FULL_BOARD: 'Полный пансион',
  ALL_INCLUSIVE: 'Всё включено',
  ULTRA_ALL_INCLUSIVE: 'Ультра всё включено',
};

export interface EventPdfData {
  title: string;
  startDate: Date | string;
  endDate: Date | string;
  location: string;
  cost: string | null;
  currency: string;
  program: string | null;
  isOutbound: boolean;
  accommodationPlace: string | null;
  accommodationOrder: string | null;
  mealType: string | null;
  staysFrom: Date | string | null;
  staysTo: Date | string | null;
  accommodationCost: string | null;
  transportType: string | null;
  transportInfo: string | null;
  transportCost: string | null;
  deletedAt: Date | string | null;
  excursions: Array<{ name: string; cost: string | null }>;
  participations: Array<{
    paymentStatus: string;
    prepaidAmount: string | null;
    totalDue: string | null;
    person: {
      lastName: string;
      firstName: string;
      middleName: string | null;
      phone: string | null;
      passportNumber: string | null;
    };
  }>;
}

export async function generateEventPdf(e: EventPdfData): Promise<Buffer> {
  const dateRange = `${fmtDate(e.startDate) ?? ''} — ${fmtDate(e.endDate) ?? ''}`;
  const doc = initDoc({
    title: e.title,
    subtitle: (e.deletedAt ? 'В архиве · ' : '') + dateRange + ' · ' + e.location,
  });

  sectionHeader(doc, 'Общие данные');
  kvList(doc, [
    ['Даты проведения', dateRange],
    ['Место', e.location],
    ['Стоимость', fmtMoney(e.cost, e.currency)],
    ['Валюта', e.currency],
    ['Тип', e.isOutbound ? 'Выездное' : 'Стационарное'],
  ]);

  if (e.program) {
    sectionHeader(doc, 'Программа');
    doc.font('Regular').fontSize(10.5).fillColor(COLORS.text).text(e.program, {
      lineGap: 3,
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    });
  }

  if (e.isOutbound) {
    sectionHeader(doc, 'Размещение и транспорт');
    kvList(doc, [
      ['Место размещения', e.accommodationPlace],
      ['Порядок размещения', e.accommodationOrder],
      ['Тип питания', e.mealType ? MEAL_LABELS[e.mealType] ?? e.mealType : null],
      ['Проживание с', fmtDate(e.staysFrom)],
      ['Проживание по', fmtDate(e.staysTo)],
      ['Стоимость размещения', fmtMoney(e.accommodationCost, e.currency)],
      ['Транспорт', e.transportType ? TRANSPORT_LABELS[e.transportType] ?? e.transportType : null],
      ['Описание транспорта', e.transportInfo],
      ['Стоимость билета', fmtMoney(e.transportCost, e.currency)],
    ]);
  }

  if (e.excursions.length > 0) {
    sectionHeader(doc, `Экскурсии (${e.excursions.length})`);
    for (const ex of e.excursions) {
      doc.font('Regular').fontSize(10.5).fillColor(COLORS.text).text(
        `• ${ex.name}${ex.cost ? ' — ' + fmtMoney(ex.cost, e.currency) : ''}`,
        { lineGap: 2 },
      );
    }
  }

  if (e.participations.length > 0) {
    sectionHeader(doc, `Участники (${e.participations.length})`);
    for (const part of e.participations) {
      const name = [part.person.lastName, part.person.firstName, part.person.middleName]
        .filter(Boolean)
        .join(' ');
      const extras: string[] = [];
      if (part.person.phone) extras.push(part.person.phone);
      if (part.person.passportNumber) extras.push('паспорт ' + part.person.passportNumber);
      const sums: string[] = [];
      if (part.prepaidAmount) sums.push('предоплата ' + fmtMoney(part.prepaidAmount, e.currency));
      if (part.totalDue) sums.push('итого ' + fmtMoney(part.totalDue, e.currency));

      doc.font('Bold').fontSize(10.5).fillColor(COLORS.text).text('• ' + name);
      doc
        .font('Regular')
        .fontSize(9.5)
        .fillColor(COLORS.muted)
        .text(
          `${PAYMENT_LABELS[part.paymentStatus] ?? part.paymentStatus}${
            sums.length ? ' · ' + sums.join(' / ') : ''
          }${extras.length ? ' · ' + extras.join(' · ') : ''}`,
          { indent: 12, lineGap: 2 },
        );
      doc.moveDown(0.2);
    }
  }

  footer(doc);
  return bufferDoc(doc);
}

export type { Colors };
