'use client';

import { useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, Tag, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CheckoutStationReadout {
  activeLabel: string;
  amountText: string;
  paidSummaryText: string;
  dueSummaryText: string;
  statusPillText?: string;
  statusTone?: 'settled' | 'ready' | 'due' | 'partial' | 'change';
  isDiscountTarget?: boolean;
}

export interface CheckoutQuickTenderOption {
  label: string;
  subLabel?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface CheckoutChangeDisplay {
  label: string;
  formattedAmount: string;
  visible: boolean;
}

export interface CheckoutStatusBanner {
  tone: 'idle-due' | 'idle-ready' | 'idle-settled' | 'warning' | 'error';
  partial?: boolean;
  message: string;
  nextStep?: string | null;
  technicalDetails?: string | null;
  technicalDetailsLabel?: string;
  closeLabel?: string;
}

interface Props {
  readout: CheckoutStationReadout;
  quickTenders: CheckoutQuickTenderOption[];
  keypad: ReactNode;
  changeDisplay: CheckoutChangeDisplay;
  statusBanner?: CheckoutStatusBanner | null;
  children?: ReactNode;
  className?: string;
}

export function CheckoutPaymentStation({
  readout,
  quickTenders,
  keypad,
  changeDisplay,
  statusBanner,
  children,
  className,
}: Props) {
  const [detailsToken, setDetailsToken] = useState<string | null>(null);
  const detailsOpen =
    Boolean(statusBanner?.technicalDetails) && detailsToken === statusBanner?.technicalDetails;

  const readoutToneClass =
    statusBanner?.tone === 'error'
      ? 'border-destructive/45 bg-destructive/5 shadow-2xs'
      : statusBanner?.tone === 'warning'
        ? 'border-amber-500/45 bg-amber-500/8 shadow-2xs'
        : readout.isDiscountTarget
          ? 'border-brand/55 bg-brand-light/45 shadow-2xs ring-1 ring-inset ring-brand/20 dark:border-indigo-400/45 dark:bg-[var(--color-brand-light)]'
          : readout.statusTone === 'settled'
            ? 'border-emerald-500/40 bg-emerald-500/8 shadow-2xs'
            : 'border-brand/35 bg-card shadow-2xs ring-1 ring-inset ring-brand/10 dark:border-white/12 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]';

  const readoutPillClass =
    readout.statusTone === 'settled' || readout.statusTone === 'change'
      ? 'border border-emerald-500/35 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : readout.statusTone === 'ready'
        ? 'border border-brand/30 bg-brand-light text-brand dark:border-indigo-400/40 dark:bg-[var(--color-brand-light)] dark:text-indigo-300'
        : readout.statusTone === 'partial'
          ? 'border border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'border border-border bg-muted text-muted-foreground';

  const isAlertTone = statusBanner?.tone === 'error' || statusBanner?.tone === 'warning';
  const isPartialBanner = statusBanner?.tone === 'idle-due' && Boolean(statusBanner.partial);

  const bannerSurfaceClass =
    statusBanner?.tone === 'error'
      ? 'border-destructive/45 bg-destructive/10 text-destructive'
      : statusBanner?.tone === 'warning'
        ? 'border-amber-500/45 bg-amber-500/12 text-amber-800 dark:text-amber-200'
        : statusBanner?.tone === 'idle-settled'
          ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : statusBanner?.tone === 'idle-ready'
            ? 'border-brand/35 bg-brand-light/60 text-brand dark:border-indigo-400/35 dark:bg-[var(--color-brand-light)] dark:text-indigo-300'
            : isPartialBanner
              ? 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/12 dark:text-amber-300'
              : 'border-border/75 bg-card/75 text-foreground dark:border-white/10 dark:bg-card/50';

  return (
    <div
      data-testid="checkout-payment-station"
      className={cn(
        'relative flex h-full min-h-0 flex-col gap-2 [@media(max-height:660px)]:gap-1.5',
        className,
      )}
    >
      {/* Zone 3A: Live Tender Readout Card */}
      <div
        data-checkout-zone="readout"
        data-readout-tone={readout.statusTone ?? 'none'}
        data-readout-mode={readout.isDiscountTarget ? 'discount' : 'payment'}
        className={cn(
          'shrink-0 rounded-xl border px-3 py-2 transition-colors sm:px-3.5 sm:py-2.5 [@media(max-height:660px)]:py-1.5',
          readoutToneClass,
        )}
      >
        <div className="flex h-5 items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-xs font-semibold text-brand dark:text-indigo-300">
            {readout.isDiscountTarget ? (
              <Tag className="size-3.5 shrink-0" />
            ) : (
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-brand dark:bg-indigo-300"
              />
            )}
            <span className="truncate">{readout.activeLabel}</span>
          </span>
          {readout.statusPillText ? (
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none tabular-nums',
                readoutPillClass,
              )}
            >
              {readout.statusPillText}
            </span>
          ) : (
            <span className="h-4" aria-hidden="true" />
          )}
        </div>
        <div
          data-testid="checkout-readout-amount"
          className="mt-0.5 truncate text-xl font-bold tracking-tight tabular-nums leading-tight text-foreground sm:text-2xl"
        >
          {readout.amountText}
        </div>
        <div className="mt-1 flex min-h-4 items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span className="truncate">{readout.paidSummaryText}</span>
          <span className="shrink-0 font-semibold text-foreground">{readout.dueSummaryText}</span>
        </div>
      </div>

      {/* Zone 3B: Fixed-height Contextual Quick-Tender Strip */}
      <div
        data-checkout-zone="quick-tender"
        className="grid h-10 shrink-0 grid-cols-4 gap-1.5 sm:h-11 [@media(max-height:660px)]:h-9"
      >
        {quickTenders.length > 0 ? (
          quickTenders.slice(0, 4).map((item, idx) => (
            <button
              key={`${item.label}-${idx}`}
              type="button"
              disabled={item.disabled}
              onClick={item.onClick}
              className={cn(
                'flex h-full min-h-10 flex-col items-center justify-center rounded-xl border px-1.5 text-center leading-tight transition-[color,background-color,border-color,box-shadow,transform] select-none active:scale-[0.985] sm:min-h-11 [@media(max-height:660px)]:min-h-9',
                item.active
                  ? 'border-brand bg-brand text-white shadow-xs'
                  : 'border-border bg-card text-foreground shadow-2xs hover:border-brand/45 hover:bg-brand-light/25 dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:border-indigo-400/45 dark:hover:bg-[var(--color-brand-light)]',
                item.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <span className="max-w-full truncate text-xs font-semibold tabular-nums">
                {item.label}
              </span>
              {item.subLabel ? (
                <span
                  className={cn(
                    'mt-0.5 max-w-full truncate text-[9px] font-medium leading-none',
                    item.active ? 'text-white/85' : 'text-brand dark:text-indigo-300',
                  )}
                >
                  {item.subLabel}
                </span>
              ) : null}
            </button>
          ))
        ) : (
          <div
            aria-hidden="true"
            className="col-span-4 rounded-xl border border-border/50 bg-muted/20 dark:border-white/8 dark:bg-muted/15"
          />
        )}
      </div>

      {/* Zone 3C: Responsive Keypad */}
      <div
        data-checkout-zone="keypad"
        className="flex min-h-[176px] flex-1 flex-col justify-center sm:min-h-[188px] lg:min-h-[196px] [@media(max-height:660px)]:min-h-[188px] lg:max-h-[336px]"
      >
        {keypad}
      </div>

      {/* Zone 3D: Docked Change, Fixed Status/Recovery Strip & Primary Submit CTA */}
      <div
        data-checkout-zone="footer"
        className="relative flex shrink-0 flex-col gap-1.5 [@media(max-height:660px)]:gap-1"
      >
        {detailsOpen && statusBanner?.technicalDetails ? (
          <div
            role="region"
            aria-label={statusBanner.technicalDetailsLabel || 'Technical details'}
            className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-52 overflow-y-auto rounded-xl border border-border bg-popover p-3 shadow-lg"
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                {statusBanner.technicalDetailsLabel || 'Technical details'}
              </span>
              <button
                type="button"
                onClick={() => setDetailsToken(null)}
                aria-label={`${statusBanner.technicalDetailsLabel || 'Technical details'}: ${statusBanner.closeLabel || 'Close'}`}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-foreground">
              {statusBanner.technicalDetails}
            </pre>
          </div>
        ) : null}

        {/* Change Returned slot (constant height across states; label & formatted zero always visible for Equal Share parity) */}
        <div
          data-testid="checkout-change-slot"
          className={cn(
            'flex h-10 items-center justify-between rounded-xl border px-3 text-sm transition-colors sm:h-11 [@media(max-height:660px)]:h-9',
            changeDisplay.visible
              ? 'border-emerald-500/45 bg-emerald-500/12 text-emerald-700 shadow-2xs dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-300'
              : 'border-border/60 bg-muted/20 text-muted-foreground dark:border-white/8 dark:bg-muted/15',
          )}
        >
          <span
            className={cn(
              'text-xs',
              changeDisplay.visible ? 'font-semibold' : 'font-medium opacity-75',
            )}
          >
            {changeDisplay.label}
          </span>
          <span
            className={cn(
              'tabular-nums',
              changeDisplay.visible ? 'text-base font-bold' : 'font-semibold opacity-60',
            )}
          >
            {changeDisplay.formattedAmount}
          </span>
        </div>

        {/* Reserved Status / Recovery Strip (fixed desktop height to prevent layout jumps) */}
        <div
          data-testid="checkout-status-strip"
          data-status-tone={statusBanner?.tone ?? 'none'}
          role={isAlertTone ? 'alert' : undefined}
          className={cn(
            'flex h-[60px] min-h-[52px] flex-col justify-center gap-0.5 overflow-hidden rounded-xl border px-2.5 py-1 transition-colors sm:h-[68px] [@media(max-height:660px)]:h-12 [@media(max-height:660px)]:min-h-12 [@media(max-height:660px)]:py-0.5',
            bannerSurfaceClass,
          )}
        >
          {statusBanner ? (
            <>
              <div className="flex min-h-0 flex-1 items-start justify-between gap-2 overflow-y-auto">
                <div className="my-auto min-w-0 flex-1 text-xs leading-tight">
                  <div className="flex items-start gap-1.5 font-semibold">
                    {statusBanner.tone === 'idle-settled' ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    ) : statusBanner.tone === 'idle-ready' ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    ) : null}
                    <span className="break-words">{statusBanner.message}</span>
                  </div>
                  {statusBanner.nextStep ? (
                    <p className="mt-0.5 break-words text-[11px] leading-tight opacity-90">
                      {statusBanner.nextStep}
                    </p>
                  ) : null}
                </div>
              </div>

              {statusBanner.technicalDetails ? (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    aria-expanded={detailsOpen}
                    onClick={() =>
                      setDetailsToken(detailsOpen ? null : (statusBanner.technicalDetails ?? null))
                    }
                    className="ms-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0 text-[11px] font-medium leading-tight underline-offset-2 hover:underline"
                  >
                    <span>{statusBanner.technicalDetailsLabel || 'Technical details'}</span>
                    <ChevronDown
                      className={cn('h-3 w-3 transition-transform', detailsOpen && 'rotate-180')}
                    />
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <span className="text-xs text-muted-foreground" aria-hidden="true" />
          )}
        </div>

        {/* Full-Width Primary CTA */}
        {children}
      </div>
    </div>
  );
}
