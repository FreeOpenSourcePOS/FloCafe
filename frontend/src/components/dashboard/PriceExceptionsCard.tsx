'use client';

import { useEffect, useState } from 'react';
import { Tag } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';

interface PriceExceptionRow {
  order_id: number;
  order_number: string;
  item_id: number;
  product_name: string;
  quantity: number;
  original_unit_price: number;
  billed_unit_price: number;
  difference: number;
  reason: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

interface PriceExceptionsReport {
  count: number;
  complimentaryCount: number;
  totalDifference: number;
  rows: PriceExceptionRow[];
}

/** End-of-day list of manually overridden item prices for the selected report range. */
export function PriceExceptionsCard({
  startDate,
  endDate,
}: {
  startDate: string;
  endDate: string;
}) {
  const t = useTranslations('dashboard');
  const fmt = useFormatCurrency();
  const { formatDateTime } = useFormatDate();
  const [report, setReport] = useState<PriceExceptionsReport | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/reports/price-exceptions', {
        params: { start_date: startDate, end_date: endDate },
        signal: controller.signal,
      })
      .then((res) => setReport(res.data.priceExceptions ?? null))
      .catch(() => {
        if (!controller.signal.aborted) setReport(null);
      });
    return () => controller.abort();
  }, [startDate, endDate]);

  if (!report) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            <Tag size={16} />
          </span>
          <h2 className="font-semibold text-foreground">{t('priceExceptions')}</h2>
        </div>
        {report.count > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('priceExceptionsCount', { count: report.count })} ·{' '}
            {t('priceExceptionsComps', { count: report.complimentaryCount })} ·{' '}
            {t('priceExceptionsTotal', { amount: fmt(report.totalDifference) })}
          </p>
        )}
      </div>
      {report.rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          {t('priceExceptionsEmpty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-start text-xs text-muted-foreground">
                {(
                  [
                    'priceExceptionOrder',
                    'priceExceptionItem',
                    'priceExceptionOriginal',
                    'priceExceptionBilled',
                    'priceExceptionDifference',
                    'priceExceptionBy',
                    'priceExceptionAt',
                    'priceExceptionReason',
                  ] as const
                ).map((key) => (
                  <th key={key} className="px-4 py-2 text-start font-medium">
                    {t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.rows.map((row) => (
                <tr key={row.item_id}>
                  <td className="px-4 py-2 whitespace-nowrap">{row.order_number}</td>
                  <td className="px-4 py-2">
                    {row.quantity}× {row.product_name}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmt(row.original_unit_price)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmt(row.billed_unit_price)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmt(row.difference)}</td>
                  <td className="px-4 py-2">{row.changed_by_name ?? ''}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{formatDateTime(row.changed_at)}</td>
                  <td className="px-4 py-2">{row.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
