'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import {
  User,
  PrinterCheck,
  PrinterX,
  Lock,
  LockOpen,
  Clock,
  Server,
  HardDrive,
  X,
  ChevronUp,
  ChevronDown,
  Loader2,
  Printer,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/auth';
import { usePrinterStore } from '@/hooks/usePrinter';
import { printerService } from '@/lib/printer/PrinterService';
import api from '@/lib/api';
import UpdateBadge from './UpdateBadge';

interface StatusInfo {
  server: string;
  memory: { heapUsed: number; heapTotal: number; rss: number };
  uptime: number;
  port: number;
}

interface CashSession {
  id: number;
  status: string;
  opened_by_name?: string;
  opening_float_cents?: number;
}

export default function StatusBar({ showUpdateBadge = true }: { showUpdateBadge?: boolean }) {
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const tSettings = useTranslations('settings');
  const tDashboard = useTranslations('dashboard');
  const tStaff = useTranslations('staff');
  const tSupport = useTranslations('support');

  const { user, currentTenant } = useAuthStore();
  const { status: printerConnStatus, hardwarePrinter } = usePrinterStore();

  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [session, setSession] = useState<CashSession | null | undefined>(undefined);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isTestingPrint, setIsTestingPrint] = useState(false);
  const [isKickingDrawer, setIsKickingDrawer] = useState(false);

  const inFlightRef = useRef(false);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);

  // Fetch Electron system status (uptime, memory, port)
  useEffect(() => {
    async function fetchStatus() {
      if (typeof window === 'undefined' || !window.electronAPI?.getStatus) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      try {
        const data = await window.electronAPI.getStatus();
        setStatus(data);
      } catch {
        // Electron status fetch error gracefully ignored
      } finally {
        inFlightRef.current = false;
      }
    }

    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  // Fetch active shift session (async continuation to satisfy cascading-renders rule)
  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    const queryShift = () => {
      const request = ++latestRequest;
      api
        .get('/cash-sessions/current')
        .then((res) => {
          if (!cancelled && request === latestRequest) setSession(res.data ?? null);
        })
        .catch(() => {
          if (!cancelled && request === latestRequest) setSession(undefined);
        });
    };

    queryShift();
    const interval = setInterval(queryShift, 15000);
    const handleShiftChange = () => {
      queryShift();
    };
    window.addEventListener('flo-shift-changed', handleShiftChange);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('flo-shift-changed', handleShiftChange);
    };
  }, []);

  const closeDrawer = useCallback(() => {
    setIsDrawerOpen(false);
    drawerToggleRef.current?.focus();
  }, []);

  // Handle drawer Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isDrawerOpen) {
        closeDrawer();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeDrawer, isDrawerOpen]);

  function formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return tCommon('timeHoursMinutes', { h: hours, m: minutes });
    return tCommon('timeMinutes', { m: minutes });
  }

  // Cashier info
  const staffName = user?.name || user?.email || tNav('user');
  const roleKey = currentTenant?.role;
  const roleLabel = roleKey
    ? roleKey === 'owner'
      ? tStaff('roleOwner')
      : roleKey === 'manager'
        ? tStaff('roleManager')
        : roleKey === 'cashier'
          ? tStaff('roleCashier')
          : roleKey === 'server'
            ? tStaff('roleServer')
            : roleKey === 'chef'
              ? tStaff('roleChef')
              : roleKey.charAt(0).toUpperCase() + roleKey.slice(1)
    : null;

  // Printer readiness
  const isPrinterReady = hardwarePrinter !== null || printerConnStatus === 'connected';
  const isPrinterConnecting = printerConnStatus === 'connecting';

  // Shift state
  const isShiftKnown = session !== undefined;
  const isShiftOpen = session?.status === 'open';

  // Hardware Quick Actions
  const handleTestPrint = async () => {
    setIsTestingPrint(true);
    try {
      const res = await api.post<{ success: boolean; webusb?: boolean; bytes?: number[] }>(
        '/printers/test-active',
      );
      if (res.data?.webusb && Array.isArray(res.data.bytes)) {
        await printerService.print(Uint8Array.from(res.data.bytes));
      }
      toast.success(tSettings('testPrintSent') || 'Test print sent!');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        tSettings('testPrintFailed') ||
        'Test print failed';
      toast.error(msg);
    } finally {
      setIsTestingPrint(false);
    }
  };

  const handleKickDrawer = async () => {
    setIsKickingDrawer(true);
    try {
      const res = await api.post<{ success: boolean; webusb?: boolean; bytes?: number[] }>(
        '/printers/kick-drawer',
      );
      if (res.data?.webusb && Array.isArray(res.data.bytes)) {
        await printerService.print(Uint8Array.from(res.data.bytes));
      }
      toast.success(tSettings('cashDrawerPulseSent'));
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        tSettings('cashDrawerPulseFailed');
      toast.error(msg);
    } finally {
      setIsKickingDrawer(false);
    }
  };

  return (
    <>
      {/* Slide-Up Telemetry & Hardware Drawer Backdrop */}
      {isDrawerOpen && (
        <div
          data-testid="telemetry-drawer-backdrop"
          onClick={closeDrawer}
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] transition-opacity"
          aria-hidden="true"
        />
      )}

      {/* Slide-Up Telemetry & Hardware Drawer */}
      <div
        data-testid="telemetry-drawer"
        role="dialog"
        aria-label={tSettings('storeDiagnostics')}
        aria-hidden={!isDrawerOpen}
        inert={!isDrawerOpen}
        className={`fixed bottom-8 left-0 right-0 z-50 max-h-[80vh] overflow-y-auto border-t border-border bg-card p-4 shadow-2xl transition-all duration-300 ease-in-out md:p-6 ${
          isDrawerOpen
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-full opacity-0'
        }`}
      >
        <div className="mx-auto max-w-5xl space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/80 pb-3">
            <div className="flex items-center gap-2">
              <Server size={18} className="text-primary" />
              <h2 className="text-sm font-semibold text-foreground">
                {tSettings('storeDiagnostics')}
              </h2>
            </div>
            <button
              type="button"
              data-testid="btn-close-telemetry-drawer"
              onClick={closeDrawer}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label={tCommon('close')}
            >
              <X size={16} />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* Quick Actions Card */}
            <div className="rounded-lg border border-border/70 bg-background/50 p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {tSettings('hardwarePrinters')}
              </h3>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-testid="btn-test-receipt-print"
                  onClick={handleTestPrint}
                  disabled={isTestingPrint}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-xs font-medium text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50 transition-colors"
                >
                  {isTestingPrint ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Printer size={14} />
                  )}
                  <span>{tSettings('testPrint')}</span>
                </button>

                <button
                  type="button"
                  data-testid="btn-kick-cash-drawer"
                  onClick={handleKickDrawer}
                  disabled={isKickingDrawer}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-xs font-medium text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50 transition-colors"
                >
                  {isKickingDrawer ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <LockOpen size={14} />
                  )}
                  <span>{tSettings('sendPulseToCashDrawer')}</span>
                </button>
              </div>
            </div>

            {/* Diagnostic Metrics Card */}
            <div className="rounded-lg border border-border/70 bg-background/50 p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {tSupport('tabDiagnostics')}
              </h3>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-md border border-border/50 bg-card p-2.5">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock size={13} />
                    <span>{tNav('uptimeLabel').trim()}</span>
                  </div>
                  <div
                    data-testid="telemetry-uptime"
                    className="mt-1 font-medium tabular-nums text-foreground"
                  >
                    {status ? formatUptime(status.uptime) : '...'}
                  </div>
                </div>

                <div className="rounded-md border border-border/50 bg-card p-2.5">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Server size={13} />
                    <span>{tNav('portLabel')}</span>
                  </div>
                  <div
                    data-testid="telemetry-port"
                    className="mt-1 font-medium tabular-nums text-foreground"
                  >
                    {status?.port || '3001'}
                  </div>
                </div>

                <div className="rounded-md border border-border/50 bg-card p-2.5">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <HardDrive size={13} />
                    <span>{tNav('heapLabel').trim()}</span>
                  </div>
                  <div
                    data-testid="telemetry-memory"
                    className="mt-1 font-medium tabular-nums text-foreground truncate"
                  >
                    {status?.memory
                      ? `${status.memory.heapUsed} / ${status.memory.heapTotal} MB`
                      : '...'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Persistent Frontline Status Bar */}
      <footer
        role="status"
        aria-live="polite"
        className="flex h-8 shrink-0 items-center justify-between border-t border-border/70 bg-background/95 px-3 text-[11px] text-muted-foreground shadow-[0_-1px_5px_rgba(15,23,42,0.035)] backdrop-blur supports-[backdrop-filter]:bg-background/85"
      >
        {/* Left: Active Cashier & Role Badge */}
        <div className="flex items-center gap-2 min-w-0" data-testid="status-bar-cashier">
          <div className="flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground shrink-0">
            <User size={12} />
          </div>
          <span
            data-testid="status-bar-cashier-name"
            className="truncate font-medium text-foreground max-w-[160px] sm:max-w-[220px]"
            title={staffName}
          >
            {staffName}
          </span>
          {roleLabel && (
            <span
              data-testid="status-bar-role-badge"
              className="inline-flex items-center rounded-full bg-secondary/80 px-2 py-0.5 text-[10px] font-medium text-secondary-foreground shrink-0"
            >
              {roleLabel}
            </span>
          )}
        </div>

        {/* Right: Thermal Printer, Shift State, and Telemetry Trigger */}
        <div className="ms-auto flex h-full items-center gap-2 sm:gap-3">
          {/* Thermal Printer Status Indicator */}
          <div
            data-testid="status-bar-printer"
            className="flex items-center gap-1.5 px-1.5 py-0.5"
            title={
              hardwarePrinter
                ? hardwarePrinter.name
                : isPrinterReady
                  ? tPos('printerReady')
                  : tSettings('printerOffline')
            }
          >
            {isPrinterReady ? (
              <>
                <PrinterCheck size={13} className="text-emerald-600 dark:text-emerald-400" />
                <span className="hidden sm:inline font-medium text-emerald-700 dark:text-emerald-300">
                  {hardwarePrinter ? hardwarePrinter.name : tPos('printerReady')}
                </span>
              </>
            ) : isPrinterConnecting ? (
              <>
                <Loader2 size={13} className="animate-spin text-amber-500" />
                <span className="hidden sm:inline text-amber-600 dark:text-amber-400">
                  {tPos('printerConnecting')}
                </span>
              </>
            ) : (
              <>
                <PrinterX size={13} className="text-muted-foreground/80" />
                <span className="hidden sm:inline text-muted-foreground">
                  {tSettings('printerOffline')}
                </span>
              </>
            )}
          </div>

          <div className="h-3 w-px bg-border/70" aria-hidden="true" />

          {/* Active Shift State Badge */}
          <div
            data-testid="status-bar-shift"
            className="flex items-center gap-1.5 px-1.5 py-0.5"
            title={
              !isShiftKnown
                ? tNav('serverUnknown')
                : isShiftOpen
                  ? tDashboard('shiftOpened')
                  : tDashboard('openShift')
            }
          >
            {!isShiftKnown ? (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-inset ring-border/70">
                {tNav('serverUnknown')}
              </span>
            ) : isShiftOpen ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200/80 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800">
                <Lock size={10} />
                <span>{tDashboard('shiftOpened')}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-inset ring-border/70">
                <LockOpen size={10} />
                <span>{tDashboard('openShift')}</span>
              </span>
            )}
          </div>

          <div className="h-3 w-px bg-border/70" aria-hidden="true" />

          {/* Slide-Up Telemetry Drawer Trigger Button */}
          <button
            type="button"
            data-testid="btn-toggle-telemetry-drawer"
            ref={drawerToggleRef}
            onClick={() => (isDrawerOpen ? closeDrawer() : setIsDrawerOpen(true))}
            className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted transition-colors"
            title={tSupport('tabDiagnostics')}
            aria-label={tSupport('tabDiagnostics')}
            aria-expanded={isDrawerOpen}
          >
            <span>{tSupport('tabDiagnostics')}</span>
            {isDrawerOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>

          {showUpdateBadge && <UpdateBadge />}
        </div>
      </footer>
    </>
  );
}
