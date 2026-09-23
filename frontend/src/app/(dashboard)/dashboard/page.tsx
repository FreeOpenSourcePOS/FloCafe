'use client';

import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Banknote, BarChart3, CalendarDays, ChefHat, ChevronDown, ClipboardList, Clock, Download, FileSpreadsheet, FileText, Hourglass, LayoutGrid, Lock, Minus, ReceiptText, RotateCcw, Tags, Timer, TrendingUp, Trophy, Wallet, type LucideIcon } from 'lucide-react';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { CashCloseModal } from '@/components/dashboard/CashCloseModal';
import { useCashClose } from '@/hooks/useCashClose';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { ORDER_STATUS_LABEL_KEYS } from '@/lib/i18n-enums';
import { splitHoursMinutes } from '@/lib/table-timing';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';


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
  serviceChargeTotal: number;
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

interface WeeklyComparison {
  sales: number;
  averageOrderValue: number;
}

interface DashboardTile {
  label: string;
  value: string | number;
  icon: LucideIcon;
  color: string;
  iconBg: string;
  href: string;
  comparison?: ReactNode;
  meta?: string;
}

interface DashboardMetric {
  label: string;
  value: string;
  icon: LucideIcon;
  iconBg: string;
  comparison?: ReactNode;
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

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Formats a 0-23 local hour index as a locale-appropriate time label (e.g. "2 PM"). */
function formatHourLabel(hour: number, locale: string): string {
  const reference = new Date(Date.UTC(2000, 0, 1, hour));
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(reference);
}

/** Formats a 0=Sunday..6=Saturday index as a locale-appropriate weekday name. */
function formatWeekdayLabel(dayIndex: number, locale: string): string {
  // Reference Sunday date for locale weekday formatting.
  const reference = new Date(2000, 0, 2 + dayIndex);
  return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(reference);
}

const orderStatusColor: Record<string, string> = {
  pending: 'text-yellow-600 dark:text-yellow-400',
  preparing: 'text-blue-600 dark:text-blue-400',
  ready: 'text-green-600 dark:text-green-400',
  served: 'text-purple-600 dark:text-purple-400',
  completed: 'text-muted-foreground',
  cancelled: 'text-red-500 dark:text-red-400',
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
  const tReceipt = useTranslations('receipt');
  const router = useRouter();
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [weeklyComparison, setWeeklyComparison] = useState<WeeklyComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);

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

  // Reset loading state during render when query parameters change.
  const syncKey = `${isOwner}:${periodMode}:${range.startDate}:${range.endDate}`;
  const [syncedKey, setSyncedKey] = useState(syncKey);
  if (syncKey !== syncedKey) {
    setSyncedKey(syncKey);
    if (isOwner) setLoading(true);
  }

  useEffect(() => {
    if (!isOwner) return;
    const controller = new AbortController();
    const dailyStatsRequest = isToday
      ? api.get('/reports/daily-stats', { signal: controller.signal })
      : Promise.resolve(null);
    const scopedSummary = periodMode === 'month'
      ? Promise.resolve(null)
      : api.get('/reports/summary', { params: { date: selectedDate }, signal: controller.signal });
    const previousWeekDate = shiftDate(selectedDate, -7);
    const comparisonRequest = periodMode === 'day'
      ? api.get('/reports/financial-summary', {
          params: { start_date: previousWeekDate, end_date: previousWeekDate },
          signal: controller.signal,
        })
          .then((res) => ({
            sales: Number(res.data.financialSummary?.netCollected ?? 0),
            averageOrderValue: Number(res.data.financialSummary?.averageOrderValue ?? 0),
          }))
          .catch((err: unknown) => {
            if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) throw err;
            return null;
          })
      : Promise.resolve(null);
    Promise.all([
      dailyStatsRequest,
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
      comparisonRequest,
    ])
      .then(([statsRes, summaryRes, financialRes, topRes, recentRes, insightsRes, comparisonRes]) => {
        setStats(statsRes?.data ?? null);
        setDaySummary(summaryRes?.data?.summary ?? null);
        setFinancialSummary(financialRes.data.financialSummary);
        setTopProducts(topRes.data.topProducts || []);
        setRecentOrders(recentRes.data.recentOrders || []);
        setInsights(insightsRes.data);
        setWeeklyComparison(comparisonRes);
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

  // Day-close wizard lives in useCashClose + CashCloseModal; the page
  // only opens it and mounts it.
  const cashClose = useCashClose();

  const downloadBlob = (data: Blob, filename: string) => {
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportDailySales = async (format: 'xlsx' | 'csv') => {
    if (periodMode !== 'day' || isExporting) return;
    setIsExporting(true);
    try {
      if (format === 'xlsx') {
        const res = await api.get('/reports/daily-sales/export', {
          params: { date: selectedDate, format: 'xlsx' },
          responseType: 'blob',
        });
        downloadBlob(res.data as Blob, `daily-sales-${selectedDate}.xlsx`);
        return;
      }
      toast(t('exportCsvStarted'));
      for (const part of ['summary', 'items'] as const) {
        const res = await api.get('/reports/daily-sales/export', {
          params: { date: selectedDate, format: 'csv', part },
          responseType: 'blob',
        });
        downloadBlob(res.data as Blob, `daily-sales-${selectedDate}-${part}.csv`);
      }
    } catch {
      toast.error(tCommon('downloadFailed'));
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOwner) return null;

  const paymentMethods = financialSummary?.paymentMethods ?? [];
  const paymentMethodsTotal = paymentMethods.reduce((sum, pm) => sum + Number(pm.total), 0);

  const getComparisonBadge = (current: number, previous: number) => {
    const difference = current - previous;
    const direction = difference === 0 ? 'flat' : difference > 0 ? 'up' : 'down';
    const percent = previous === 0 ? null : Math.round((Math.abs(difference) / Math.abs(previous)) * 100);
    const Icon = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : Minus;
    const label = difference === 0
      ? t('kpiNoChangeVsSameDayLastWeek')
      : previous === 0
        ? t('kpiNewVsSameDayLastWeek')
        : t('kpiChangeVsSameDayLastWeek', { percent: `${direction === 'down' ? '-' : direction === 'up' ? '+' : ''}${percent}` });
    const tone = direction === 'up'
      ? 'bg-emerald-100/80 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
      : direction === 'down'
        ? 'bg-red-100/80 text-red-700 dark:bg-red-950/50 dark:text-red-300'
        : 'bg-muted text-muted-foreground';
    return (
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${tone}`}>
        <Icon size={13} />
        {label}
      </span>
    );
  };

  const salesComparison = weeklyComparison
    ? getComparisonBadge(financialSummary?.netCollected ?? 0, weeklyComparison.sales)
    : null;
  const aovComparison = weeklyComparison
    ? getComparisonBadge(financialSummary?.averageOrderValue ?? 0, weeklyComparison.averageOrderValue)
    : null;
  const primaryTiles: DashboardTile[] = periodMode === 'month'
    ? [
        {
          label: t('netCollections'),
          value: fmt(financialSummary?.netCollected ?? 0),
          icon: Banknote,
          color: 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-800/50 dark:bg-emerald-950/30',
          iconBg: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
          href: '/orders',
        },
        {
          label: t('grossCollections'),
          value: fmt(financialSummary?.grossCollected ?? 0),
          icon: TrendingUp,
          color: 'border-blue-200 bg-blue-50/80 dark:border-blue-800/50 dark:bg-blue-950/30',
          iconBg: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
          href: '/orders',
        },
        {
          label: tReceipt('serviceCharge'),
          value: fmt(financialSummary?.serviceChargeTotal ?? 0),
          icon: Tags,
          color: 'border-amber-200 bg-amber-50/80 dark:border-amber-800/50 dark:bg-amber-950/30',
          iconBg: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
          href: '/orders',
        },
        {
          label: t('billsCollected'),
          value: financialSummary?.billCount ?? 0,
          icon: ReceiptText,
          color: 'border-violet-200 bg-violet-50/80 dark:border-violet-800/50 dark:bg-violet-950/30',
          iconBg: 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300',
          href: '/orders',
        },
        {
          label: t('refunds'),
          value: fmt(financialSummary?.refunded ?? 0),
          icon: RotateCcw,
          color: 'border-red-200 bg-red-50/80 dark:border-red-800/50 dark:bg-red-950/30',
          iconBg: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
          href: '/orders',
        },
      ]
    : isToday
      ? [
          {
            label: t('todaySales'),
            value: fmt(financialSummary?.netCollected ?? 0),
            comparison: salesComparison,
            icon: Banknote,
            color: 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-800/50 dark:bg-emerald-950/30',
            iconBg: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
            href: '/orders',
          },
          {
            label: t('runningOrders'),
            value: stats?.runningOrders ?? 0,
            meta: t('liveNow'),
            icon: ChefHat,
            color: 'border-blue-200 bg-blue-50/80 dark:border-blue-800/50 dark:bg-blue-950/30',
            iconBg: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
            href: '/orders',
          },
          {
            label: t('pendingOrders'),
            value: stats?.pendingOrders ?? 0,
            meta: t('liveNow'),
            icon: Clock,
            color: 'border-amber-200 bg-amber-50/80 dark:border-amber-800/50 dark:bg-amber-950/30',
            iconBg: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
            href: '/orders',
          },
          {
            label: t('tablesOccupied'),
            value: stats?.tablesOccupied ?? 0,
            meta: t('liveNow'),
            icon: LayoutGrid,
            color: 'border-violet-200 bg-violet-50/80 dark:border-violet-800/50 dark:bg-violet-950/30',
            iconBg: 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300',
            href: '/tables',
          },
        ]
      : [
          {
            label: t('sales'),
            value: fmt(financialSummary?.netCollected ?? 0),
            comparison: salesComparison,
            icon: Banknote,
            color: 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-800/50 dark:bg-emerald-950/30',
            iconBg: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
            href: '/orders',
          },
          {
            label: t('orders'),
            value: daySummary?.orders.count ?? 0,
            icon: ClipboardList,
            color: 'border-blue-200 bg-blue-50/80 dark:border-blue-800/50 dark:bg-blue-950/30',
            iconBg: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
            href: '/orders',
          },
          {
            label: t('newCustomers'),
            value: daySummary?.customers.new ?? 0,
            icon: Trophy,
            color: 'border-amber-200 bg-amber-50/80 dark:border-amber-800/50 dark:bg-amber-950/30',
            iconBg: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
            href: '/customers',
          },
          {
            label: t('billsCollected'),
            value: financialSummary?.billCount ?? 0,
            icon: ReceiptText,
            color: 'border-violet-200 bg-violet-50/80 dark:border-violet-800/50 dark:bg-violet-950/30',
            iconBg: 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300',
            href: '/orders',
          },
        ];

  const secondaryMetrics: DashboardMetric[] = periodMode === 'day' && isToday
    ? [
        {
          label: t('avgTableTurn'),
          value: stats?.avgTableTurnMinutes != null
            ? (() => {
                const { h, m } = splitHoursMinutes(stats.avgTableTurnMinutes);
                return h > 0 ? tCommon('timeHoursMinutes', { h, m }) : tCommon('timeMinutes', { m });
              })()
            : '—',
          icon: Hourglass,
          iconBg: 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300',
        },
        {
          label: t('aov'),
          value: fmt(financialSummary?.averageOrderValue ?? 0),
          comparison: aovComparison,
          icon: TrendingUp,
          iconBg: 'bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300',
        },
        {
          label: t('avgPrepTime'),
          value: insights?.avgPrepTimeMinutes != null ? t('minutesValue', { minutes: insights.avgPrepTimeMinutes }) : '—',
          icon: Timer,
          iconBg: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300',
        },
      ]
    : [];

  return (
    <div className="min-h-full bg-background p-4 sm:p-6 lg:p-7">
      <div className="mb-7 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {periodMode === 'month' ? t('selectMonth') : t('selectDate')}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-start gap-2 xl:justify-end">
          {periodMode === 'day' ? (
            <div className="relative">
              <input
                ref={dayInputRef}
                type="date"
                value={selectedDate}
                max={todayLocal}
                onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
                className="h-10 appearance-none rounded-xl border border-border bg-card ps-3 pe-10 text-sm text-foreground shadow-sm [color-scheme:light] focus:outline-none focus:ring-2 focus:ring-brand/30 dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:pointer-events-none [&::-webkit-calendar-picker-indicator]:opacity-0"
                aria-label={t('selectDate')}
              />
              <button
                type="button"
                onClick={() => openPicker(dayInputRef.current)}
                className="absolute inset-y-0 end-0 z-10 flex w-9 items-center justify-center rounded-e-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
                className="h-10 appearance-none rounded-xl border border-border bg-card ps-3 pe-10 text-sm text-foreground shadow-sm [color-scheme:light] focus:outline-none focus:ring-2 focus:ring-brand/30 dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:pointer-events-none [&::-webkit-calendar-picker-indicator]:opacity-0"
                aria-label={t('selectMonth')}
              />
              <button
                type="button"
                onClick={() => openPicker(monthInputRef.current)}
                className="absolute inset-y-0 end-0 z-10 flex w-9 items-center justify-center rounded-e-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={t('openMonthPicker')}
              >
                <CalendarDays size={16} />
              </button>
            </div>
          )}

          <div className="flex h-10 rounded-xl border border-border bg-card p-1 shadow-sm" role="group" aria-label={t('periodView')}>
            {(['day', 'month'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setPeriodMode(mode)}
                className={`min-w-16 rounded-lg px-3 text-sm font-medium transition-colors ${periodMode === mode ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:bg-muted'}`}
                aria-pressed={periodMode === mode}
              >
                {t(mode)}
              </button>
            ))}
          </div>

          <span className="mx-1 hidden h-7 w-px bg-border xl:block" aria-hidden="true" />

          <Button
            type="button"
            onClick={cashClose.openCloseModal}
            className="h-10 rounded-xl bg-brand px-4 text-white shadow-sm hover:bg-brand-hover"
          >
            <Lock size={14} />
            {t('closeShift')}
          </Button>
          {periodMode === 'day' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isExporting}
                  className="h-10 rounded-xl bg-card px-4 shadow-sm"
                  title={t('exportSales')}
                >
                  <Download size={14} />
                  {t('exportSales')}
                  <ChevronDown size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => exportDailySales('xlsx')}>
                  <FileSpreadsheet size={14} />
                  {t('exportXlsx')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportDailySales('csv')}>
                  <FileText size={14} />
                  {t('exportCsv')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <CashCloseModal model={cashClose} />

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" role="status" aria-live="polite">
          <span className="sr-only">{tCommon('loading')}</span>
          {[0, 1, 2, 3].map((item) => (
            <div key={item} aria-hidden="true" className="h-36 animate-pulse rounded-2xl border border-border bg-card/70" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {primaryTiles.map((tile) => (
              <Link
                key={tile.label}
                href={tile.href}
                className={`group rounded-2xl border p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${tile.color}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="text-sm font-medium text-muted-foreground">{tile.label}</span>
                  <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tile.iconBg}`}>
                    <tile.icon size={19} />
                  </span>
                </div>
                <p className="mt-5 text-3xl font-bold tracking-tight text-foreground">
                  {tile.value}
                </p>
                <div className="mt-3 min-h-6">
                  {tile.comparison || (tile.meta && <span className="text-xs font-medium text-muted-foreground">{tile.meta}</span>)}
                </div>
              </Link>
            ))}
          </div>

          {secondaryMetrics.length > 0 && (
            <div className="mt-5 grid grid-cols-1 overflow-hidden rounded-2xl border border-border bg-card shadow-sm sm:grid-cols-3">
              {secondaryMetrics.map((metric, index) => (
                <div key={metric.label} className={`flex items-center gap-3 p-4 sm:p-5 ${index > 0 ? 'border-t border-border sm:border-s-0 sm:border-t-0 sm:border-s' : ''}`}>
                  <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${metric.iconBg}`}>
                    <metric.icon size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">{metric.label}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <p className="text-lg font-semibold text-foreground">{metric.value}</p>
                      {metric.comparison}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Recent Orders */}
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                    <ClipboardList size={16} />
                  </span>
                  <h2 className="font-semibold text-foreground">
                    {isToday ? t('recentOrders') : periodMode === 'month' ? t('monthOrders') : t('orders')}
                  </h2>
                </div>
                <Link href="/orders" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('viewAll')} <ArrowRight size={12} className="rtl-flip" />
                </Link>
              </div>
              {recentOrders.length === 0 ? (
                <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
                  <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                    <ClipboardList size={23} />
                  </span>
                  <p className="text-sm font-medium text-foreground">{t('noOrdersYet')}</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {recentOrders.map((order) => (
                    <Link
                      key={order.id}
                      href="/orders"
                      className="flex items-center justify-between px-5 py-3 transition-colors hover:bg-muted/60"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">#<Ltr>{order.order_number}</Ltr></span>
                          <span className={`text-xs font-medium ${orderStatusColor[order.status] || 'text-muted-foreground'}`}>
                            {(() => { const k = (ORDER_STATUS_LABEL_KEYS as Record<string, OrdersKey | undefined>)[order.status]; return k ? tOrders(k) : order.status; })()}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
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
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                    <TrendingUp size={16} />
                  </span>
                  <h2 className="font-semibold text-foreground">
                    {periodMode === 'month' ? t('topProductsMonth') : isToday ? t('topProductsToday') : t('topProducts')}
                  </h2>
                </div>
                <Link href="/products" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('viewAll')} <ArrowRight size={12} className="rtl-flip" />
                </Link>
              </div>
              {topProducts.length === 0 ? (
                <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
                  <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                    <TrendingUp size={23} />
                  </span>
                  <p className="text-sm font-medium text-foreground">{t('noSalesYet')}</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {topProducts.map((product) => (
                    <div key={product.product_id} className="flex items-center justify-between px-5 py-3">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-foreground">{product.product_name}</span>
                        <p className="text-xs text-muted-foreground">{t('productSoldOrders', { quantity: product.total_quantity, orders: product.order_count })}</p>
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

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Top Staff */}
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                    <Trophy size={16} />
                  </span>
                  <h2 className="font-semibold text-foreground">{t('topStaff')}</h2>
                </div>
                <Link href="/staff" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('viewAll')} <ArrowRight size={12} className="rtl-flip" />
                </Link>
              </div>
              {(insights?.topStaff.length ?? 0) === 0 ? (
                <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
                  <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                    <Trophy size={23} />
                  </span>
                  <p className="text-sm font-medium text-foreground">{t('noSalesYet')}</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {insights!.topStaff.map((staff) => (
                    <div key={staff.user_id} className="flex items-center justify-between px-5 py-3">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-foreground">{staff.name}</span>
                        <p className="text-xs text-muted-foreground">{t('staffOrderCount', { orders: staff.orderCount })}</p>
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
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300">
                    <Tags size={16} />
                  </span>
                  <h2 className="font-semibold text-foreground">{t('topCategories')}</h2>
                </div>
                <Link href="/products" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('viewAll')} <ArrowRight size={12} className="rtl-flip" />
                </Link>
              </div>
              {(insights?.topCategories.length ?? 0) === 0 ? (
                <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
                  <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                    <Tags size={23} />
                  </span>
                  <p className="text-sm font-medium text-foreground">{t('noSalesYet')}</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {insights!.topCategories.map((category) => (
                    <div key={category.category_id ?? category.name} className="flex items-center justify-between px-5 py-3">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-foreground">{category.name}</span>
                        <p className="text-xs text-muted-foreground">{t('categoryQuantitySold', { quantity: category.quantity })}</p>
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
            <section className="mt-5 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div>
                  <h2 className="flex items-center gap-2 font-semibold text-foreground">
                    <span className="flex size-9 items-center justify-center rounded-xl bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300">
                      <RotateCcw size={16} />
                    </span>
                    {t('refundActivity')}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('refundActivityHint')}</p>
                </div>
                <span className="text-sm font-semibold text-red-600">{fmt(financialSummary?.refunded ?? 0)}</span>
              </div>
              {(financialSummary?.refunds.length ?? 0) === 0 ? (
                <p className="px-6 py-10 text-center text-sm text-muted-foreground">{t('noRefunds')}</p>
              ) : (
                <div className="divide-y divide-border">
                  {financialSummary!.refunds.map((refund) => (
                    <div key={refund.id} className="grid grid-cols-1 gap-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
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

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Payment Methods */}
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex items-center gap-3 border-b border-border px-5 py-4">
                <span className="flex size-9 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
                  <Wallet size={16} />
                </span>
                <h2 className="font-semibold text-foreground">{t('paymentMethods')}</h2>
              </div>
              <div className="p-5">
                {paymentMethods.length === 0 ? (
                  <div className="flex min-h-40 flex-col items-center justify-center text-center">
                    <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                      <Wallet size={23} />
                    </span>
                    <p className="text-sm font-medium text-foreground">{t('noPaymentsYet')}</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {paymentMethods.map((pm) => {
                      const meta = PAYMENT_METHODS.find((m) => m.key === pm.method);
                      const Icon = meta?.icon ?? Wallet;
                      const label = meta ? tPos(BUILT_IN_PAYMENT_KEYS[meta.key]) : pm.method === 'wallet' ? tPos('methodWallet') : String(pm.method || tCommon('unknown'));
                      const percent = paymentMethodsTotal > 0
                        ? Math.max(0, Math.min(100, Math.round((Number(pm.total) / paymentMethodsTotal) * 100)))
                        : 0;
                      return (
                        <div key={pm.method ?? 'unknown'}>
                          <div className="mb-1.5 flex items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2">
                              <Icon size={14} className="text-muted-foreground" />
                              <span className="truncate text-sm font-medium text-foreground">{label}</span>
                            </div>
                            <span className="shrink-0 text-sm font-semibold text-foreground">{fmt(Number(pm.total))}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${percent}%` }} />
                            </div>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t('paymentMethodCount', { count: pm.count, percent })}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Business Patterns */}
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="border-b border-border px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/50 dark:text-fuchsia-300">
                    <BarChart3 size={16} />
                  </span>
                  <div>
                    <h2 className="font-semibold text-foreground">{t('businessPatterns')}</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('businessPatternsHint', { days: insights?.windowDays ?? 30 })}</p>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
                <div className="bg-card p-4">
                  <p className="text-xs text-muted-foreground">{t('busiestHour')}</p>
                  <p className="mt-2 text-lg font-bold text-foreground">
                    {insights?.busiestHour ? formatHourLabel(insights.busiestHour.hour, locale) : t('notEnoughData')}
                  </p>
                  {insights?.busiestHour && <p className="mt-1 text-xs text-muted-foreground">{t('ordersCount', { count: insights.busiestHour.orderCount })}</p>}
                </div>
                <div className="bg-card p-4">
                  <p className="text-xs text-muted-foreground">{t('idlestHour')}</p>
                  <p className="mt-2 text-lg font-bold text-foreground">
                    {insights?.idlestHour ? formatHourLabel(insights.idlestHour.hour, locale) : t('notEnoughData')}
                  </p>
                  {insights?.idlestHour && <p className="mt-1 text-xs text-muted-foreground">{t('ordersCount', { count: insights.idlestHour.orderCount })}</p>}
                </div>
                <div className="bg-card p-4">
                  <p className="text-xs text-muted-foreground">{t('busiestDay')}</p>
                  <p className="mt-2 text-lg font-bold text-foreground">
                    {insights?.busiestDayOfWeek ? formatWeekdayLabel(insights.busiestDayOfWeek.dayIndex, locale) : t('notEnoughData')}
                  </p>
                  {insights?.busiestDayOfWeek && <p className="mt-1 text-xs text-muted-foreground">{t('ordersCount', { count: insights.busiestDayOfWeek.orderCount })}</p>}
                </div>
                <div className="bg-card p-4">
                  <p className="text-xs text-muted-foreground">{t('idlestDay')}</p>
                  <p className="mt-2 text-lg font-bold text-foreground">
                    {insights?.idlestDayOfWeek ? formatWeekdayLabel(insights.idlestDayOfWeek.dayIndex, locale) : t('notEnoughData')}
                  </p>
                  {insights?.idlestDayOfWeek && <p className="mt-1 text-xs text-muted-foreground">{t('ordersCount', { count: insights.idlestDayOfWeek.orderCount })}</p>}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
