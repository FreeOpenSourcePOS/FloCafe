'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import axios from 'axios';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { Banknote, ChefHat, Clock, LayoutGrid, TrendingUp, ClipboardList, ArrowRight, Timer, Trophy, Tags, BarChart3, Wallet, RotateCcw, ReceiptText, Hourglass, CalendarDays, Lock, Loader2, Printer, AlertTriangle, X } from 'lucide-react';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { ORDER_STATUS_LABEL_KEYS } from '@/lib/i18n-enums';
import { splitHoursMinutes } from '@/lib/table-timing';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';
import { printerService } from '@/lib/printer/PrinterService';

interface PaymentMethodBreakdown {
  method: string | null;
  count: number;
  total: number;
}

interface DailyStats {
  sales: number;
  runningOrders: number;
  pendingOrders: number;
  tablesOccupied: number;
  avgTableTurnMinutes?: number | null;
  paymentMethods: PaymentMethodBreakdown[];
}

interface DaySummary {
  date: string;
  orders: { count: number; total: number };
  bills: { count: number; total: number; collected: number };
  customers: { new: number };
  paymentMethods: PaymentMethodBreakdown[];
}

interface RefundActivity {
  id: number;
  amount: number;
  method: string;
  reason: string | null;
  created_at: string;
  bill_number: string;
  paid_at: string;
  order_number: string;
  approved_by_name: string;
}

interface FinancialSummary {
  startDate: string;
  endDate: string;
  grossCollected: number;
  refunded: number;
  netCollected: number;
  billCount: number;
  refundCount: number;
  averageOrderValue: number;
  paymentMethods: PaymentMethodBreakdown[];
  refunds: RefundActivity[];
}

interface TopProduct {
  product_id: number;
  product_name: string;
  total_quantity: number;
  total_revenue: number;
  order_count: number;
}

interface RecentOrder {
  id: number;
  order_number: string;
  status: string;
  total: number;
  customer_name: string | null;
  table_name: string | null;
  created_at: string;
}

interface TopStaff {
  user_id: string;
  name: string;
  role: string;
  revenue: number;
  orderCount: number;
}

interface TopCategory {
  category_id: string | null;
  name: string;
  quantity: number;
  revenue: number;
}

interface HourBucket {
  hour: number;
  orderCount: number;
}

interface DayBucket {
  dayIndex: number;
  orderCount: number;
}

/** Live day aggregates returned by GET /api/reports/x-report. Display totals
 *  are in tenant major units (minorFactor-divided); expectedCashCents is the
 *  integer-cents drawer expected figure. Do not rename fields — the backend
 *  contract is fixed by main/routes/reports.ts. */
interface XReport {
  businessDate: string;
  periodStart: string;
  periodEnd: string;
  grossCollected: number;
  refunded: number;
  netCollected: number;
  billCount: number;
  refundCount: number;
  paymentMethods: { method: string | null; count: number; total: number }[];
  staffSales: { user_id: string; name: string; role: string; revenue: number; orderCount: number }[];
  taxComponents: unknown[];
  /** Drawer expected figure in INTEGER cents (no opening float — the float
   *  is captured at close). Cash-only raw filter, refunds by created_at. */
  expectedCashCents: number;
  /** F3: server-resolved prior close (most recent scope='day' row with
   *  business_date < this.businessDate). Both fields are null when no
   *  prior close exists. The frontend ONLY shows the "no prior close"
   *  hint when priorBusinessDate === null AND the X fetch succeeded —
   *  never on a transport error, so a network blip cannot be confused
   *  with a clean store history. */
  priorClosedCashCents: number | null;
  priorBusinessDate: string | null;
  alreadyClosed: boolean;
}

/** Immutable close-of-day snapshot returned by POST /api/cash-closures and
 *  GET /api/reports/z-report. Money fields are integer cents. */
interface ZReport {
  id: number;
  scope: string;
  business_date: string;
  period_start: string;
  period_end: string;
  opening_float_cents: number;
  expected_cash_cents: number;
  counted_cash_cents: number;
  variance_cents: number;
  gross_collected_cents: number;
  refunded_cents: number;
  net_collected_cents: number;
  bill_count: number;
  refund_count: number;
  payment_methods: { method: string; count: number; total_cents: number }[];
  staff_sales: { user_id: string; name: string; role: string; revenue_cents: number; orderCount: number }[];
  tax_components: unknown[];
  z_number: number;
  closed_by: string;
  notes: string | null;
  created_at: string;
}

interface Insights {
  windowDays: number;
  aov: number;
  avgPrepTimeMinutes: number | null;
  topStaff: TopStaff[];
  topCategories: TopCategory[];
  busiestHour: HourBucket | null;
  idlestHour: HourBucket | null;
  busiestDayOfWeek: DayBucket | null;
  idlestDayOfWeek: DayBucket | null;
}

/** Today's date as YYYY-MM-DD in a given IANA timezone (not UTC — avoids an
 *  off-by-one-day default near midnight relative to the tenant's locale). */
function getLocalDateString(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD by convention — a convenient built-in shortcut.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function getMonthRange(month: string): { startDate: string; endDate: string } {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { startDate: `${month}-01`, endDate: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/** Formats a 0-23 local hour index as a locale-appropriate time label (e.g. "2 PM"). */
function formatHourLabel(hour: number, locale: string): string {
  const reference = new Date(Date.UTC(2000, 0, 1, hour));
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(reference);
}

/** Formats a 0=Sunday..6=Saturday index as a locale-appropriate weekday name. */
function formatWeekdayLabel(dayIndex: number, locale: string): string {
  // Jan 2, 2000 was a Sunday — using local-time Date math (no timeZone
  // needed here, the hour/day bucketing already resolved to the tenant's
  // local calendar server-side).
  const reference = new Date(2000, 0, 2 + dayIndex);
  return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(reference);
}

const orderStatusColor: Record<string, string> = {
  pending: 'text-yellow-600',
  preparing: 'text-blue-600',
  ready: 'text-green-600',
  served: 'text-purple-600',
  completed: 'text-muted-foreground',
  cancelled: 'text-red-500',
};

type OrdersKey = keyof AppConfig['Messages']['orders'];
type PosKey = keyof AppConfig['Messages']['pos'];

// Built-in payment method label keys mapped to typed `pos` leaf keys.
const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const satisfies Record<'cash' | 'card', PosKey>;

export default function DashboardPage() {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const tOrders = useTranslations('orders');
  const router = useRouter();
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  const isOwner = hasRole(currentTenant?.role, ROLE_ACCESS.owner);
  const fmt = useFormatCurrency();
  const { formatDateTime } = useFormatDate();
  const locale = useLocale();
  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayLocal = getLocalDateString(new Date(), timeZone);
  const [selectedDate, setSelectedDate] = useState(todayLocal);
  const [selectedMonth, setSelectedMonth] = useState(todayLocal.slice(0, 7));
  const [periodMode, setPeriodMode] = useState<'day' | 'month'>('day');
  const dayInputRef = useRef<HTMLInputElement>(null);
  const monthInputRef = useRef<HTMLInputElement>(null);
  const isToday = periodMode === 'day' && selectedDate === todayLocal;
  const range = periodMode === 'month'
    ? getMonthRange(selectedMonth)
    : { startDate: selectedDate, endDate: selectedDate };

  /** Opens Chromium's native calendar UI while preserving keyboard fallback. */
  const openPicker = (input: HTMLInputElement | null) => {
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      // Older embedded Chromium builds may not expose showPicker. Focusing the
      // native input still leaves keyboard date entry available.
      input.focus();
    }
  };

  useEffect(() => {
    if (currentTenant && !isOwner) {
      router.replace('/pos');
    }
  }, [currentTenant, isOwner, router]);

  // Show the spinner again as soon as isOwner/selectedDate change, read directly during
  // render (React's recommended pattern for "adjusting state when a prop changes") so the
  // effect below only needs to own the async fetch and its own completion state.
  const syncKey = `${isOwner}:${periodMode}:${range.startDate}:${range.endDate}`;
  const [syncedKey, setSyncedKey] = useState(syncKey);
  if (syncKey !== syncedKey) {
    setSyncedKey(syncKey);
    if (isOwner) setLoading(true);
  }

  useEffect(() => {
    if (!isOwner) return;
    const controller = new AbortController();
    const scopedSummary = periodMode === 'month'
      ? Promise.resolve(null)
      : isToday
        ? api.get('/reports/daily-stats', { signal: controller.signal })
        : api.get('/reports/summary', { params: { date: selectedDate }, signal: controller.signal });
    Promise.all([
      scopedSummary,
      api.get('/reports/financial-summary', { params: { start_date: range.startDate, end_date: range.endDate }, signal: controller.signal }),
      api.get('/reports/topProducts', { params: { start_date: range.startDate, end_date: range.endDate, limit: 5 }, signal: controller.signal }),
      api.get('/reports/recentOrders', {
        params: periodMode === 'month'
          ? { start_date: range.startDate, end_date: range.endDate, limit: 6 }
          : { date: selectedDate, limit: 6 },
        signal: controller.signal,
      }),
      api.get('/reports/insights', { params: { days: 30 }, signal: controller.signal }),
    ])
      .then(([statsRes, financialRes, topRes, recentRes, insightsRes]) => {
        setStats(isToday && statsRes ? statsRes.data : null);
        setDaySummary(!isToday && statsRes ? statsRes.data.summary : null);
        setFinancialSummary(financialRes.data.financialSummary);
        setTopProducts(topRes.data.topProducts || []);
        setRecentOrders(recentRes.data.recentOrders || []);
        setInsights(insightsRes.data);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        toast.error(tCommon('somethingWrong'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, periodMode, selectedDate, selectedMonth]);

  // ── Close-day modal state ────────────────────────────────────────────────
  // Modal flow: open → load X (live aggregates) + prior-day Z (default float)
  // → operator edits float + counted → POST /cash-closures → immutable Z view
  // → optional print. Currency math stays in INTEGER cents end-to-end (the
  // backend stores cents and returns display totals; we convert to cents at
  // the POST boundary via the unit adapter, and back to display for the
  // preview).
  const [closeOpen, setCloseOpen] = useState(false);
  // Bumping this token is how we re-trigger the load effect on each open.
  // Reset of the form fields happens during render via the token comparison
  // below (React-recommended idiom for "adjusting state when a prop
  // changes" — mirrors the existing `syncKey`/`setSyncedKey` pattern above).
  const [openToken, setOpenToken] = useState(0);
  const [businessDate, setBusinessDate] = useState(todayLocal);
  const [xReport, setXReport] = useState<XReport | null>(null);
  const [xLoading, setXLoading] = useState(false);
  const [xError, setXError] = useState<string | null>(null);
  // F3: derive a token from `openToken + businessDate`. The render-time
  // `if (closeOpen && xToken !== refXToken)` block wipes stale X-report
  // state when the token changes (modal open OR operator picks a different
  // date). Derives from existing state instead of carrying a separate
  // counter so the wipe is automatic — same pattern as the `syncKey`
  // block above (recommended by React for "adjusting state when a prop
  // changes" and avoids the cascading-renders ESLint rule).
  const xToken = `${openToken}:${businessDate}`;
  const [refXToken, setRefXToken] = useState(xToken);
  const [openingFloatInput, setOpeningFloatInput] = useState('');
  const [countedInput, setCountedInput] = useState('');
  const [submittingClose, setSubmittingClose] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // F4: local override of `xReport.alreadyClosed` for the case where the
  // operator's POST hits a 409 (the X report still says alreadyClosed:false
  // until it re-fetches, so the Submit button would stay enabled and the
  // pre-existing 409 path would loop). Mirrors the X-report flag locally.
  const [alreadyClosedOverride, setAlreadyClosedOverride] = useState(false);
  const [closedZ, setClosedZ] = useState<ZReport | null>(null);
  const [printingZ, setPrintingZ] = useState(false);
  const [hasPrintedFresh, setHasPrintedFresh] = useState(false);
  const unitAdapter = useCurrencyUnitAdapter();
  // Storage minor-unit factor (`Math.pow(10, fractionDigits)`) is the cents
  // denominator; the adapter's `maxDecimals` would be wrong for IRR/Toman
  // (where display has 3 decimals but storage is still Rial-cents, factor 100).
  const minorFactor = getCurrencyMinorUnitFactor(currentTenant?.currency || 'INR');

  // Prior business date = day before the modal's date. ISO date arithmetic on
  // the YYYY-MM-DD string is timezone-safe — no need for `localDateInTimezone`
  // in the renderer.
  const shiftDate = (yyyymmdd: string, deltaDays: number): string => {
    const d = new Date(`${yyyymmdd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  };

  useEffect(() => {
    if (!closeOpen) return;
    const controller = new AbortController();
    const isActive = () => !controller.signal.aborted;
    // Use the operator-selected date so past-day closes work.
    api.get('/reports/x-report', { params: { date: businessDate }, signal: controller.signal })
      .then((res) => {
        if (!isActive()) return;
        setXReport(res.data.xReport);
        const xr = res.data.xReport;
        // F3: prior close is now part of the X envelope. Prefill the
        // opening-float input ONLY on a clean X fetch (xError stays null
        // here) and ONLY when the backend reports a prior close. The
        // GET /reports/x-report route returns null fields when no prior
        // close exists; we use that as the explicit "no prior close"
        // signal — transport errors set xError, leaving priorBusinessDate
        // null WITHOUT triggering the noPriorCloseHint (F7 discipline).
        if (!xError && xr) {
          if (xr.priorClosedCashCents !== null && xr.priorBusinessDate) {
            // F2: convert to display units via the adapter (Toman/Rial etc.)
            setOpeningFloatInput(unitAdapter.toDisplay(xr.priorClosedCashCents / minorFactor).toString());
            setAlreadyClosedOverride(false);
          } else {
            // F1: no prior close for this date — reset the prefill so a
            // POST cannot submit a stale value from a previously-closed
            // day, and clear any stale alreadyClosed override (a 409 on
            // day A must not leave a false closed banner + disabled
            // submit on unclosed day B).
            setOpeningFloatInput('');
            setAlreadyClosedOverride(false);
          }
        }
        // F4: if the day is already closed, hydrate the closed-Z view so
        // the operator can read/reprint the snapshot without POSTing a
        // second close.
        if (xr?.alreadyClosed) {
          return api.get('/reports/z-report', { params: { date: businessDate }, signal: controller.signal })
            .then((zRes) => {
              if (!isActive()) return;
              if (zRes.data?.zReport) {
                setClosedZ(zRes.data.zReport);
                setHasPrintedFresh(false);
              }
            })
            .catch((err: unknown) => {
              if (axios.isCancel(err) || (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) return;
              if (!isActive()) return;
              // 404 means the X said closed but Z is missing — fall back
              // to the banner. Any other error is logged and toasted because
              // the X envelope alone already gave us the alreadyClosed banner
              // content but the operator should know the printed Z could
              // not be hydrated (reprint/snapshot-read).
              if (axios.isAxiosError(err) && err.response?.status === 404) return;
              const msg = axios.isAxiosError(err) ? err.response?.data?.error || err.message : (err instanceof Error ? err.message : 'Failed to load closed Z');
              console.warn('[cierre] hydrate z-report failed:', msg);
              toast.error(tCommon('somethingWrong'));
            });
        }
        return undefined;
      })
      .catch((err: unknown) => {
        if (axios.isCancel(err) || (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) return;
        if (!isActive()) return;
        setXError(axios.isAxiosError(err) ? err.response?.data?.error || err.message : (err instanceof Error ? err.message : 'Failed to load day'));
      })
      .finally(() => {
        if (isActive()) setXLoading(false);
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeOpen, openToken, businessDate]);

  // Reset modal state at the start of each new open (React-recommended
  // pattern for "adjusting state when a prop changes" — the equivalent of
  // a class component's `getDerivedStateFromProps`; mirrors the existing
  // `syncKey` / `setSyncedKey` pattern in this file).
  const [resetToken, setResetToken] = useState(0);
  if (closeOpen && resetToken !== openToken) {
    setResetToken(openToken);
    setXLoading(true);
    setXError(null);
    setXReport(null);
    // (priorFloatCents removed: the backend's xReport.priorBusinessDate is
    // the unambiguous source of truth for the no-prior-close hint.)
    setAlreadyClosedOverride(false);
    setBusinessDate(todayLocal);
    setOpeningFloatInput('');
    setCountedInput('');
    setSubmitError(null);
    setClosedZ(null);
    setHasPrintedFresh(false);
  }
  // F3: render-time wipe of stale X state when the operator changes the
  // business date inside the modal. Token derives from openToken +
  // businessDate so it changes on either event. Same pattern as the
  // `syncKey` block above (recommended by React for "adjusting state when
  // a prop changes" and avoids the cascading-renders ESLint rule).
  // F1/F2: also reset counted/submit-error/closed-Z/printed-fresh so a
  // value typed for day A cannot carry into day B's immutable close (F1)
  // and so changing dates after closing day A leaves no stale Z in view (F2).
  if (closeOpen && xToken !== refXToken) {
    setRefXToken(xToken);
    setXLoading(true);
    setXError(null);
    setXReport(null);
    setCountedInput('');
    setSubmitError(null);
    setClosedZ(null);
    setHasPrintedFresh(false);
  }

  const openCloseModal = () => {
    setOpenToken((n) => n + 1);
    setCloseOpen(true);
  };

  // Convert a display-amount input string to integer cents. The adapter's
  // `toStored` returns the value in MAJOR units (Rial for IRR/Toman — the
  // adapter folds the Toman-to-Rial ratio itself), so multiplying by the
  // storage minor factor gives integer cents. Empty/invalid → 0.
  const displayToCents = (raw: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(unitAdapter.toStored(n) * minorFactor);
  };

  const openingFloatCents = displayToCents(openingFloatInput);
  const countedCashCents = displayToCents(countedInput);
  const expectedCashTotalCents = xReport ? xReport.expectedCashCents + openingFloatCents : 0;
  const varianceCents = countedCashCents - expectedCashTotalCents;

  const submitClose = async () => {
    if (!xReport) return;
    setSubmittingClose(true);
    setSubmitError(null);
    try {
      const res = await api.post('/cash-closures', {
        business_date: businessDate,
        opening_float_cents: openingFloatCents,
        counted_cash_cents: countedCashCents,
      });
      setClosedZ(res.data.zReport);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        // The backend's 409 carries alreadyClosed; surface the message and
        // keep the form so the operator can retry once they have the prior Z.
        setSubmitError(t('alreadyClosed'));
        // F4: the X report still says alreadyClosed:false until it re-fetches.
        // Set the local override so the Submit button disables immediately and
        // the alreadyClosed banner shows without waiting for a re-fetch.
        setAlreadyClosedOverride(true);
      } else {
        const msg = axios.isAxiosError(err)
          ? err.response?.data?.error || err.message
          : (err instanceof Error ? err.message : 'Close failed');
        setSubmitError(msg);
      }
    } finally {
      setSubmittingClose(false);
    }
  };

  // POST /cash-closures/:id/print. Mirrors main/routes/cash-closures.ts:471-505:
  // network/usb printers print server-side and return { success, isReprint };
  // webusb printers return { success, webusb: true, isReprint, bytes } and the
  // renderer dispatches the bytes through printerService.print().
  // F5: returns true on the first successful print so the caller can flip
  // the hasPrintedFresh flag. The button must NOT flip on failure — a
  // failed first print should still offer "Print Z" (not "Reprint"), so the
  // operator can see it never actually printed.
  const printZ = async (z: ZReport, isReprint = false): Promise<boolean> => {
    setPrintingZ(true);
    try {
      const res = await api.post(`/cash-closures/${z.id}/print`, { isReprint });
      if (res.data?.webusb && Array.isArray(res.data.bytes)) {
        await printerService.print(Uint8Array.from(res.data.bytes));
        toast.success(t(isReprint ? 'reprintZ' : 'printZReport'));
        return true;
      } else if (res.data?.success) {
        toast.success(t(isReprint ? 'reprintZ' : 'printZReport'));
        return true;
      } else {
        toast.error(tCommon('somethingWrong'));
        return false;
      }
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error || err.response?.data?.detail || err.message
        : (err instanceof Error ? err.message : 'Print failed');
      toast.error(msg);
      return false;
    } finally {
      setPrintingZ(false);
    }
  };

  if (!isOwner) return null;

  const paymentMethods = financialSummary?.paymentMethods ?? [];
  const paymentMethodsTotal = paymentMethods.reduce((sum, pm) => sum + Number(pm.total), 0);

  // Running/Pending Orders and Tables Occupied are live, "right now" concepts
  // that don't retroactively apply to a past date (an order isn't "pending"
  // in history — it has a final status). When viewing a past date, swap them
  // for the day's actual totals from /reports/summary instead.
  const dateScopedTiles = periodMode === 'month'
    ? [
        {
          label: t('billsCollected'),
          value: financialSummary?.billCount ?? 0,
          icon: ReceiptText,
          color: 'bg-blue-50 border-blue-200',
          iconColor: 'text-blue-600',
          href: '/orders',
        },
        {
          label: t('refundCount'),
          value: financialSummary?.refundCount ?? 0,
          icon: RotateCcw,
          color: 'bg-red-50 border-red-200',
          iconColor: 'text-red-600',
          href: '/orders',
        },
      ]
    : isToday
    ? [
        {
          label: t('runningOrders'),
          value: stats?.runningOrders ?? 0,
          icon: ChefHat,
          color: 'bg-blue-50 border-blue-200',
          iconColor: 'text-blue-600',
          href: '/orders',
        },
        {
          label: t('pendingOrders'),
          value: stats?.pendingOrders ?? 0,
          icon: Clock,
          color: 'bg-yellow-50 border-yellow-200',
          iconColor: 'text-yellow-600',
          href: '/orders',
        },
        {
          label: t('tablesOccupied'),
          value: stats?.tablesOccupied ?? 0,
          icon: LayoutGrid,
          color: 'bg-purple-50 border-purple-200',
          iconColor: 'text-purple-600',
          href: '/tables',
        },
        {
          label: t('avgTableTurn'),
          value: (() => {
            if (stats?.avgTableTurnMinutes == null) return '—';
            const { h, m } = splitHoursMinutes(stats.avgTableTurnMinutes);
            return h > 0 ? tCommon('timeHoursMinutes', { h, m }) : tCommon('timeMinutes', { m });
          })(),
          icon: Hourglass,
          color: 'bg-cyan-50 border-cyan-200',
          iconColor: 'text-cyan-600',
          href: '/tables',
        },
      ]
    : [
        {
          label: t('orders'),
          value: daySummary?.orders.count ?? 0,
          icon: ChefHat,
          color: 'bg-blue-50 border-blue-200',
          iconColor: 'text-blue-600',
          href: '/orders',
        },
        {
          label: t('newCustomers'),
          value: daySummary?.customers.new ?? 0,
          icon: Clock,
          color: 'bg-yellow-50 border-yellow-200',
          iconColor: 'text-yellow-600',
          href: '/customers',
        },
      ];

  const financialTiles = periodMode === 'month'
    ? [
        {
          label: t('grossCollections'),
          value: fmt(financialSummary?.grossCollected ?? 0),
          icon: Banknote,
          color: 'bg-emerald-50 border-emerald-200',
          iconColor: 'text-emerald-700',
          href: '/orders',
        },
        {
          label: t('refunds'),
          value: fmt(financialSummary?.refunded ?? 0),
          icon: RotateCcw,
          color: 'bg-red-50 border-red-200',
          iconColor: 'text-red-600',
          href: '/orders',
        },
      ]
    : [];

  const tiles = [
    {
      label: periodMode === 'month' ? t('netCollections') : isToday ? t('todaySales') : t('sales'),
      value: fmt(financialSummary?.netCollected ?? 0),
      icon: Banknote,
      color: 'bg-green-50 border-green-200',
      iconColor: 'text-green-600',
      href: '/orders',
    },
    ...financialTiles,
    ...dateScopedTiles,
    {
      label: t('aov'),
      value: fmt(financialSummary?.averageOrderValue ?? 0),
      icon: TrendingUp,
      color: 'bg-teal-50 border-teal-200',
      iconColor: 'text-teal-600',
      href: '/orders',
    },
    ...(periodMode === 'day' ? [{
      label: t('avgPrepTime'),
      value: insights?.avgPrepTimeMinutes != null ? t('minutesValue', { minutes: insights.avgPrepTimeMinutes }) : '—',
      icon: Timer,
      color: 'bg-orange-50 border-orange-200',
      iconColor: 'text-orange-600',
      href: '/orders',
    }] : []),
  ];

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <div className="flex items-center gap-2">
          <div className="flex h-9 rounded-lg border border-border bg-card p-1" role="group" aria-label={t('periodView')}>
            {(['day', 'month'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setPeriodMode(mode)}
                className={`min-w-16 rounded-md px-3 text-sm font-medium transition-colors ${periodMode === mode ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
                aria-pressed={periodMode === mode}
              >
                {t(mode)}
              </button>
            ))}
          </div>
          {periodMode === 'day' ? (
            <div className="relative">
              <input
                ref={dayInputRef}
                type="date"
                value={selectedDate}
                max={todayLocal}
                onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
                className="h-9 ps-3 pe-10 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30"
                aria-label={t('selectDate')}
              />
              <button
                type="button"
                onClick={() => openPicker(dayInputRef.current)}
                className="absolute inset-y-0 end-0 z-10 flex w-9 items-center justify-center rounded-e-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('openDatePicker')}
              >
                <CalendarDays size={16} />
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                ref={monthInputRef}
                type="month"
                value={selectedMonth}
                max={todayLocal.slice(0, 7)}
                onChange={(e) => e.target.value && setSelectedMonth(e.target.value)}
                className="h-9 ps-3 pe-10 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30"
                aria-label={t('selectMonth')}
              />
              <button
                type="button"
                onClick={() => openPicker(monthInputRef.current)}
                className="absolute inset-y-0 end-0 z-10 flex w-9 items-center justify-center rounded-e-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('openMonthPicker')}
              >
                <CalendarDays size={16} />
              </button>
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={openCloseModal}
            className="h-9"
          >
            <Lock size={14} />
            {t('closeShift')}
          </Button>
        </div>
      </div>

      {/* ── Close-day modal ─────────────────────────────────────────────── */}
      <Dialog open={closeOpen} onOpenChange={(next) => {
        // Block mid-submit close so the operator can't drop a POST in flight.
        if (!next && submittingClose) return;
        setCloseOpen(next);
      }}>
        <DialogContent
          className="sm:max-w-lg max-h-[90vh] flex flex-col"
          // The browser-native date picker popup renders outside the Radix
          // portal; without this, clicking a day closes the modal and the
          // date selection is swallowed. Spec requires past-date late closes.
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock size={18} className="text-foreground" />
              {t('closeShift')}
              {xReport && !closedZ && (
                <span className="ms-2 text-sm font-normal text-muted-foreground"><Ltr>{xReport.businessDate}</Ltr></span>
              )}
            </DialogTitle>
            <DialogDescription>
              {closedZ ? t('zReport') : t('xReport')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-4">
            {/* ── Closed Z view ── */}
            {closedZ && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">{t('openingFloat')}</p>
                    <p className="text-base font-semibold text-foreground"><Ltr>{fmt(closedZ.opening_float_cents / minorFactor)}</Ltr></p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">{t('expectedCash')}</p>
                    <p className="text-base font-semibold text-foreground"><Ltr>{fmt(closedZ.expected_cash_cents / minorFactor)}</Ltr></p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">{t('countedCash')}</p>
                    <p className="text-base font-semibold text-foreground"><Ltr>{fmt(closedZ.counted_cash_cents / minorFactor)}</Ltr></p>
                  </div>
                  <div className={`rounded-lg border p-3 ${closedZ.variance_cents === 0 ? 'border-border' : closedZ.variance_cents < 0 ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'}`}>
                    <p className="text-xs text-muted-foreground">{t('variance')}</p>
                    <p className={`text-base font-semibold ltr-island ${closedZ.variance_cents === 0 ? 'text-foreground' : closedZ.variance_cents < 0 ? 'text-red-700' : 'text-amber-700'}`}>
                      <Ltr>{fmt(closedZ.variance_cents / minorFactor)}</Ltr>
                    </p>
                  </div>
                </div>
                <div className="rounded-lg border border-border p-3 bg-muted/40">
                  <p className="text-sm font-medium text-foreground">{t('billsCount', { count: closedZ.bill_count })}</p>
                </div>
                {closedZ.notes && (
                  <div className="rounded-lg border border-border p-3 bg-muted/40">
                    <p className="text-xs text-muted-foreground">{t('closureNotes')}</p>
                    <p className="text-sm text-foreground whitespace-pre-wrap">{closedZ.notes}</p>
                  </div>
                )}
              </div>
            )}

            {/* ── Form / X-loading view ── */}
            {!closedZ && (
              <>
                {xLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                    <Loader2 size={16} className="animate-spin" />
                    {tCommon('loading')}
                  </div>
                )}
                {xError && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                    <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                    <span>{xError}</span>
                  </div>
                )}
                {xReport && (
                  <>
                    <div>
                      <label htmlFor="business-date" className="block text-sm text-muted-foreground mb-1">
                        {t('businessDateLabel')}
                      </label>
                      <input
                        id="business-date"
                        type="date"
                        value={businessDate}
                        min={shiftDate(todayLocal, -365)}
                        max={todayLocal}
                        onChange={(e) => {
                          const next = e.target.value;
                          if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
                          // Client guardrail: backend remains the authority and
                          // will 400 a future date; this just keeps the picker
                          // honest.
                          if (next > todayLocal) return;
                          setBusinessDate(next);
                        }}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
                      />
                    </div>
                    {(xReport.alreadyClosed || alreadyClosedOverride) && !closedZ && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                        <span>{t('alreadyClosed')}</span>
                      </div>
                    )}
                    <div className="rounded-lg border border-border p-3 bg-muted/40">
                      <p className="text-xs text-muted-foreground">{t('expectedCashSalesOnly')}</p>
                      <p className="text-lg font-semibold text-foreground"><Ltr>{fmt(xReport.expectedCashCents / minorFactor)}</Ltr></p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('billsCount', { count: xReport.billCount })}
                        {' · '}
                        {t('paymentsCount', { count: xReport.paymentMethods.reduce((sum, pm) => sum + pm.count, 0) - xReport.refundCount })}
                      </p>
                    </div>

                    <div>
                      <label htmlFor="opening-float" className="block text-sm text-muted-foreground mb-1">
                        {t('openingFloat')}
                      </label>
                      <input
                        id="opening-float"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={unitAdapter.step}
                        value={openingFloatInput}
                        onChange={(e) => setOpeningFloatInput(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
                      />
                      {xReport.priorBusinessDate === null && !xReport.alreadyClosed && (
                        <p className="text-xs text-amber-700 mt-1">{t('noPriorCloseHint')}</p>
                      )}
                    </div>

                    <div>
                      <label htmlFor="counted-cash" className="block text-sm text-muted-foreground mb-1">
                        {t('countedCash')}
                      </label>
                      <input
                        id="counted-cash"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={unitAdapter.step}
                        value={countedInput}
                        onChange={(e) => setCountedInput(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('expectedCash')}: <Ltr>{fmt(expectedCashTotalCents / minorFactor)}</Ltr>
                      </p>
                    </div>

                    <div className={`rounded-lg border p-3 ${varianceCents === 0 ? 'border-border bg-muted/40' : varianceCents < 0 ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'}`}>
                      <p className="text-xs text-muted-foreground">{t('variance')}</p>
                      <p className={`text-lg font-semibold ltr-island ${varianceCents === 0 ? 'text-foreground' : varianceCents < 0 ? 'text-red-700' : 'text-amber-700'}`}>
                        <Ltr>{fmt(varianceCents / minorFactor)}</Ltr>
                      </p>
                    </div>

                    {submitError && (
                      <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                        <span>{submitError}</span>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            {closedZ ? (
              <>
                <Button variant="outline" onClick={() => setCloseOpen(false)}>
                  {tCommon('close')}
                </Button>
                {hasPrintedFresh ? (
                  <Button onClick={() => printZ(closedZ, true)} disabled={printingZ}>
                    {printingZ ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                    {t('reprintZ')}
                  </Button>
                ) : (
                  <Button onClick={async () => {
                    // F5: only flip to "Reprint" after the first print succeeds.
                    // A failed first print leaves the operator with another
                    // "Print Z" attempt, not a misleading "Reprint" button.
                    // Hydrate ceiling (v1): a hydrated Z (page-load view of an
                    // already-closed day) cannot be distinguished from a fresh
                    // print, so it is sent as `isReprint=false`. True print
                    // history (count, last-printer, last-time) is untracked in
                    // v1 by design; revisit when v2 adds print audit columns.
                    const ok = await printZ(closedZ, false);
                    if (ok) setHasPrintedFresh(true);
                  }} disabled={printingZ}>
                    {printingZ ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                    {t('printZReport')}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setCloseOpen(false)} disabled={submittingClose}>
                  <X size={14} />
                  {tCommon('cancel')}
                </Button>
                <Button onClick={submitClose} disabled={submittingClose || !xReport || countedInput === '' || xReport.alreadyClosed || alreadyClosedOverride}>
                  {submittingClose ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                  {t('closeShift')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-3 border-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {tiles.map((tile) => (
              <Link
                key={tile.label}
                href={tile.href}
                className={`rounded-xl border p-5 ${tile.color} transition-transform hover:-translate-y-0.5 hover:shadow-sm`}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-muted-foreground">{tile.label}</span>
                  <tile.icon size={20} className={tile.iconColor} />
                </div>
                <p className="text-3xl font-bold text-gray-900">
                  {tile.value}
                </p>
              </Link>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Recent Orders */}
            <div className="bg-card rounded-xl border border-border dark:border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-border">
                <h2 className="flex items-center gap-2 font-semibold text-foreground">
                  <ClipboardList size={16} className="text-gray-400" />
                  {isToday ? t('recentOrders') : periodMode === 'month' ? t('monthOrders') : t('orders')}
                </h2>
                <Link href="/orders" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('viewAll')} <ArrowRight size={12} className="rtl-flip" />
                </Link>
              </div>
              {recentOrders.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">{t('noOrdersYet')}</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {recentOrders.map((order) => (
                    <Link
                      key={order.id}
                      href="/orders"
                      className="flex items-center justify-between px-4 py-2.5 hover:bg-muted transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">#<Ltr>{order.order_number}</Ltr></span>
                          <span className={`text-xs font-medium ${orderStatusColor[order.status] || 'text-muted-foreground'}`}>
                            {(() => { const k = (ORDER_STATUS_LABEL_KEYS as Record<string, OrdersKey | undefined>)[order.status]; return k ? tOrders(k) : order.status; })()}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 truncate">
                          {order.customer_name || order.table_name || t('walkIn')}
                        </p>
                      </div>
                      <span className="text-sm font-semibold text-foreground shrink-0">
                        {fmt(Number(order.total))}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Top Products Today */}
            <div className="bg-card rounded-xl border border-border dark:border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-border">
                <h2 className="flex items-center gap-2 font-semibold text-foreground">
                  <TrendingUp size={16} className="text-gray-400" />
                  {periodMode === 'month' ? t('topProductsMonth') : isToday ? t('topProductsToday') : t('topProducts')}
                </h2>
                <Link href="/products" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('viewAll')} <ArrowRight size={12} className="rtl-flip" />
                </Link>
              </div>
              {topProducts.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">{t('noSalesYet')}</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {topProducts.map((product) => (
                    <div key={product.product_id} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-foreground">{product.product_name}</span>
                        <p className="text-xs text-gray-400">{t('productSoldOrders', { quantity: product.total_quantity, orders: product.order_count })}</p>
                      </div>
                      <span className="text-sm font-semibold text-foreground shrink-0">
                        {fmt(Number(product.total_revenue))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
            {/* Top Staff */}
            <div className="bg-card rounded-xl border border-border dark:border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-border">
                <h2 className="flex items-center gap-2 font-semibold text-foreground">
                  <Trophy size={16} className="text-gray-400" />
                  {t('topStaff')}
                </h2>
                <Link href="/staff" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('viewAll')} <ArrowRight size={12} className="rtl-flip" />
                </Link>
              </div>
              {(insights?.topStaff.length ?? 0) === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">{t('noSalesYet')}</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {insights!.topStaff.map((staff) => (
                    <div key={staff.user_id} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-foreground">{staff.name}</span>
                        <p className="text-xs text-gray-400">{t('staffOrderCount', { orders: staff.orderCount })}</p>
                      </div>
                      <span className="text-sm font-semibold text-foreground shrink-0">
                        {fmt(Number(staff.revenue))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Top Categories */}
            <div className="bg-card rounded-xl border border-border dark:border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-border">
                <h2 className="flex items-center gap-2 font-semibold text-foreground">
                  <Tags size={16} className="text-gray-400" />
                  {t('topCategories')}
                </h2>
              </div>
              {(insights?.topCategories.length ?? 0) === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">{t('noSalesYet')}</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {insights!.topCategories.map((category) => (
                    <div key={category.category_id ?? category.name} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-foreground">{category.name}</span>
                        <p className="text-xs text-gray-400">{t('categoryQuantitySold', { quantity: category.quantity })}</p>
                      </div>
                      <span className="text-sm font-semibold text-foreground shrink-0">
                        {fmt(Number(category.revenue))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {periodMode === 'month' && (
            <section className="bg-card rounded-lg border border-border mt-4 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
                <div>
                  <h2 className="flex items-center gap-2 font-semibold text-foreground">
                    <RotateCcw size={16} className="text-red-500" />
                    {t('refundActivity')}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('refundActivityHint')}</p>
                </div>
                <span className="text-sm font-semibold text-red-600">{fmt(financialSummary?.refunded ?? 0)}</span>
              </div>
              {(financialSummary?.refunds.length ?? 0) === 0 ? (
                <p className="px-4 py-8 text-sm text-gray-400 text-center">{t('noRefunds')}</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {financialSummary!.refunds.map((refund) => (
                    <div key={refund.id} className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-sm font-semibold text-foreground">
                            {t('refundReference', { bill: refund.bill_number, order: refund.order_number })}
                          </span>
                          <span className="text-xs text-muted-foreground">{refund.method}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('refundApproved', { name: refund.approved_by_name })}
                          {' · '}
                          {t('refundedAt', { date: formatDateTime(refund.created_at) })}
                          {' · '}
                          {t('collectedAt', { date: formatDateTime(refund.paid_at) })}
                        </p>
                        {refund.reason && <p className="mt-1 text-xs text-muted-foreground truncate">{refund.reason}</p>}
                      </div>
                      <span className="text-base font-bold text-red-600 sm:text-end">{fmt(-Number(refund.amount))}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Payment Methods */}
          <div className="bg-card rounded-xl border border-border dark:border-border p-4 mt-4">
            <div className="flex items-center gap-2 mb-4">
              <Wallet size={16} className="text-gray-400" />
              <h2 className="font-semibold text-foreground">{t('paymentMethods')}</h2>
            </div>
            {paymentMethods.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">{t('noPaymentsYet')}</p>
            ) : (
              <div className="space-y-3">
                {paymentMethods.map((pm) => {
                  const meta = PAYMENT_METHODS.find((m) => m.key === pm.method);
                  const Icon = meta?.icon ?? Wallet;
                  const label = meta ? tPos(BUILT_IN_PAYMENT_KEYS[meta.key]) : pm.method === 'wallet' ? tPos('methodWallet') : String(pm.method || tCommon('unknown'));
                  const percent = paymentMethodsTotal > 0
                    ? Math.max(0, Math.min(100, Math.round((Number(pm.total) / paymentMethodsTotal) * 100)))
                    : 0;
                  return (
                    <div key={pm.method ?? 'unknown'}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <Icon size={14} className="text-gray-400" />
                          <span className="text-sm font-medium text-foreground">{label}</span>
                        </div>
                        <span className="text-sm font-semibold text-foreground">{fmt(Number(pm.total))}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-brand rounded-full" style={{ width: `${percent}%` }} />
                        </div>
                        <span className="text-xs text-gray-400 shrink-0">
                          {t('paymentMethodCount', { count: pm.count, percent })}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Business Patterns */}
          <div className="bg-card rounded-xl border border-border dark:border-border p-4 mt-4">
            <div className="flex items-center gap-2 mb-1">
              <BarChart3 size={16} className="text-gray-400" />
              <h2 className="font-semibold text-foreground">{t('businessPatterns')}</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              {t('businessPatternsHint', { days: insights?.windowDays ?? 30 })}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('busiestHour')}</p>
                <p className="text-lg font-bold text-foreground">
                  {insights?.busiestHour ? formatHourLabel(insights.busiestHour.hour, locale) : t('notEnoughData')}
                </p>
                {insights?.busiestHour && (
                  <p className="text-xs text-gray-400">{t('ordersCount', { count: insights.busiestHour.orderCount })}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('idlestHour')}</p>
                <p className="text-lg font-bold text-foreground">
                  {insights?.idlestHour ? formatHourLabel(insights.idlestHour.hour, locale) : t('notEnoughData')}
                </p>
                {insights?.idlestHour && (
                  <p className="text-xs text-gray-400">{t('ordersCount', { count: insights.idlestHour.orderCount })}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('busiestDay')}</p>
                <p className="text-lg font-bold text-foreground">
                  {insights?.busiestDayOfWeek ? formatWeekdayLabel(insights.busiestDayOfWeek.dayIndex, locale) : t('notEnoughData')}
                </p>
                {insights?.busiestDayOfWeek && (
                  <p className="text-xs text-gray-400">{t('ordersCount', { count: insights.busiestDayOfWeek.orderCount })}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('idlestDay')}</p>
                <p className="text-lg font-bold text-foreground">
                  {insights?.idlestDayOfWeek ? formatWeekdayLabel(insights.idlestDayOfWeek.dayIndex, locale) : t('notEnoughData')}
                </p>
                {insights?.idlestDayOfWeek && (
                  <p className="text-xs text-gray-400">{t('ordersCount', { count: insights.idlestDayOfWeek.orderCount })}</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
