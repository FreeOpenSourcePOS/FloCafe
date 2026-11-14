'use client';

import { useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CheckoutStationReadout {
  activeLabel: string;
  amountText: string;
  paidSummaryText: string;
  dueSummaryText: string;
  statusPillText?: string;
  statusTone?: 'settled' | 'due' | 'change';
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
  tone: 'idle-due' | 'idle-settled' | 'warning' | 'error';
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

  const readoutPillClass =
    readout.statusTone === 'settled'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : readout.statusTone === 'change'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-primary/10 text-primary';

  const isAlertTone = statusBanner?.tone === 'error' || statusBanner?.tone === 'warning';
  const bannerSurfaceClass =
    statusBanner?.tone === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : statusBanner?.tone === 'warning'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
        : statusBanner?.tone === 'idle-settled'
          ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
          : 'border-border bg-muted/20 text-foreground';

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
        className="shrink-0 rounded-xl border border-border bg-muted/25 px-3 py-2 sm:px-3.5 sm:py-2.5 [@media(max-height:660px)]:py-1.5"
      >
        <div className="flex h-5 items-center justify-between gap-2">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {readout.activeLabel}
          </span>
          {readout.statusPillText ? (
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none',
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
          className="mt-0.5 truncate text-xl font-bold tabular-nums leading-tight text-foreground sm:text-2xl"
        >
          {readout.amountText}
        </div>
        <div className="mt-1 flex min-h-4 items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span className="truncate">{readout.paidSummaryText}</span>
          <span className="shrink-0">{readout.dueSummaryText}</span>
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
                'flex h-full min-h-10 flex-col items-center justify-center rounded-lg border px-1.5 text-center leading-tight transition-colors sm:min-h-11 [@media(max-height:660px)]:min-h-9',
                item.active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-card text-foreground hover:bg-muted',
                item.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <span className="truncate text-xs font-semibold tabular-nums">{item.label}</span>
              {item.subLabel ? (
                <span className="mt-0.5 truncate text-[9px] font-medium leading-none text-muted-foreground">
                  {item.subLabel}
                </span>
              ) : null}
            </button>
          ))
        ) : (
          <div
            aria-hidden="true"
            className="col-span-4 rounded-lg border border-dashed border-border/50 bg-muted/10"
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
            className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover p-3 shadow-lg"
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
            'flex h-10 items-center justify-between rounded-lg border px-3 text-sm sm:h-11 [@media(max-height:660px)]:h-9',
            changeDisplay.visible
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-border/50 bg-muted/15 text-muted-foreground',
          )}
        >
          <span className={cn('text-xs font-medium', !changeDisplay.visible && 'opacity-70')}>
            {changeDisplay.label}
          </span>
          <span className={cn('font-bold tabular-nums', !changeDisplay.visible && 'opacity-50')}>
            {changeDisplay.formattedAmount}
          </span>
        </div>

        {/* Reserved Status / Recovery Strip (fixed desktop height to prevent layout jumps) */}
        <div
          data-testid="checkout-status-strip"
          role={isAlertTone ? 'alert' : undefined}
          className={cn(
            'flex h-[60px] min-h-[52px] flex-col justify-center gap-1 overflow-hidden rounded-lg border px-2.5 py-1.5 sm:h-[68px] [@media(max-height:660px)]:h-12 [@media(max-height:660px)]:min-h-12 [@media(max-height:660px)]:py-1',
            bannerSurfaceClass,
          )}
        >
          {statusBanner ? (
            <>
              <div className="flex min-h-0 flex-1 items-start justify-between gap-2 overflow-y-auto">
                <div className="min-w-0 flex-1 text-xs leading-snug">
                  <div className="flex items-center gap-1.5 font-medium">
                    {statusBanner.tone === 'idle-settled' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
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
                    className="ms-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium underline-offset-2 hover:underline"
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
