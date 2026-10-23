'use client';

import PrinterStatus from './PrinterStatus';
import CustomerSearch from './CustomerSearch';
import CustomerTopItems from './CustomerTopItems';
import { Banknote, Maximize2, Minimize2, LockOpen, Lock, Printer } from 'lucide-react';
import type { Product } from '@/lib/types';
import { useTranslations } from 'use-intl';

interface Props {
  products: Product[];
  onTopItemSelect: (product: Product) => void;
  onShowCashMovement: () => void;
  onShowShift: () => void;
  shiftHasOpenSession: boolean;
  shiftLoading: boolean;
  shiftError: string | null;
  canUseShift: boolean;
  onShowPrintMenu: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onCustomerModalOpenChange?: (open: boolean) => void;
}

export default function PosTopbar({
  products,
  onTopItemSelect,
  onShowCashMovement,
  onShowShift,
  shiftHasOpenSession,
  shiftLoading,
  shiftError,
  canUseShift,
  onShowPrintMenu,
  fullscreen,
  onToggleFullscreen,
  onCustomerModalOpenChange,
}: Props) {
  const t = useTranslations('pos');
  const tDashboard = useTranslations('dashboard');
  const tProducts = useTranslations('products');

  return (
    // Identity/search first, the action buttons end-aligned next to it, and the
    // customer favorites row full-width beneath both.
    <div className="flex flex-col border-b bg-card shrink-0 px-3 py-2 sm:px-4 sm:py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex-1 min-w-0">
          <CustomerSearch variant="topbar" onModalOpenChange={onCustomerModalOpenChange} />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onShowCashMovement}
            className="touch-target shrink-0 gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted active:bg-muted whitespace-nowrap"
            title={tDashboard('cashMovement')}
            aria-label={tDashboard('cashMovement')}
          >
            <Banknote size={16} />
            <span className="hidden sm:inline">{tDashboard('cashMovement')}</span>
          </button>

          {canUseShift && (
            <button
              type="button"
              onClick={onShowShift}
              disabled={shiftLoading}
              className="touch-target shrink-0 gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted active:bg-muted whitespace-nowrap disabled:opacity-50"
              title={
                shiftError ??
                (shiftHasOpenSession ? tDashboard('closeShiftSession') : tDashboard('openShift'))
              }
              aria-label={
                shiftHasOpenSession ? tDashboard('closeShiftSession') : tDashboard('openShift')
              }
            >
              {shiftHasOpenSession ? <Lock size={16} /> : <LockOpen size={16} />}
              <span className="hidden sm:inline">
                {shiftHasOpenSession ? tDashboard('closeShiftSession') : tDashboard('openShift')}
              </span>
            </button>
          )}

          <div className="shrink-0">
            <PrinterStatus />
          </div>
          <button
            type="button"
            onClick={onShowPrintMenu}
            className="touch-target shrink-0 rounded-lg border border-border bg-card px-3 text-muted-foreground transition-colors hover:bg-muted active:bg-muted"
            title={tProducts('printMenu')}
            aria-label={tProducts('printMenu')}
          >
            <Printer size={16} />
          </button>
          <button
            type="button"
            onClick={onToggleFullscreen}
            className="touch-target shrink-0 rounded-lg border border-border bg-card px-3 text-muted-foreground transition-colors hover:bg-muted active:bg-muted"
            title={fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
            aria-label={fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
          >
            {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>

      {/* Full-width favorites row beneath the identity/actions region. */}
      <CustomerTopItems products={products} onSelect={onTopItemSelect} />
    </div>
  );
}
