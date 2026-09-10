'use client';
import { Ltr } from '@/components/layout/Ltr';

/**
 * Designed paper-ticket preview for the day-close Z report.
 *
 * Built from the Z JSON already in state (no extra fetch). Mirrors the
 * print order of `buildZReportBody` (main/printers/thermal.ts) so the
 * screen shows what the operator is about to send to paper. Print is
 * always a separate explicit action; this component never triggers it.
 *
 * Empty-section rule: refund/tax/staff blocks render a muted "(none)"
 * line only when the block would otherwise look broken (i.e. the field
 * is meaningful enough that absence is information — refunds count
 * matters). Where omission reads cleaner, the section is dropped.
 */
export interface CashCloseTicketPreviewLabels {
  payments: string;
  refunds: string;
  tax: string;
  staff: string;
  operator: string;
  notes: string;
  openingFloat: string;
  expectedCash: string;
  countedCash: string;
  variance: string;
  methodCount: (count: number) => string;
  refundCount: (count: number) => string;
  noRefunds: string;
  noTax: string;
  noStaff: string;
  billCount: (count: number) => string;
  closedAt: (date: string) => string;
  footer: string;
}

interface PaymentMethodRow {
  method: string;
  count: number;
  total_cents: number;
}
interface StaffSalesRow {
  user_id: string;
  name: string;
  role: string;
  revenue_cents: number;
  orderCount: number;
}
interface TaxComponentRow {
  title: string;
  amount: number | string;
}

export interface CashCloseTicketPreviewProps {
  z: {
    id?: number;
    z_number: number;
    business_date: string;
    opening_float_cents: number;
    expected_cash_cents: number;
    counted_cash_cents: number;
    variance_cents: number;
    bill_count: number;
    refund_count: number;
    refunded_cents: number;
    payment_methods: PaymentMethodRow[];
    staff_sales: StaffSalesRow[];
    tax_components: TaxComponentRow[];
    closed_by: string;
    closed_by_name: string;
    notes: string | null;
    period_start?: string;
    period_end?: string;
  };
  minorFactor: number;
  formatter: (major: number) => string;
  labels: CashCloseTicketPreviewLabels;
}

const DASH = 'border-t border-dashed border-zinc-300 dark:border-zinc-700';



/** Variance color matches the existing red/amber/grey-by-sign convention. */
const varianceClass = (v: number): string => {
  if (v > 0) return 'text-amber-700 dark:text-amber-300';
  if (v < 0) return 'text-red-700 dark:text-red-400';
  return 'text-zinc-700 dark:text-zinc-300';
};

export function CashCloseTicketPreview({ z, minorFactor, formatter, labels }: CashCloseTicketPreviewProps) {
  const varianceSign = z.variance_cents > 0 ? '+' : z.variance_cents < 0 ? '−' : '';
  const taxRows = Array.isArray(z.tax_components) ? z.tax_components : [];
  const hasRefunds = z.refund_count > 0;
  const hasTax = taxRows.length > 0;
  const hasStaff = (z.staff_sales ?? []).length > 0;
  const hasPayments = (z.payment_methods ?? []).length > 0;

  return (
    <div className="flex justify-center">
      <div
        role="group"
        aria-label={`${labels.operator} Z ${z.z_number} ${z.business_date}`}
        className="relative w-full max-w-sm rounded-xl shadow-sm bg-neutral-50 dark:bg-neutral-100 text-zinc-900 ring-1 ring-zinc-200/80 overflow-hidden"
      >
        {/* Tear-off top notch (purely decorative; mirrors a real ticket). */}
        <div className="h-2 bg-[radial-gradient(circle_at_8px_0,transparent_8px,theme(colors.zinc.200)_9px)_repeat-x] bg-[length:16px_8px]" aria-hidden />

        <div className="px-5 pt-4 pb-5 font-sans">
          {/* Headline */}
          <div className="text-center">
            <p className="mt-1 text-base font-semibold tracking-tight">
              Z #{z.z_number}
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
              {labels.closedAt(z.business_date)}
            </p>
            {z.period_start && z.period_end && (
              <p className="mt-0.5 text-[11px] text-zinc-500 font-mono">
                <Ltr>{z.period_start} - {z.period_end}</Ltr>
              </p>
            )}
          </div>

          <div className={`mt-3 ${DASH}`} />

          {/* Opening float */}
          <Row label={labels.openingFloat} value={formatter(z.opening_float_cents / minorFactor)} first />

          {/* Payment methods */}
          {hasPayments && (
            <>
              <div className="mt-3 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                {labels.payments}
              </div>
              <div className="mt-1">
                {z.payment_methods.map((row) => (
                  <Row
                    key={row.method}
                    label={`${row.method} ${labels.methodCount(row.count)}`}
                    value={formatter(row.total_cents / minorFactor)}
                  />
                ))}
              </div>
            </>
          )}

          {/* Refunds */}
          {hasRefunds ? (
            <>
              <div className="mt-3 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                {labels.refunds}
              </div>
              <Row
                label={labels.refundCount(z.refund_count)}
                value={formatter(z.refunded_cents / minorFactor)}
              />
            </>
          ) : (
            <div className="mt-3 text-xs text-zinc-400 italic">
              {labels.noRefunds}
            </div>
          )}

          {/* Tax breakdown */}
          {hasTax ? (
            <>
              <div className="mt-3 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                {labels.tax}
              </div>
              {taxRows.map((row, i) => {
                const amount = Number(row.amount ?? 0);
                return (
                  <Row key={`${row.title}-${i}`} label={row.title} value={formatter(amount)} />
                );
              })}
            </>
          ) : (
            <div className="mt-3 text-xs text-zinc-400 italic">{labels.noTax}</div>
          )}

          {/* Staff sales */}
          {hasStaff ? (
            <>
              <div className="mt-3 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                {labels.staff}
              </div>
              {z.staff_sales.map((row) => (
                <Row
                  key={row.user_id}
                  label={row.name}
                  sublabel={`${row.role} · ${labels.billCount(row.orderCount)}`}
                  value={formatter(row.revenue_cents / minorFactor)}
                />
              ))}
            </>
          ) : (
            <div className="mt-3 text-xs text-zinc-400 italic">{labels.noStaff}</div>
          )}

          <div className={`mt-3 ${DASH}`} />

          {/* Expected / Counted */}
          <Row label={labels.expectedCash} value={formatter(z.expected_cash_cents / minorFactor)} first bold />
          <Row label={labels.countedCash} value={formatter(z.counted_cash_cents / minorFactor)} bold />

          <div className={`mt-2 ${DASH}`} />

          {/* Variance — the headline number */}
          <div className="mt-3 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">{labels.variance}</span>
            <Ltr>
              <span className={`text-lg font-semibold tabular-nums ${varianceClass(z.variance_cents)}`}>
                {varianceSign}{formatter(Math.abs(z.variance_cents) / minorFactor)}
              </span>
            </Ltr>
          </div>

          {/* Bill count */}
          <div className="mt-2 flex items-baseline justify-between text-xs text-zinc-500">
            <span>{labels.billCount(z.bill_count)}</span>
            <span>{labels.closedAt(z.business_date)}</span>
          </div>

          {/* Operator */}
          <div className="mt-3 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
            {labels.operator}
          </div>
          <p className="mt-0.5 text-sm">
            {z.closed_by_name}
          </p>

          {/* Notes block — only when present. */}
          {z.notes && z.notes.trim().length > 0 && (
            <>
              <div className={`mt-3 ${DASH}`} />
              <div className="mt-3 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                {labels.notes}
              </div>
              <p className="mt-0.5 text-sm whitespace-pre-wrap">{z.notes}</p>
            </>
          )}

          {/* Footer */}
          <div className={`mt-4 ${DASH}`} />
          <p className="mt-2 text-center text-[10px] uppercase tracking-[0.18em] text-zinc-500">
            {labels.footer}
          </p>
        </div>

        {/* Tear-off bottom notch */}
        <div className="h-2 bg-[radial-gradient(circle_at_8px_8px,transparent_8px,theme(colors.zinc.200)_9px)_repeat-x] bg-[length:16px_8px]" aria-hidden />
      </div>
    </div>
  );
}

interface RowProps {
  label: string;
  sublabel?: string;
  value: string;
  first?: boolean;
  bold?: boolean;
}
function Row({ label, sublabel, value, first, bold }: RowProps) {
  return (
    <div className={`flex items-baseline justify-between ${first ? '' : 'mt-1'}`}>
      <div className="min-w-0 flex-1 pr-3">
        <p className={`truncate text-sm ${bold ? 'font-semibold' : ''}`}>{label}</p>
        {sublabel && <p className="truncate text-[11px] text-zinc-500">{sublabel}</p>}
      </div>
      <Ltr>
        <span className={`tabular-nums text-sm ${bold ? 'font-semibold' : ''}`}>{value}</span>
      </Ltr>
    </div>
  );
}
