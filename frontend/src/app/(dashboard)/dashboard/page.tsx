'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { Banknote, ChefHat, Clock, LayoutGrid, TrendingUp, ClipboardList, ArrowRight, Timer, Trophy, Tags, BarChart3 } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCountryByCode } from '@/lib/countries';

interface DailyStats {
  sales: number;
  runningOrders: number;
  pendingOrders: number;
  tablesOccupied: number;
}

interface DaySummary {
  date: string;
  orders: { count: number; total: number };
  bills: { count: number; total: number; collected: number };
  customers: { new: number };
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
  completed: 'text-gray-500',
  cancelled: 'text-red-500',
};

function localizeTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? `{${k}}`));
}

export default function DashboardPage() {
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const router = useRouter();
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  const isOwner = currentTenant?.role === 'owner';
  const fmt = useFormatCurrency();
  const locale = currentTenant?.country ? (getCountryByCode(currentTenant.country)?.locale ?? 'en-US') : 'en-US';
  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayLocal = getLocalDateString(new Date(), timeZone);
  const [selectedDate, setSelectedDate] = useState(todayLocal);
  const isToday = selectedDate === todayLocal;

  useEffect(() => {
    if (currentTenant && !isOwner) {
      router.replace('/pos');
    }
  }, [currentTenant, isOwner, router]);

  useEffect(() => {
    if (!isOwner) return;
    setLoading(true);
    Promise.all([
      isToday ? api.get('/reports/daily-stats') : api.get('/reports/summary', { params: { date: selectedDate } }),
      api.get('/reports/topProducts', { params: { start_date: selectedDate, end_date: selectedDate, limit: 5 } }),
      api.get('/reports/recentOrders', { params: { date: selectedDate, limit: 6 } }),
      api.get('/reports/insights', { params: { days: 30 } }),
    ])
      .then(([statsRes, topRes, recentRes, insightsRes]) => {
        setStats(isToday ? statsRes.data : null);
        setDaySummary(isToday ? null : statsRes.data.summary);
        setTopProducts(topRes.data.topProducts || []);
        setRecentOrders(recentRes.data.recentOrders || []);
        setInsights(insightsRes.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, selectedDate]);

  if (!isOwner) return null;

  // Running/Pending Orders and Tables Occupied are live, "right now" concepts
  // that don't retroactively apply to a past date (an order isn't "pending"
  // in history — it has a final status). When viewing a past date, swap them
  // for the day's actual totals from /reports/summary instead.
  const dateScopedTiles = isToday
    ? [
        {
          label: t('dashboard.runningOrders'),
          value: stats?.runningOrders ?? 0,
          icon: ChefHat,
          color: 'bg-blue-50 border-blue-200',
          iconColor: 'text-blue-600',
          href: '/orders',
        },
        {
          label: t('dashboard.pendingOrders'),
          value: stats?.pendingOrders ?? 0,
          icon: Clock,
          color: 'bg-yellow-50 border-yellow-200',
          iconColor: 'text-yellow-600',
          href: '/orders',
        },
        {
          label: t('dashboard.tablesOccupied'),
          value: stats?.tablesOccupied ?? 0,
          icon: LayoutGrid,
          color: 'bg-purple-50 border-purple-200',
          iconColor: 'text-purple-600',
          href: '/tables',
        },
      ]
    : [
        {
          label: t('dashboard.orders'),
          value: daySummary?.orders.count ?? 0,
          icon: ChefHat,
          color: 'bg-blue-50 border-blue-200',
          iconColor: 'text-blue-600',
          href: '/orders',
        },
        {
          label: t('dashboard.newCustomers'),
          value: daySummary?.customers.new ?? 0,
          icon: Clock,
          color: 'bg-yellow-50 border-yellow-200',
          iconColor: 'text-yellow-600',
          href: '/customers',
        },
      ];

  const tiles = [
    {
      label: isToday ? t('dashboard.todaySales') : t('dashboard.sales'),
      value: fmt(isToday ? (stats?.sales ?? 0) : (daySummary?.bills.collected ?? 0)),
      icon: Banknote,
      color: 'bg-green-50 border-green-200',
      iconColor: 'text-green-600',
      href: '/orders',
    },
    ...dateScopedTiles,
    {
      label: t('dashboard.aov'),
      value: fmt(insights?.aov ?? 0),
      icon: TrendingUp,
      color: 'bg-teal-50 border-teal-200',
      iconColor: 'text-teal-600',
      href: '/orders',
    },
    {
      label: t('dashboard.avgPrepTime'),
      value: insights?.avgPrepTimeMinutes != null ? localizeTemplate(t('dashboard.minutesValue'), { minutes: insights.avgPrepTimeMinutes }) : '—',
      icon: Timer,
      color: 'bg-orange-50 border-orange-200',
      iconColor: 'text-orange-600',
      href: '/orders',
    },
  ];

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">{t('dashboard.title')}</h1>
        <input
          type="date"
          value={selectedDate}
          max={todayLocal}
          onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
          className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand/30"
          aria-label={t('dashboard.selectDate')}
        />
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
                  <span className="text-sm font-medium text-gray-600">{tile.label}</span>
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
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                <h2 className="flex items-center gap-2 font-semibold text-gray-900">
                  <ClipboardList size={16} className="text-gray-400" />
                  {isToday ? t('dashboard.recentOrders') : t('dashboard.orders')}
                </h2>
                <Link href="/orders" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('dashboard.viewAll')} <ArrowRight size={12} />
                </Link>
              </div>
              {recentOrders.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">{t('dashboard.noOrdersYet')}</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {recentOrders.map((order) => (
                    <Link
                      key={order.id}
                      href="/orders"
                      className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">#{order.order_number}</span>
                          <span className={`text-xs font-medium ${orderStatusColor[order.status] || 'text-gray-500'}`}>
                            {t(`orders.${order.status}` as 'orders.pending' | 'orders.preparing' | 'orders.ready' | 'orders.served' | 'orders.completed' | 'orders.cancelled')}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 truncate">
                          {order.customer_name || order.table_name || t('dashboard.walkIn')}
                        </p>
                      </div>
                      <span className="text-sm font-semibold text-gray-900 shrink-0">
                        {fmt(Number(order.total))}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Top Products Today */}
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                <h2 className="flex items-center gap-2 font-semibold text-gray-900">
                  <TrendingUp size={16} className="text-gray-400" />
                  {t('dashboard.topProductsToday')}
                </h2>
                <Link href="/products" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('dashboard.viewAll')} <ArrowRight size={12} />
                </Link>
              </div>
              {topProducts.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">{t('dashboard.noSalesYet')}</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {topProducts.map((product) => (
                    <div key={product.product_id} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-gray-900">{product.product_name}</span>
                        <p className="text-xs text-gray-400">{localizeTemplate(t('dashboard.productSoldOrders'), { quantity: product.total_quantity, orders: product.order_count })}</p>
                      </div>
                      <span className="text-sm font-semibold text-gray-900 shrink-0">
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
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                <h2 className="flex items-center gap-2 font-semibold text-gray-900">
                  <Trophy size={16} className="text-gray-400" />
                  {t('dashboard.topStaff')}
                </h2>
                <Link href="/staff" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('dashboard.viewAll')} <ArrowRight size={12} />
                </Link>
              </div>
              {(insights?.topStaff.length ?? 0) === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">{t('dashboard.noSalesYet')}</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {insights!.topStaff.map((staff) => (
                    <div key={staff.user_id} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-gray-900">{staff.name}</span>
                        <p className="text-xs text-gray-400">{localizeTemplate(t('dashboard.staffOrderCount'), { orders: staff.orderCount })}</p>
                      </div>
                      <span className="text-sm font-semibold text-gray-900 shrink-0">
                        {fmt(Number(staff.revenue))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Top Categories */}
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                <h2 className="flex items-center gap-2 font-semibold text-gray-900">
                  <Tags size={16} className="text-gray-400" />
                  {t('dashboard.topCategories')}
                </h2>
              </div>
              {(insights?.topCategories.length ?? 0) === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">{t('dashboard.noSalesYet')}</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {insights!.topCategories.map((category) => (
                    <div key={category.category_id ?? category.name} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-gray-900">{category.name}</span>
                        <p className="text-xs text-gray-400">{localizeTemplate(t('dashboard.categoryQuantitySold'), { quantity: category.quantity })}</p>
                      </div>
                      <span className="text-sm font-semibold text-gray-900 shrink-0">
                        {fmt(Number(category.revenue))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Business Patterns */}
          <div className="bg-white rounded-xl border border-gray-100 p-4 mt-4">
            <div className="flex items-center gap-2 mb-1">
              <BarChart3 size={16} className="text-gray-400" />
              <h2 className="font-semibold text-gray-900">{t('dashboard.businessPatterns')}</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              {localizeTemplate(t('dashboard.businessPatternsHint'), { days: insights?.windowDays ?? 30 })}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-gray-500 mb-1">{t('dashboard.busiestHour')}</p>
                <p className="text-lg font-bold text-gray-900">
                  {insights?.busiestHour ? formatHourLabel(insights.busiestHour.hour, locale) : t('dashboard.notEnoughData')}
                </p>
                {insights?.busiestHour && (
                  <p className="text-xs text-gray-400">{localizeTemplate(t('dashboard.ordersCount'), { count: insights.busiestHour.orderCount })}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">{t('dashboard.idlestHour')}</p>
                <p className="text-lg font-bold text-gray-900">
                  {insights?.idlestHour ? formatHourLabel(insights.idlestHour.hour, locale) : t('dashboard.notEnoughData')}
                </p>
                {insights?.idlestHour && (
                  <p className="text-xs text-gray-400">{localizeTemplate(t('dashboard.ordersCount'), { count: insights.idlestHour.orderCount })}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">{t('dashboard.busiestDay')}</p>
                <p className="text-lg font-bold text-gray-900">
                  {insights?.busiestDayOfWeek ? formatWeekdayLabel(insights.busiestDayOfWeek.dayIndex, locale) : t('dashboard.notEnoughData')}
                </p>
                {insights?.busiestDayOfWeek && (
                  <p className="text-xs text-gray-400">{localizeTemplate(t('dashboard.ordersCount'), { count: insights.busiestDayOfWeek.orderCount })}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">{t('dashboard.idlestDay')}</p>
                <p className="text-lg font-bold text-gray-900">
                  {insights?.idlestDayOfWeek ? formatWeekdayLabel(insights.idlestDayOfWeek.dayIndex, locale) : t('dashboard.notEnoughData')}
                </p>
                {insights?.idlestDayOfWeek && (
                  <p className="text-xs text-gray-400">{localizeTemplate(t('dashboard.ordersCount'), { count: insights.idlestDayOfWeek.orderCount })}</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
