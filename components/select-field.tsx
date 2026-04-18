'use client';

import type { ReactNode } from 'react';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldProps<V extends string> {
  label: string;
  value: V | '';
  onChange: (v: V | '') => void;
  options: readonly SelectOption[];
  placeholder?: string;
  isRequired?: boolean;
  error?: string;
  className?: string;
  emptyLabel?: string; // текст «не выбрано»; если не задан — опция не добавляется
}

export function SelectField<V extends string>({
  label,
  value,
  onChange,
  options,
  placeholder,
  isRequired,
  error,
  className,
  emptyLabel = '— не выбрано —',
}: SelectFieldProps<V>) {
  return (
    <label className={['flex flex-col gap-1.5', className ?? ''].join(' ')}>
      <span className="text-sm font-medium text-foreground">
        {label}
        {isRequired ? <span className="ml-0.5 text-danger">*</span> : null}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as V | '')}
        className={[
          'h-10 rounded-md border bg-white px-3 text-sm text-foreground shadow-sm transition',
          'focus:outline-none focus:ring-2 focus:ring-primary/20',
          error ? 'border-danger focus:border-danger' : 'border-default-300 hover:border-default-400 focus:border-primary',
        ].join(' ')}
      >
        {emptyLabel ? <option value="">{placeholder ?? emptyLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </label>
  );
}

interface MaskedFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  format: (raw: string) => string;
  placeholder?: string;
  error?: string;
  className?: string;
  helper?: ReactNode;
  inputMode?: 'numeric' | 'text';
  maxLength?: number;
}

export function MaskedField({
  label,
  value,
  onChange,
  format,
  placeholder,
  error,
  className,
  helper,
  inputMode = 'text',
  maxLength,
}: MaskedFieldProps) {
  return (
    <label className={['flex flex-col gap-1.5', className ?? ''].join(' ')}>
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input
        type="text"
        value={value}
        inputMode={inputMode}
        maxLength={maxLength}
        onChange={(e) => onChange(format(e.currentTarget.value))}
        placeholder={placeholder}
        className={[
          'h-10 rounded-md border bg-white px-3 text-sm text-foreground shadow-sm transition',
          'focus:outline-none focus:ring-2 focus:ring-primary/20',
          error ? 'border-danger focus:border-danger' : 'border-default-300 hover:border-default-400 focus:border-primary',
        ].join(' ')}
      />
      {helper ? <span className="text-xs text-default-500">{helper}</span> : null}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </label>
  );
}

/** Форматтер кода подразделения: 000-000 (ровно 6 цифр с дефисом). */
export function formatDepartmentCode(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 6);
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}
