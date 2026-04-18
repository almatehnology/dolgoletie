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

export function formatDateRange(start: string | Date, end: string | Date): string {
  const s = new Date(start);
  const e = new Date(end);
  const fmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${fmt.format(s)} – ${fmt.format(e)}`;
}

export function fullName(p: { lastName: string; firstName: string; middleName?: string | null }): string {
  return [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ');
}
