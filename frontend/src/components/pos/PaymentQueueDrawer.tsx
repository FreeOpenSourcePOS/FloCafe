'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CreditCard,
  Search,
  RefreshCw,
  X,
  AlertTriangle,
  Play,
  RotateCcw,
  Printer,
  Package,
  UtensilsCrossed,
  Clock,
  Loader2,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Ltr } from '@/components/layout/Ltr';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { tenantCan } from '@/lib/permissions';
import { useAuthStore } from '@/store/auth';
import type { Order, Bill } from '@/lib/types';

export interface AwaitingPaymentOrder {
  id: number | string;
  order_number: string;
  type: string;
  table_id?: number | null;
  table_name?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  total?: number;
  total_amount?: number;
  paid_amount: number;
  balance: number;
  checkout_stage: 'building' | 'awaiting_payment' | 'paid';
  release_status: 'scheduled' | 'released' | 'blocked' | 'cancelled';
  release_blocked_reason?: string | null;
  scheduled_for?: string | null;
  created_at: string;
  items?: unknown[];
  bill_id?: number | string | null;
  bill_number?: string | null;
  bill_payment_status?: string | null;
  bill?: Bill | null;
  bills?: Bill[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPayOrder: (order: Order) => Promise<void> | void;
  onRefundOrder?: (order: Order, bills: Bill[]) => void;
  onCountsChanged?: (awaiting: number, blocked: number) => void;
  refreshKey?: number;
}

export function PaymentQueueDrawer({
  open,
  onClose,
  onPayOrder,
  onRefundOrder,
  onCountsChanged,
  refreshKey,
}: Props) {
  const t = useTranslations('pos');
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const { currentTenant } = useAuthStore();

  const canPay =
    tenantCan(currentTenant, 'payments.take') && tenantCan(currentTenant, 'bills.generate');
  const canRelease =
    tenantCan(currentTenant, 'orders.create') || tenantCan(currentTenant, 'orders.status.update');
  const canRefund = tenantCan(currentTenant, 'refunds.initiate');

  const [orders, setOrders] = useState<AwaitingPaymentOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [releasingId, setReleasingId] = useState<string | number | null>(null);
  const [printingId, setPrintingId] = useState<string | number | null>(null);
  const [awaitingCount, setAwaitingCount] = useState(0);
  const [blockedCount, setBlockedCount] = useState(0);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchQueue = useCallback(
    async (cursor?: string | null, searchQuery?: string, append = false) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }

      try {
        const params: Record<string, string> = { limit: '50' };
        if (cursor) params.cursor = cursor;
        if (searchQuery && searchQuery.trim().length > 0) {
          // If scanner pasted prefix FLOCAFE-TICKET:, strip it
          let cleanSearch = searchQuery.trim();
          if (cleanSearch.startsWith('FLOCAFE-TICKET:')) {
            cleanSearch = cleanSearch.replace('FLOCAFE-TICKET:', '').trim();
          }
          params.search = cleanSearch;
        }

        const { data } = await api.get('/orders/awaiting-payment', { params });
        const fetchedOrders: AwaitingPaymentOrder[] = data.orders || [];

        if (append) {
          setOrders((prev) => [...prev, ...fetchedOrders]);
        } else {
          setOrders(fetchedOrders);
        }

        setNextCursor(data.next_cursor || null);
        setHasMore(Boolean(data.has_more));
        const awaiting = Number(data.awaiting_count) || 0;
        const blocked = Number(data.blocked_count) || 0;
        setAwaitingCount(awaiting);
        setBlockedCount(blocked);
        if (onCountsChanged) {
          onCountsChanged(awaiting, blocked);
        }
      } catch (err: unknown) {
        console.error('Failed to fetch awaiting payment queue:', err);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [onCountsChanged],
  );

  const onCountsChangedRef = useRef(onCountsChanged);
  useEffect(() => {
    onCountsChangedRef.current = onCountsChanged;
  }, [onCountsChanged]);

  useEffect(() => {
    let cancelled = false;
    if (open) {
      const params: Record<string, string> = { limit: '50' };
      if (search.trim().length > 0) {
        let clean = search.trim();
        if (clean.startsWith('FLOCAFE-TICKET:')) {
          clean = clean.replace('FLOCAFE-TICKET:', '').trim();
        }
        params.search = clean;
      }
      api
        .get('/orders/awaiting-payment', { params })
        .then(({ data }) => {
          if (cancelled) return;
          const fetchedOrders: AwaitingPaymentOrder[] = data.orders || [];
          setOrders(fetchedOrders);
          setNextCursor(data.next_cursor || null);
          setHasMore(Boolean(data.has_more));
          const awaiting = Number(data.awaiting_count) || 0;
          const blocked = Number(data.blocked_count) || 0;
          setAwaitingCount(awaiting);
          setBlockedCount(blocked);
          onCountsChangedRef.current?.(awaiting, blocked);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          console.error('Failed to fetch awaiting payment queue:', err);
          setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, search, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => {
      void fetchQueue(null, search);
    }, 5000);
    return () => clearInterval(interval);
  }, [open, search, fetchQueue]);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearch(value);
    }, 300);
  };

  const handleLoadMore = () => {
    if (hasMore && nextCursor && !loadingMore) {
      void fetchQueue(nextCursor, search, true);
    }
  };

  const handleRetryRelease = async (order: AwaitingPaymentOrder) => {
    setReleasingId(order.id);
    try {
      await api.post(`/orders/${order.id}/release`);
      toast.success(t('scheduledReleasedSuccess', { number: order.order_number }));
      void fetchQueue(null, search);
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast.error(errData?.error || t('placeOrderFailed'));
    } finally {
      setReleasingId(null);
    }
  };

  const handlePrintTicket = async (order: AwaitingPaymentOrder) => {
    setPrintingId(order.id);
    try {
      await api.post('/printers/print-payment-ticket', { order_id: order.id });
      toast.success(t('paymentTicketPrinted'));
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast.error(errData?.error || t('paymentTicketPrintFailed'));
    } finally {
      setPrintingId(null);
    }
  };

  if (!open) return null;

  const blockedOrders = orders.filter((o) => o.release_status === 'blocked');
  const waitingOrders = orders.filter((o) => o.release_status !== 'blocked');

  const renderOrderCard = (order: AwaitingPaymentOrder) => {
    const isBlocked = order.release_status === 'blocked';
    const isPaid = order.checkout_stage === 'paid';

    return (
      <div
        key={order.id}
        data-testid={`queue-ticket-${order.order_number}`}
        className={`rounded-xl border p-3.5 space-y-3 bg-card shadow-xs ${
          isBlocked
            ? 'border-red-300 dark:border-red-900/60 bg-red-50/30 dark:bg-red-950/15'
            : 'border-border'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="font-bold text-base text-foreground">
              #<Ltr>{order.order_number}</Ltr>
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
              {order.type === 'dine_in' ? (
                <>
                  <UtensilsCrossed size={12} />
                  {t('orderTypeDineIn')} {order.table_name ? `(${order.table_name})` : ''}
                </>
              ) : (
                <>
                  <Package size={12} />
                  {t('orderTypeTakeaway')}
                </>
              )}
            </span>
            {order.scheduled_for && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 px-2 py-0.5 text-xs font-medium">
                <Clock size={12} />
                {t('scheduledOrders')}
              </span>
            )}
            {isBlocked && (
              <span
                data-testid={`payment-queue-blocked-badge-${order.id}`}
                className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300 px-2.5 py-0.5 text-xs font-semibold"
              >
                <AlertTriangle size={12} />
                {t('scheduledPaidBlockedBadge')}
              </span>
            )}
          </div>
          <div className="text-end shrink-0">
            <span className="text-base font-bold text-foreground">
              {fmt(order.balance > 0 ? order.balance : (order.total_amount ?? order.total ?? 0))}
            </span>
            {order.paid_amount > 0 && order.balance > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('partialPaid', { paid: fmt(order.paid_amount) })}
              </p>
            )}
          </div>
        </div>

        {isBlocked && order.release_blocked_reason && (
          <div
            data-testid={`payment-queue-blocked-reason-${order.id}`}
            className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30 p-2.5 text-xs text-red-700 dark:text-red-300"
          >
            <p className="font-semibold mb-0.5">{t('releaseBlockedTitle')}:</p>
            <p>{order.release_blocked_reason}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border">
          <span className="text-xs text-muted-foreground">
            {new Date(order.created_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>

          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={printingId === order.id}
              onClick={() => void handlePrintTicket(order)}
              className="gap-1"
              title={t('printTicket')}
            >
              {printingId === order.id ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Printer size={13} />
              )}
            </Button>

            {isBlocked && canRelease && (
              <Button
                type="button"
                size="sm"
                data-testid={`retry-release-btn-${order.id}`}
                disabled={releasingId === order.id}
                onClick={() => void handleRetryRelease(order)}
                className="gap-1"
              >
                {releasingId === order.id ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Play size={13} />
                )}
                {t('scheduledRetryRelease')}
              </Button>
            )}

            {isBlocked && isPaid && canRefund && onRefundOrder && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`refund-blocked-btn-${order.id}`}
                onClick={() => {
                  const bills: Bill[] =
                    order.bills && order.bills.length > 0
                      ? order.bills
                      : order.bill
                        ? [order.bill]
                        : order.bill_id
                          ? [
                              {
                                id: Number(order.bill_id),
                                bill_number: order.bill_number || '',
                                order_id: Number(order.id),
                                subtotal: Number(order.total_amount ?? order.total ?? 0),
                                tax_amount: 0,
                                discount_amount: 0,
                                service_charge: 0,
                                delivery_charge: 0,
                                total: Number(order.total_amount ?? order.total ?? 0),
                                paid_amount: Number(order.paid_amount || 0),
                                balance: Number(order.balance || 0),
                                payment_status:
                                  (order.bill_payment_status as Bill['payment_status']) ||
                                  (Number(order.balance || 0) === 0 ? 'paid' : 'partial'),
                                payment_details: [],
                              } as unknown as Bill,
                            ]
                          : [];
                  onRefundOrder(order as unknown as Order, bills);
                }}
                className="gap-1 text-red-600 hover:text-red-700"
              >
                <RotateCcw size={13} />
                {tOrders('refundButton')}
              </Button>
            )}

            {!isPaid && canPay && (
              <Button
                type="button"
                size="sm"
                data-testid="queue-pay-btn"
                onClick={() => {
                  const billForOrder = order.bill_id
                    ? ({
                        id: Number(order.bill_id),
                        bill_number: order.bill_number || '',
                        order_id: Number(order.id),
                        subtotal: Number(order.total_amount ?? order.total ?? 0),
                        tax_amount: 0,
                        discount_amount: 0,
                        service_charge: 0,
                        delivery_charge: 0,
                        total: Number(order.total_amount ?? order.total ?? 0),
                        paid_amount: Number(order.paid_amount || 0),
                        balance: Number(order.balance || 0),
                        payment_status:
                          (order.bill_payment_status as Bill['payment_status']) || 'unpaid',
                        payment_details: [],
                      } as unknown as Bill)
                    : null;
                  const orderToPay = {
                    ...order,
                    total: Number(order.total_amount ?? order.total ?? 0),
                    bill: order.bill ?? billForOrder,
                    bills: order.bills ?? (billForOrder ? [billForOrder] : []),
                  };
                  void onPayOrder(orderToPay as unknown as Order);
                }}
                className="gap-1 bg-brand text-white hover:bg-brand/90"
              >
                <CreditCard size={13} />
                {t('payTicket')}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      data-testid="payment-queue-drawer"
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-lg flex-col bg-card shadow-2xl border-s border-border">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5 shrink-0">
          <div className="flex items-center gap-2">
            <CreditCard size={18} className="text-brand" />
            <h2 className="text-base font-bold text-foreground">{t('paymentQueue')}</h2>
            <span
              data-testid="payment-queue-total-badge"
              className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground"
            >
              {awaitingCount + blockedCount}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void fetchQueue(null, search)}
              className="size-8 rounded-full"
              title="Refresh"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </Button>
            <button
              type="button"
              onClick={onClose}
              data-testid="close-queue-drawer-btn"
              aria-label={tCommon('close')}
              className="touch-target rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-border bg-muted/30">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <input
              type="text"
              data-testid="payment-queue-search"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t('scanOrEnterTicket')}
              className="w-full pl-9 pr-4 py-2 text-sm bg-card border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => handleSearchChange('')}
                className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Content list */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {loading && orders.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 size={24} className="animate-spin me-2" />
              <span>{tCommon('loading')}</span>
            </div>
          ) : orders.length === 0 ? (
            <div
              data-testid="payment-queue-empty"
              className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground"
            >
              <CreditCard size={36} className="mb-3 opacity-50" />
              <p className="text-sm font-medium">{t('paymentQueueEmpty')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('paymentQueueEmptyDesc')}</p>
            </div>
          ) : (
            <>
              {blockedOrders.length > 0 && (
                <section data-testid="payment-queue-section-blocked" className="space-y-2.5">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-red-600 dark:text-red-400">
                    <AlertTriangle size={14} />
                    {t('paidBlockedSection')} ({blockedOrders.length})
                  </h3>
                  <div className="space-y-3">{blockedOrders.map(renderOrderCard)}</div>
                </section>
              )}

              {waitingOrders.length > 0 && (
                <section data-testid="payment-queue-section-waiting" className="space-y-2.5">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    <Clock size={14} />
                    {t('awaitingPaymentSection')} ({waitingOrders.length})
                  </h3>
                  <div className="space-y-3">{waitingOrders.map(renderOrderCard)}</div>
                </section>
              )}

              {hasMore && (
                <div className="pt-2 pb-4 flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    className="w-full gap-2"
                    data-testid="payment-queue-load-more"
                  >
                    {loadingMore ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        {tCommon('loading')}
                      </>
                    ) : (
                      tCommon('loadMore')
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
