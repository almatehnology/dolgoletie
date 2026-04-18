import type { PaymentStatus } from '@/lib/store/events-api';

const LABEL: Record<PaymentStatus, string> = {
  UNPAID: 'Не оплачено',
  PREPAID: 'Предоплата',
  PAID: 'Оплачено',
};

const CLASS: Record<PaymentStatus, string> = {
  UNPAID: 'bg-danger-100 text-danger-700',
  PREPAID: 'bg-warning-100 text-warning-700',
  PAID: 'bg-success-100 text-success-700',
};

export function PaymentStatusChip({ status }: { status: PaymentStatus }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${CLASS[status]}`}>
      {LABEL[status]}
    </span>
  );
}
