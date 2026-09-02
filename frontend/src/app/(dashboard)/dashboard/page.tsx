'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { Banknote, ChefHat, Clock, LayoutGrid, TrendingUp, ClipboardList, ArrowRight, Timer, Trophy, Tags, BarChart3, Wallet, RotateCcw, ReceiptText, Hourglass } from 'lucide-react';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
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
  const isToday = periodMode === 'day' && selectedDate === todayLocal;
  const range = periodMode === 'month'
    ? getMonthRange(selectedMonth)
    : { startDate: selectedDate, endDate: selectedDate };

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
            <input
              type="date"
              value={selectedDate}
              max={todayLocal}
              onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
              className="h-9 px-3 text-sm border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30"
              aria-label={t('selectDate')}
            />
          ) : (
            <input
              type="month"
              value={selectedMonth}
              max={todayLocal.slice(0, 7)}
              onChange={(e) => e.target.value && setSelectedMonth(e.target.value)}
              className="h-9 px-3 text-sm border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30"
              aria-label={t('selectMonth')}
            />
          )}
        </div>
      </div>

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
