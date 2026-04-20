'use client';

import { Calendar, DateField, DatePicker } from '@heroui/react';
import { CalendarDate, parseDate, type DateValue } from '@internationalized/date';

interface DatePickerFieldProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  isRequired?: boolean;
  error?: string;
  className?: string;
  minValue?: string;
  maxValue?: string;
}

function toCalendarDate(v: string): CalendarDate | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  try {
    return parseDate(`${m[1]}-${m[2]}-${m[3]}`);
  } catch {
    return null;
  }
}

function fromDateValue(v: DateValue | null): string {
  if (!v) return '';
  const y = String(v.year).padStart(4, '0');
  const mo = String(v.month).padStart(2, '0');
  const d = String(v.day).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function DatePickerField({
  label,
  value,
  onChange,
  isRequired,
  error,
  className,
  minValue,
  maxValue,
}: DatePickerFieldProps) {
  const current = toCalendarDate(value);
  const min = minValue ? toCalendarDate(minValue) : null;
  const max = maxValue ? toCalendarDate(maxValue) : null;

  return (
    <div className={['flex flex-col gap-1.5', className ?? ''].join(' ')}>
      {label ? (
        <span className="text-sm font-medium text-foreground">
          {label}
          {isRequired ? <span className="ml-0.5 text-danger">*</span> : null}
        </span>
      ) : null}
      <DatePicker
        value={current}
        onChange={(v) => onChange(fromDateValue(v))}
        isRequired={isRequired}
        minValue={min ?? undefined}
        maxValue={max ?? undefined}
        aria-label={label ?? 'Дата'}
      >
        <DateField.Group>
          <DateField.Input>
            {(segment) => <DateField.Segment segment={segment} />}
          </DateField.Input>
          <DatePicker.Trigger>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Group>
        <DatePicker.Popover>
          <Calendar>
            <Calendar.Header>
              <Calendar.NavButton slot="previous">‹</Calendar.NavButton>
              <Calendar.Heading />
              <Calendar.NavButton slot="next">›</Calendar.NavButton>
            </Calendar.Header>
            <Calendar.Grid>
              <Calendar.GridHeader>
                {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
              </Calendar.GridHeader>
              <Calendar.GridBody>
                {(date) => <Calendar.Cell date={date} />}
              </Calendar.GridBody>
            </Calendar.Grid>
          </Calendar>
        </DatePicker.Popover>
      </DatePicker>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
