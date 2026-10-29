'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Clock,
  CreditCard,
  Loader2,
  MapPin,
  Package,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Truck,
  User,
  X,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Ltr } from '@/components/layout/Ltr';
import EditOrderItemModal from '@/components/orders/EditOrderItemModal';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { tenantCan } from '@/lib/permissions';
import {
  formatInstantForDateTimeInput,
  formatScheduledInstantForDisplay,
  parseScheduledForInput,
} from '@/lib/scheduled-time';
import {
  getOrderBills,
  getRefundEligibleBills,
  isScheduledOrderEditLocked,
  orderHasCollectedFunds,
  resolveOrderPaymentStatus,
} from '@/lib/order-payment-state';
import type { Bill, Order, OrderItem } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import { isTerminalItemStatus } from '../../../../shared/order-item-status';

interface Props {
  open: boolean;
  orders: Order[];
  storeTimezone: string;
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
  onOrderReleased: (order: Order, kotAutoPrinted: boolean) => Promise<void> | void;
  onAddItemsToOrder: (order: Order) => void;
  onPayOrder: (order: Order) => Promise<void> | void;
  onRefundOrder: (order: Order, bills: Bill[]) => void;
}

function getCurrentTime(): number {
  return Date.now();
}

export function canPayScheduledOrder(order: Order): boolean {
  const bills = getOrderBills(order);
  return (
    bills.length === 0 ||
    bills.some((b) => b.payment_status === 'unpaid' || b.payment_status === 'partial')
  );
}

export default function ScheduledOrdersDrawer({
  open,
  orders,
  storeTimezone,
  onClose,
  onRefresh,
  onOrderReleased,
  onAddItemsToOrder,
  onPayOrder,
  onRefundOrder,
}: Props) {
  const t = useTranslations('pos');
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const { currentTenant } = useAuthStore();

  const canRelease =
    tenantCan(currentTenant, 'orders.create') || tenantCan(currentTenant, 'orders.status.update');
  const canReschedule =
    tenantCan(currentTenant, 'orders.create') || tenantCan(currentTenant, 'orders.status.update');
  const canAddItems = tenantCan(currentTenant, 'orders.create');
  const canEditItems = tenantCan(currentTenant, 'orders.item.edit');
  const canCancelItems = tenantCan(currentTenant, 'orders.item.cancel');
  const canPay =
    tenantCan(currentTenant, 'payments.take') && tenantCan(currentTenant, 'bills.generate');
  const canRefund = tenantCan(currentTenant, 'refunds.initiate');
  const canCancelOrder = tenantCan(currentTenant, 'orders.status.update');

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(interval);
  }, [open]);

  const [releasingId, setReleasingId] = useState<number | null>(null);
  const [payingId, setPayingId] = useState<number | null>(null);
  const [rescheduleOrderId, setRescheduleOrderId] = useState<number | null>(null);
  const [rescheduleInput, setRescheduleInput] = useState('');
  const [savingScheduleId, setSavingScheduleId] = useState<number | null>(null);
  const [cancelOrderId, setCancelOrderId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [cancellingItemId, setCancellingItemId] = useState<number | null>(null);
  const [editingItemTarget, setEditingItemTarget] = useState<{
    order: Order;
    item: OrderItem;
  } | null>(null);

  if (!open) return null;

  const effectiveTimezone = storeTimezone || currentTenant?.timezone || 'UTC';
  const activeOrders = orders.filter(
    (o) =>
      o.status !== 'cancelled' &&
      o.status !== 'completed' &&
      (o.release_status === 'scheduled' || o.release_status === 'blocked'),
  );
  const blockedOrders = activeOrders.filter((o) => o.release_status === 'blocked');
  const upcomingOrders = activeOrders.filter((o) => o.release_status === 'scheduled');

  const handleRelease = async (order: Order) => {
    setReleasingId(order.id);
    try {
      const { data } = await api.post(`/orders/${order.id}/release`);
      const releasedOrder = data.order as Order;
      toast.success(t('scheduledReleasedSuccess', { number: order.order_number }));
      await onOrderReleased(releasedOrder, Boolean(data.kot_auto_printed));
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast.error(errData?.error || t('operationNotSaved'));
      await onRefresh();
    } finally {
      setReleasingId(null);
    }
  };

  const openReschedule = (order: Order) => {
    setCancelOrderId(null);
    setRescheduleOrderId(order.id);
    setRescheduleInput(
      order.scheduled_for
        ? formatInstantForDateTimeInput(order.scheduled_for, effectiveTimezone)
        : '',
    );
  };

  const handleSaveSchedule = async (order: Order) => {
    const check = parseScheduledForInput({
      input: rescheduleInput,
      timezone: effectiveTimezone,
      nowMs: getCurrentTime(),
    });
    if (!check.ok) {
      const msg =
        check.code === 'PAST_SCHEDULED_TIME'
          ? t('scheduledPastTimeError', { timezone: effectiveTimezone })
          : check.code === 'DST_NONEXISTENT_TIME'
            ? t('scheduledDstSkippedError', { timezone: effectiveTimezone })
            : check.code === 'DST_AMBIGUOUS_TIME'
              ? t('scheduledDstAmbiguousError', { timezone: effectiveTimezone })
              : t('scheduledInvalidTimeError', { timezone: effectiveTimezone });
      toast.error(msg);
      return;
    }

    setSavingScheduleId(order.id);
    try {
      await api.patch(`/orders/${order.id}/schedule`, {
        scheduled_for: rescheduleInput,
      });
      toast.success(t('scheduledUpdatedSuccess', { number: order.order_number }));
      setRescheduleOrderId(null);
      setRescheduleInput('');
      await onRefresh();
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast.error(errData?.error || t('operationNotSaved'));
    } finally {
      setSavingScheduleId(null);
    }
  };

  const handleCancelOrder = async (order: Order) => {
    setCancellingId(order.id);
    try {
      await api.patch(`/orders/${order.id}/status`, {
        status: 'cancelled',
        reason: cancelReason.trim() || undefined,
      });
      toast.success(tOrders('orderCancelled'));
      setCancelOrderId(null);
      setCancelReason('');
      await onRefresh();
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast.error(errData?.error || tOrders('cancelOrderFailed'));
      await onRefresh();
    } finally {
      setCancellingId(null);
    }
  };

  const handleCancelItem = async (order: Order, item: OrderItem) => {
    setCancellingItemId(item.id);
    try {
      await api.patch(`/orders/${order.id}/items/${item.id}/cancel`, {});
      await onRefresh();
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast.error(errData?.error || t('operationNotSaved'));
    } finally {
      setCancellingItemId(null);
    }
  };

  const renderOrderCard = (order: Order) => {
    const isBlocked = order.release_status === 'blocked';
    const paymentRecorded = isScheduledOrderEditLocked(order);
    const collectedFunds = orderHasCollectedFunds(order);
    const payState = resolveOrderPaymentStatus(order) ?? 'unpaid';
    const activeItems = (order.items || []).filter((item) => !isTerminalItemStatus(item.status));
    const displayTotal = Number(order.bill?.total ?? order.total);
    const isRescheduling = rescheduleOrderId === order.id;
    const isCancelling = cancelOrderId === order.id;

    const rescheduleValidation =
      isRescheduling && rescheduleInput.trim().length > 0
        ? parseScheduledForInput({
            input: rescheduleInput,
            timezone: effectiveTimezone,
            nowMs,
          })
        : null;
    const rescheduleErrorMsg =
      rescheduleValidation && !rescheduleValidation.ok
        ? rescheduleValidation.code === 'PAST_SCHEDULED_TIME'
          ? t('scheduledPastTimeError', { timezone: effectiveTimezone })
          : rescheduleValidation.code === 'DST_NONEXISTENT_TIME'
            ? t('scheduledDstSkippedError', { timezone: effectiveTimezone })
            : rescheduleValidation.code === 'DST_AMBIGUOUS_TIME'
              ? t('scheduledDstAmbiguousError', { timezone: effectiveTimezone })
              : t('scheduledInvalidTimeError', { timezone: effectiveTimezone })
        : null;

    return (
      <div
        key={order.id}
        data-testid={`scheduled-order-card-${order.id}`}
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
              {order.type === 'delivery' ? <Truck size={12} /> : <Package size={12} />}
              {order.type === 'delivery' ? t('orderTypeDelivery') : t('orderTypeTakeaway')}
            </span>
            {isBlocked && (
              <span
                data-testid={`scheduled-blocked-badge-${order.id}`}
                className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300 px-2.5 py-0.5 text-xs font-semibold"
              >
                <AlertTriangle size={12} />
                {collectedFunds
                  ? t('scheduledPaidBlockedBadge')
                  : t('scheduledReleaseBlockedBadge')}
              </span>
            )}
            <span
              data-testid={`scheduled-payment-badge-${order.id}`}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                payState === 'paid'
                  ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300'
                  : payState === 'partial' || payState === 'partially_refunded'
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                    : payState === 'refunded'
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
              }`}
            >
              {payState === 'paid'
                ? tOrders('paid')
                : payState === 'partial'
                  ? tOrders('partiallyPaid')
                  : payState === 'partially_refunded'
                    ? tOrders('partiallyRefunded')
                    : payState === 'refunded'
                      ? tOrders('refundIssued')
                      : tOrders('unpaidBadge')}
            </span>
          </div>
          <span className="font-bold text-base text-foreground shrink-0">{fmt(displayTotal)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Clock size={13} className="text-brand shrink-0" />
            <span>{t('sendToKitchenAt')}:</span>
            <Ltr>
              {order.scheduled_for
                ? formatScheduledInstantForDisplay(order.scheduled_for, effectiveTimezone)
                : '-'}
            </Ltr>
            <span className="text-muted-foreground">({effectiveTimezone})</span>
          </span>
          {order.customer && (
            <span className="inline-flex items-center gap-1">
              <User size={12} />
              {order.customer.name}
            </span>
          )}
          {order.delivery_address && (
            <span className="inline-flex items-center gap-1 truncate max-w-full">
              <MapPin size={12} className="shrink-0" />
              <span className="truncate">{order.delivery_address}</span>
            </span>
          )}
        </div>

        {isBlocked && order.release_blocked_reason && (
          <div
            role="alert"
            data-testid={`scheduled-blocked-reason-${order.id}`}
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
          >
            {order.release_blocked_reason}
          </div>
        )}

        <div className="space-y-1.5 border-t border-border/60 pt-2">
          {activeItems.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0 flex-1">
                <span className="font-medium text-foreground">
                  {item.quantity}x{' '}
                  {item.variant_selection?.name
                    ? `${item.product_name} (${item.variant_selection.name})`
                    : item.product_name}
                </span>
                {item.addons && item.addons.length > 0 && (
                  <span className="ms-1 text-muted-foreground">
                    (+{item.addons.map((a) => a.name).join(', ')})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-muted-foreground tabular-nums">
                  {fmt(Number(item.total))}
                </span>
                {!paymentRecorded && canEditItems && (
                  <button
                    type="button"
                    data-testid={`scheduled-edit-item-btn-${item.id}`}
                    onClick={() => setEditingItemTarget({ order, item })}
                    aria-label={tCommon('edit')}
                    title={tCommon('edit')}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil size={13} />
                  </button>
                )}
                {!paymentRecorded && canCancelItems && activeItems.length > 1 && (
                  <button
                    type="button"
                    data-testid={`scheduled-cancel-item-btn-${item.id}`}
                    disabled={cancellingItemId === item.id}
                    onClick={() => void handleCancelItem(order, item)}
                    aria-label={t('remove')}
                    title={t('remove')}
                    className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                  >
                    {cancellingItemId === item.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                  </button>
                )}
              </div>
            </div>
          ))}
          {paymentRecorded && (
            <p
              data-testid={`scheduled-edit-locked-${order.id}`}
              className="text-[11px] text-muted-foreground pt-1"
            >
              {t('scheduledEditLockedPaid')}
            </p>
          )}
        </div>

        {isRescheduling && (
          <div
            data-testid={`scheduled-reschedule-panel-${order.id}`}
            className="rounded-lg border border-border bg-muted/40 p-2.5 space-y-2"
          >
            <label
              htmlFor={`scheduled-reschedule-input-${order.id}`}
              className="block text-xs font-medium text-foreground"
            >
              {t('sendToKitchenAt')} ({effectiveTimezone})
            </label>
            <input
              id={`scheduled-reschedule-input-${order.id}`}
              data-testid={`scheduled-reschedule-input-${order.id}`}
              type="datetime-local"
              value={rescheduleInput}
              onChange={(e) => setRescheduleInput(e.target.value)}
              className="w-full min-h-10 px-2.5 py-1.5 text-sm border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
            />
            {rescheduleErrorMsg && (
              <p
                role="alert"
                data-testid={`scheduled-reschedule-error-${order.id}`}
                className="text-xs text-red-600 dark:text-red-400 font-medium"
              >
                {rescheduleErrorMsg}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setRescheduleOrderId(null);
                  setRescheduleInput('');
                }}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid={`scheduled-reschedule-save-${order.id}`}
                disabled={
                  savingScheduleId === order.id ||
                  !rescheduleInput.trim() ||
                  Boolean(rescheduleErrorMsg)
                }
                onClick={() => void handleSaveSchedule(order)}
              >
                {savingScheduleId === order.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  t('scheduledSaveTime')
                )}
              </Button>
            </div>
          </div>
        )}

        {isCancelling && (
          <div
            data-testid={`scheduled-cancel-panel-${order.id}`}
            className="rounded-lg border border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20 p-2.5 space-y-2"
          >
            {collectedFunds ? (
              <>
                <p
                  role="alert"
                  data-testid={`scheduled-refund-required-msg-${order.id}`}
                  className="text-xs font-medium text-red-700 dark:text-red-300"
                >
                  {t('scheduledRefundBeforeCancel')}
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCancelOrderId(null)}
                  >
                    {t('close')}
                  </Button>
                  {canRefund && (
                    <Button
                      type="button"
                      size="sm"
                      data-testid={`scheduled-cancel-open-refund-${order.id}`}
                      onClick={() => {
                        setCancelOrderId(null);
                        onRefundOrder(order, getRefundEligibleBills(order));
                      }}
                    >
                      <RotateCcw size={13} className="me-1" />
                      {tOrders('refundButton')}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <input
                  type="text"
                  data-testid={`scheduled-cancel-reason-${order.id}`}
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder={tOrders('cancelReason')}
                  className="w-full min-h-9 px-2.5 py-1.5 text-xs border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCancelOrderId(null);
                      setCancelReason('');
                    }}
                  >
                    {tCommon('cancel')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    data-testid={`scheduled-confirm-cancel-${order.id}`}
                    disabled={cancellingId === order.id}
                    onClick={() => void handleCancelOrder(order)}
                  >
                    {cancellingId === order.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      tOrders('confirmCancel')
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {canRelease && (
            <Button
              type="button"
              size="sm"
              data-testid={`scheduled-release-btn-${order.id}`}
              disabled={releasingId === order.id}
              onClick={() => void handleRelease(order)}
              className="gap-1"
            >
              {releasingId === order.id ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={13} />
              )}
              {isBlocked ? t('scheduledRetryRelease') : t('scheduledReleaseNow')}
            </Button>
          )}

          {canReschedule && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`scheduled-reschedule-btn-${order.id}`}
              onClick={() => openReschedule(order)}
              className="gap-1"
            >
              <CalendarClock size={13} />
              {t('scheduledReschedule')}
            </Button>
          )}

          {!paymentRecorded && canAddItems && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`scheduled-add-items-btn-${order.id}`}
              onClick={() => onAddItemsToOrder(order)}
              className="gap-1"
            >
              <Plus size={13} />
              {t('scheduledAddItems')}
            </Button>
          )}

          {canPayScheduledOrder(order) && canPay && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`scheduled-pay-btn-${order.id}`}
              disabled={payingId === order.id}
              onClick={async () => {
                setPayingId(order.id);
                try {
                  await onPayOrder(order);
                } finally {
                  setPayingId(null);
                }
              }}
              className="gap-1"
            >
              {payingId === order.id ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <CreditCard size={13} />
              )}
              {t('scheduledPay')}
            </Button>
          )}

          {collectedFunds && canRefund && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`scheduled-refund-btn-${order.id}`}
              onClick={() => onRefundOrder(order, getRefundEligibleBills(order))}
              className="gap-1"
            >
              <RotateCcw size={13} />
              {tOrders('refundButton')}
            </Button>
          )}

          {canCancelOrder && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`scheduled-cancel-btn-${order.id}`}
              onClick={() => {
                setRescheduleOrderId(null);
                setCancelOrderId(cancelOrderId === order.id ? null : order.id);
                setCancelReason('');
              }}
              className="gap-1 text-red-600 hover:text-red-700 dark:text-red-400"
            >
              <Trash2 size={13} />
              {tOrders('cancel')}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      data-testid="scheduled-orders-drawer"
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-lg flex-col bg-card shadow-2xl border-s border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5 shrink-0">
          <div className="flex items-center gap-2">
            <CalendarClock size={18} className="text-brand" />
            <h2 className="text-base font-bold text-foreground">{t('scheduledOrdersTitle')}</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
              {activeOrders.length}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="touch-target rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
          {activeOrders.length === 0 ? (
            <div
              data-testid="scheduled-orders-empty"
              className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground"
            >
              <CalendarClock size={36} className="mb-3 opacity-50" />
              <p className="text-sm">{t('scheduledOrdersEmpty')}</p>
            </div>
          ) : (
            <>
              {blockedOrders.length > 0 && (
                <section data-testid="scheduled-section-blocked" className="space-y-2.5">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-red-600 dark:text-red-400">
                    <AlertTriangle size={14} />
                    {t('scheduledSectionBlocked')} ({blockedOrders.length})
                  </h3>
                  <div className="space-y-3">{blockedOrders.map(renderOrderCard)}</div>
                </section>
              )}

              {upcomingOrders.length > 0 && (
                <section data-testid="scheduled-section-upcoming" className="space-y-2.5">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    <Clock size={14} />
                    {t('scheduledSectionUpcoming')} ({upcomingOrders.length})
                  </h3>
                  <div className="space-y-3">{upcomingOrders.map(renderOrderCard)}</div>
                </section>
              )}
            </>
          )}
        </div>
      </div>

      {editingItemTarget && (
        <EditOrderItemModal
          orderId={editingItemTarget.order.id}
          item={editingItemTarget.item}
          onlinePlatformSelected={false}
          onClose={() => setEditingItemTarget(null)}
          onSaved={() => {
            setEditingItemTarget(null);
            void onRefresh();
          }}
          onIdentityChanged={() => setEditingItemTarget(null)}
        />
      )}
    </div>
  );
}
