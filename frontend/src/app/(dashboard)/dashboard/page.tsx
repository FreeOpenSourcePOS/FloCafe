'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { IndianRupee, ChefHat, Clock, LayoutGrid, TrendingUp, ClipboardList, ArrowRight } from 'lucide-react';
import { getCurrencySymbol } from '@/lib/countries';
import { useI18n } from '@/hooks/useI18n';

interface DailyStats {
  sales: number;
  runningOrders: number;
  pendingOrders: number;
  tablesOccupied: number;
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
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const isOwner = currentTenant?.role === 'owner';
  const currency = getCurrencySymbol(currentTenant?.currency || 'INR');

  useEffect(() => {
    if (currentTenant && !isOwner) {
      router.replace('/pos');
    }
  }, [currentTenant, isOwner, router]);

  useEffect(() => {
    if (!isOwner) return;
    Promise.all([
      api.get('/reports/daily-stats'),
      api.get('/reports/topProducts', { params: { limit: 5 } }),
      api.get('/reports/recentOrders', { params: { limit: 6 } }),
    ])
      .then(([statsRes, topRes, recentRes]) => {
        setStats(statsRes.data);
        setTopProducts(topRes.data.topProducts || []);
        setRecentOrders(recentRes.data.recentOrders || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOwner]);

  if (!isOwner) return null;

  const tiles = [
    {
      label: t('dashboard.todaySales'),
      value: stats?.sales ?? 0,
      icon: IndianRupee,
      color: 'bg-green-50 border-green-200',
      iconColor: 'text-green-600',
      prefix: currency,
      href: '/orders',
    },
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
  ];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('dashboard.title')}</h1>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-3 border-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
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
                  {tile.prefix ? `${tile.prefix}${tile.value.toLocaleString()}` : tile.value}
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
                  {t('dashboard.recentOrders')}
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
                        {currency}{Number(order.total).toLocaleString()}
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
                        {currency}{Number(product.total_revenue).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
