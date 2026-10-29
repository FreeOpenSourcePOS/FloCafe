'use client';

import PrinterStatus from './PrinterStatus';
import CustomerSearch from './CustomerSearch';
import CustomerTopItems from './CustomerTopItems';
import {
  Banknote,
  CalendarClock,
  CreditCard,
  EllipsisVertical,
  Maximize2,
  Minimize2,
  LockOpen,
  Lock,
  Printer,
  Store,
  UtensilsCrossed,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Product, Counter } from '@/lib/types';
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
  onShowCloseStaffShift?: () => void;
  shiftHasOpenSession: boolean;
  shiftLoading: boolean;
  shiftError: string | null;
  canUseShift: boolean;
  onShowPrintMenu: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onCustomerModalOpenChange?: (open: boolean) => void;
  scheduledOrderCount?: number;
  blockedScheduledCount?: number;
  onShowScheduledOrders?: () => void;
  multiCounterEnabled?: boolean;
  counters?: Counter[];
  activeCounter?: Counter | null;
  onSelectCounter?: (counter: Counter | null) => void;
  paymentQueueCount?: number;
  paymentQueueBlockedCount?: number;
  onShowPaymentQueue?: () => void;
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
  onShowCloseStaffShift,
  shiftHasOpenSession,
  shiftLoading,
  shiftError,
  canUseShift,
  onShowPrintMenu,
  fullscreen,
  onToggleFullscreen,
  onCustomerModalOpenChange,
  scheduledOrderCount = 0,
  blockedScheduledCount = 0,
  onShowScheduledOrders,
  multiCounterEnabled = false,
  counters = [],
  activeCounter = null,
  onSelectCounter,
  paymentQueueCount = 0,
  paymentQueueBlockedCount = 0,
  onShowPaymentQueue,
}: Props) {
  const t = useTranslations('pos');
  const tSettings = useTranslations('settings');
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

          {onShowScheduledOrders && (
            <button
              type="button"
              onClick={onShowScheduledOrders}
              data-testid="pos-scheduled-orders-btn"
              className={`touch-target shrink-0 gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                blockedScheduledCount > 0
                  ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'
                  : 'border-border bg-card text-foreground hover:bg-muted active:bg-muted'
              }`}
              title={t('scheduledOrdersTitle')}
              aria-label={t('scheduledOrdersTitle')}
            >
              <CalendarClock size={16} />
              <span className="hidden sm:inline">{t('scheduledOrders')}</span>
              {scheduledOrderCount > 0 && (
                <span
                  data-testid={
                    blockedScheduledCount > 0
                      ? 'pos-scheduled-blocked-badge'
                      : 'pos-scheduled-count-badge'
                  }
                  className={`inline-flex min-w-5 h-5 items-center justify-center rounded-full px-1.5 text-xs font-bold tabular-nums ${
                    blockedScheduledCount > 0 ? 'bg-red-600 text-white' : 'bg-brand text-white'
                  }`}
                >
                  {scheduledOrderCount}
                </span>
              )}
            </button>
          )}

          {multiCounterEnabled && onShowPaymentQueue && (
            <button
              type="button"
              onClick={onShowPaymentQueue}
              data-testid="pos-payment-queue-btn"
              className={`touch-target shrink-0 gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                paymentQueueBlockedCount > 0
                  ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'
                  : 'border-border bg-card text-foreground hover:bg-muted active:bg-muted'
              }`}
              title={t('paymentQueue')}
              aria-label={t('paymentQueue')}
            >
              <CreditCard size={16} />
              <span className="hidden sm:inline">{t('paymentQueue')}</span>
              {paymentQueueCount > 0 && (
                <span
                  data-testid={
                    paymentQueueBlockedCount > 0
                      ? 'pos-payment-queue-blocked-badge'
                      : 'pos-payment-queue-count-badge'
                  }
                  className={`inline-flex min-w-5 h-5 items-center justify-center rounded-full px-1.5 text-xs font-bold tabular-nums ${
                    paymentQueueBlockedCount > 0 ? 'bg-red-600 text-white' : 'bg-brand text-white'
                  }`}
                >
                  {paymentQueueCount}
                </span>
              )}
            </button>
          )}

          {multiCounterEnabled && counters && counters.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="pos-counter-selector-btn"
                  className="touch-target shrink-0 gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground hover:bg-muted active:bg-muted whitespace-nowrap"
                  title={t('selectCounter')}
                >
                  <Store size={15} className="text-brand" />
                  <span className="hidden sm:inline">
                    {activeCounter ? activeCounter.name : t('selectCounter')}
                  </span>
                  {activeCounter && (
                    <span className="text-[11px] px-1.5 py-0.2 rounded bg-muted text-muted-foreground uppercase font-semibold">
                      {activeCounter.role === 'ordering'
                        ? tSettings('counterRoleOrdering')
                        : activeCounter.role === 'payment'
                          ? tSettings('counterRolePayment')
                          : tSettings('counterRoleCombined')}
                    </span>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {counters.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    data-testid={`pos-counter-option-${c.id}`}
                    onClick={() => onSelectCounter?.(c)}
                    className="flex items-center justify-between cursor-pointer"
                  >
                    <span className="font-medium">{c.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase font-semibold">
                      {c.role}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
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
              {canUseShift && !shiftHasOpenSession && onShowCloseStaffShift && (
                <DropdownMenuItem
                  onSelect={onShowCloseStaffShift}
                  disabled={shiftLoading}
                  title={shiftError ?? undefined}
                >
                  <Lock size={16} />
                  {tDashboard('closeShiftSession')}
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
