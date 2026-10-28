'use client';

import PrinterStatus from './PrinterStatus';
import CustomerSearch from './CustomerSearch';
import CustomerTopItems from './CustomerTopItems';
import {
  Banknote,
  EllipsisVertical,
  Maximize2,
  Minimize2,
  LockOpen,
  Lock,
  Printer,
  UtensilsCrossed,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Product } from '@/lib/types';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '@/store/auth';

interface Props {
  products: Product[];
  onTopItemSelect: (product: Product) => void;
  showTableButton: boolean;
  tableName: string | null;
  onShowTablePicker: () => void;
  onActionsMenuOpenChange: (open: boolean) => void;
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
  showTableButton,
  tableName,
  onShowTablePicker,
  onActionsMenuOpenChange,
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
  const lock = useAuthStore((s) => s.lock);

  return (
    // Identity/search first, the action buttons end-aligned next to it, and the
    // customer favorites row full-width beneath both.
    <div className="flex flex-col border-b bg-card shrink-0 px-3 py-2 sm:px-4 sm:py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex-1 min-w-0">
          <CustomerSearch variant="topbar" onModalOpenChange={onCustomerModalOpenChange} />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {showTableButton && (
            <button
              type="button"
              onClick={onShowTablePicker}
              data-testid="cart-table-button"
              className="touch-target shrink-0 gap-2 rounded-lg border border-border bg-card ps-1.5 pe-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted active:bg-muted whitespace-nowrap"
              title={t('selectTable')}
              aria-label={tableName ? t('tableLabel', { name: tableName }) : t('selectTable')}
            >
              <span className="flex size-8 items-center justify-center rounded-md bg-yellow-400 text-yellow-950">
                <UtensilsCrossed size={16} />
              </span>
              <span className="text-base font-bold tabular-nums">{tableName ?? '—'}</span>
              <span
                aria-hidden="true"
                className="hidden sm:inline-flex rounded border border-current px-1 text-[10px] font-mono opacity-60"
              >
                F2
              </span>
            </button>
          )}

          <div className="shrink-0">
            <PrinterStatus />
          </div>
          <DropdownMenu onOpenChange={onActionsMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="touch-target shrink-0 rounded-lg border border-border bg-card px-3 text-muted-foreground transition-colors hover:bg-muted active:bg-muted"
                title={t('moreActions')}
                aria-label={t('moreActions')}
              >
                <EllipsisVertical size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onShowCashMovement}>
                <Banknote size={16} />
                {tDashboard('cashMovement')}
              </DropdownMenuItem>
              {canUseShift && (
                <DropdownMenuItem
                  onSelect={onShowShift}
                  disabled={shiftLoading}
                  title={shiftError ?? undefined}
                >
                  {shiftHasOpenSession ? <Lock size={16} /> : <LockOpen size={16} />}
                  {shiftHasOpenSession ? tDashboard('closeShiftSession') : tDashboard('openShift')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onShowPrintMenu}>
                <Printer size={16} />
                {tProducts('printMenu')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            data-testid="pos-lock-button"
            onClick={() => {
              void lock();
            }}
            className="touch-target shrink-0 rounded-lg border border-border bg-card px-3 text-muted-foreground transition-colors hover:bg-muted active:bg-muted"
            title={t('lockTerminal')}
            aria-label={t('lockTerminal')}
          >
            <Lock size={16} />
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
