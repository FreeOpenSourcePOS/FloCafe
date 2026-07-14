'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';

interface TaxLine {
  title: string;
  rate: number;
  amount: number;
}

interface Props {
  taxAmount: number;
  taxBreakdown: TaxLine[] | null | undefined;
  currency: string;
  theme?: 'dark' | 'light';
}

export default function TaxBreakdown({ taxAmount, taxBreakdown, currency, theme = 'dark' }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const breakdownArray = Array.isArray(taxBreakdown) ? taxBreakdown : [];
  const hasBreakdown = breakdownArray.length > 0;

  if (!taxAmount || taxAmount <= 0) return null;

  const fmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div>
      <button
        onClick={() => hasBreakdown && setExpanded(!expanded)}
        className={`flex items-center gap-1 w-full text-left ${hasBreakdown ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
      >
        {hasBreakdown && (
          expanded
            ? <ChevronDown size={12} className={theme === 'light' ? 'text-gray-400' : 'text-slate-400'} />
            : <ChevronRight size={12} className={theme === 'light' ? 'text-gray-400' : 'text-slate-400'} />
        )}
        <span className={`text-xs ${theme === 'light' ? 'text-gray-500' : 'text-slate-300'}`}>{t('pos.tax')}</span>
        <span className="flex-1" />
        <span className={`text-xs ${theme === 'light' ? 'text-gray-500' : 'text-slate-300'}`}>{currency}{fmt(taxAmount)}</span>
      </button>
      {expanded && hasBreakdown && (
        <div className="ml-4 mt-1 space-y-0.5">
          {breakdownArray.map((line, i) => (
            <div key={i} className={`flex justify-between text-xs ${theme === 'light' ? 'text-gray-400' : 'text-slate-400'}`}>
              <span>{t('pos.taxLine', { title: line.title, rate: line.rate })}</span>
              <span>{currency}{fmt(line.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
