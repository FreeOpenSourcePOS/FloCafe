'use client';

import PrinterStatus from './PrinterStatus';
import CustomerSearch from './CustomerSearch';
import { useCartStore } from '@/store/cart';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { Banknote, LayoutGrid, Maximize2, Minimize2, LockOpen, Lock } from 'lucide-react';
import type { Table } from '@/lib/types';
import { useTranslations } from 'use-intl';

interface Props {
  tables: Table[];
  onShowTablePicker: () => void;
  onShowCashMovement: () => void;
  onShowShift: () => void;
  shiftHasOpenSession: boolean;
  shiftLoading: boolean;
  shiftError: string | null;
  canUseShift: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

export default function PosTopbar({ tables, onShowTablePicker, onShowCashMovement, onShowShift, shiftHasOpenSession, shiftLoading, shiftError, canUseShift, fullscreen, onToggleFullscreen }: Props) {
  const cart = useCartStore();
  const { currentTenant } = useAuthStore();
  const tablesRequired = usePosSettingsStore((s) => s.tablesRequired);
  const t = useTranslations('pos');
  const tDashboard = useTranslations('dashboard');
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const showTableBtn = isRestaurant && cart.orderType === 'dine_in' && tablesRequired;

  return (
    <div className="flex items-center gap-3 border-b bg-card shrink-0 px-4 py-2.5">
      <div className="flex-1 min-w-0">
        <CustomerSearch variant="topbar" />
      </div>

      {/* Select Table — between customer search and printer */}
      {showTableBtn && (
        <button
          onClick={onShowTablePicker}
          className={`touch-target shrink-0 gap-1.5 px-3 text-sm rounded-lg border font-medium transition-colors whitespace-nowrap ${
            cart.tableId
              ? 'bg-orange-500 text-white border-orange-500 hover:bg-orange-600'
              : 'bg-amber-50 border-amber-400 text-amber-700 hover:bg-amber-100'
          }`}
        >
          <LayoutGrid size={14} />
          {cart.tableId
            ? t('tableLabel', { name: tables.find(t => t.id === cart.tableId)?.name || cart.tableId })
            : t('selectTable')}
        </button>
      )}

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
          title={shiftError ?? (shiftHasOpenSession ? tDashboard('closeShiftSession') : tDashboard('openShift'))}
          aria-label={shiftHasOpenSession ? tDashboard('closeShiftSession') : tDashboard('openShift')}
        >
          {shiftHasOpenSession ? <Lock size={16} /> : <LockOpen size={16} />}
          <span className="hidden sm:inline">{shiftHasOpenSession ? tDashboard('closeShiftSession') : tDashboard('openShift')}</span>
        </button>
      )}

      <div className="shrink-0">
        <PrinterStatus />
      </div>
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
  );
}
