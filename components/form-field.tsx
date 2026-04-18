'use client';

import type { HTMLInputTypeAttribute, ReactNode } from 'react';

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: HTMLInputTypeAttribute;
  placeholder?: string;
  isRequired?: boolean;
  error?: string;
  className?: string;
  autoFocus?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email' | 'tel' | 'search' | 'url';
  autoComplete?: string;
  children?: ReactNode;
}

const FIELD_BASE =
  'h-10 w-full rounded-md border bg-white px-3 text-sm text-foreground shadow-sm transition placeholder:text-default-400 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50';

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  isRequired,
  error,
  className,
  autoFocus,
  inputMode,
  autoComplete,
}: FieldProps) {
  return (
    <label className={['flex flex-col gap-1.5', className ?? ''].join(' ')}>
      <span className="text-sm font-medium text-foreground">
        {label}
        {isRequired ? <span className="ml-0.5 text-danger">*</span> : null}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        required={isRequired}
        autoFocus={autoFocus}
        inputMode={inputMode}
        autoComplete={autoComplete}
        className={[
          FIELD_BASE,
          error ? 'border-danger focus:border-danger' : 'border-default-300 hover:border-default-400 focus:border-primary',
        ].join(' ')}
      />
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </label>
  );
}

interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  error?: string;
  className?: string;
}

export function TextAreaField({ label, value, onChange, placeholder, rows = 3, error, className }: TextAreaFieldProps) {
  return (
    <label className={['flex flex-col gap-1.5', className ?? ''].join(' ')}>
      <span className="text-sm font-medium text-foreground">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        rows={rows}
        className={[
          'w-full rounded-md border bg-white px-3 py-2 text-sm text-foreground shadow-sm transition placeholder:text-default-400 focus:outline-none focus:ring-2 focus:ring-primary/20',
          error ? 'border-danger focus:border-danger' : 'border-default-300 hover:border-default-400 focus:border-primary',
        ].join(' ')}
      />
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </label>
  );
}
