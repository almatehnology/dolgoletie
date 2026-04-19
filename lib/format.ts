export function formatMoney(value: string | number | null | undefined, currency: 'RUB' | 'USD'): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(num);
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : '—';
  return DATE_FMT.format(d);
}

export function formatDateRange(start: string | Date, end: string | Date): string {
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export function fullName(p: { lastName: string; firstName: string; middleName?: string | null }): string {
  return [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ');
}
