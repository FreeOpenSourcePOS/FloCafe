'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { formatCurrencyForTenant } from '@/lib/countries';
import { useAuthStore } from '@/store/auth';

interface TaxLine {
  title: string;
  rate: number;
  amount: number;
}

interface Props {
  taxAmount: number;
  taxBreakdown: TaxLine[] | null | undefined;
  theme?: 'dark' | 'light';
}

export default function TaxBreakdown({ taxAmount, taxBreakdown, theme = 'dark' }: Props) {
  const t = useTranslations('pos');
  const currentTenant = useAuthStore((s) => s.currentTenant);
  const tenantCountry = currentTenant?.country || '';
  const tenantCurrency = currentTenant?.currency ?? '';
  const [expanded, setExpanded] = useState(false);
  const breakdownArray = Array.isArray(taxBreakdown) ? taxBreakdown : [];
  const hasBreakdown = breakdownArray.length > 0;

  if (!taxAmount || taxAmount <= 0) return null;

  const fmt = (n: number) => formatCurrencyForTenant(n, tenantCountry, tenantCurrency);

  return (
    <div className="tabular-nums">
      <button
        type="button"
        aria-expanded={hasBreakdown ? expanded : undefined}
        onClick={() => hasBreakdown && setExpanded(!expanded)}
        className={`flex w-full items-center gap-1.5 rounded-md py-0.5 text-start transition-colors ${
          hasBreakdown ? 'cursor-pointer hover:text-foreground' : 'cursor-default'
        }`}
      >
        {hasBreakdown &&
          (expanded ? (
            <ChevronDown
              size={13}
              className={theme === 'light' ? 'text-muted-foreground' : 'text-slate-400'}
            />
          ) : (
            <ChevronRight
              size={13}
              className={`rtl-flip ${theme === 'light' ? 'text-muted-foreground' : 'text-slate-400'}`}
            />
          ))}
        <span
          className={`text-sm ${theme === 'light' ? 'text-muted-foreground' : 'text-slate-300'}`}
        >
          {t('tax')}
        </span>
        <span className="flex-1" />
        <span
          className={`text-sm font-medium ${theme === 'light' ? 'text-foreground' : 'text-slate-200'}`}
        >
          {fmt(taxAmount)}
        </span>
      </button>
      {expanded && hasBreakdown && (
        <div
          className={`ms-1.5 mt-1.5 space-y-1 border-s ps-3 ${
            theme === 'light' ? 'border-border dark:border-white/10' : 'border-slate-700'
          }`}
        >
          {breakdownArray.map((line, i) => {
            const title = line?.title || 'Tax';
            const rate = typeof line?.rate === 'number' ? line.rate : 0;
            const amount = typeof line?.amount === 'number' ? line.amount : 0;
            return (
              <div
                key={`${title}_${rate}_${i}`}
                className={`flex justify-between gap-2 text-xs ${
                  theme === 'light' ? 'text-muted-foreground' : 'text-slate-400'
                }`}
              >
                <span>{t('taxLine', { title, rate })}</span>
                <span
                  className={`font-medium ${theme === 'light' ? 'text-foreground' : 'text-slate-300'}`}
                >
                  {fmt(amount)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
