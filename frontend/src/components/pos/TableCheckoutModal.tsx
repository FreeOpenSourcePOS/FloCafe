'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ShoppingCart, Users, Printer, Loader2, ArrowRightLeft, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import toast from 'react-hot-toast';
import type { Table, Order, Bill, OrderItem } from '@/lib/types';
import { SplitCheckModal } from '@/components/pos/SplitCheckModal';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import MoveTableModal from '@/components/tables/MoveTableModal';
import EditOrderItemModal from '@/components/orders/EditOrderItemModal';
import { isTerminalItemStatus } from '../../../../shared/order-item-status';
import {
  CHECKOUT_PRIMARY_CTA_CLASS,
  CheckoutHeaderChips,
  CheckoutQtyBadge,
  type CheckoutHeaderChipItem,
} from './checkout-ui';

interface Props {
  table: Table;
  currency: string;
  cartItemCount: number;
  onClose: () => void;
  onAddItems: (table: Table, order: Order) => void;
  onPrintBill?: (bill: Bill, reservedWindow?: Window | null) => Promise<void>;
  reservePrintWindow?: () => Window | null | undefined;
  canGenerateBill: boolean;
  canReadBills?: boolean;
  onPayment: (bill: Bill, overridePin?: string) => void;
  onAddCartToOrder?: (table: Table, order: Order) => void;
  onOrderMoved?: (result: { sourceTable: Table; targetTable: Table; order: Order }) => void;
  onRegisterDismissHandler?: (handler?: () => boolean) => void;
  tables?: Table[];
}

export default function TableCheckoutModal({
  table,

  cartItemCount,
  onClose,
  onAddItems,
  onPrintBill,
  reservePrintWindow,
  canGenerateBill,
  canReadBills = true,
  onPayment,
  onAddCartToOrder,
  onOrderMoved,
  onRegisterDismissHandler,
  tables,
}: Props) {
  const t = useTranslations('pos');
  const tOrders = useTranslations('orders');
  const tTables = useTranslations('tables');
  const tReceipt = useTranslations('receipt');
  const { currentTenant } = useAuthStore();
  const canMoveTable = tenantCan(currentTenant, 'tables.orders.move');
  const canEditItems = tenantCan(currentTenant, 'orders.item.edit');
  const [editingItem, setEditingItem] = useState<OrderItem | null>(null);
  const fmt = useFormatCurrency();
  const formatItemTotal = (value: unknown, fallback: unknown) => {
    const total = Number(value);
    if (Number.isFinite(total)) return fmt(total);
    const subtotal = Number(fallback);
    return fmt(Number.isFinite(subtotal) ? subtotal : 0);
  };
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [addingItems, setAddingItems] = useState(false);
  const [splitChecksEnabled, setSplitChecksEnabled] = useState(false);
  const [splitBill, setSplitBill] = useState<Bill | null>(null);
  const [splitCheckSaving, setSplitCheckSaving] = useState(false);
  const [printingBill, setPrintingBill] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [moveTableBusy, setMoveTableBusy] = useState(false);
  const moveTableBusyRef = useRef(false);
  const handleMoveTableBusyChange = useCallback((busy: boolean) => {
    moveTableBusyRef.current = busy;
    setMoveTableBusy(busy);
  }, []);
  const [editItemBusy, setEditItemBusy] = useState(false);
  const editItemBusyRef = useRef(false);
  const handleEditItemBusyChange = useCallback((busy: boolean) => {
    editItemBusyRef.current = busy;
    setEditItemBusy(busy);
  }, []);
  const editItemDismissRef = useRef<(() => boolean) | undefined>(undefined);
  const registerEditItemDismiss = useCallback((handler?: () => boolean) => {
    editItemDismissRef.current = handler;
  }, []);

  const dismissHandlerRef = useRef<() => boolean>(() => true);
  useEffect(() => {
    dismissHandlerRef.current = () => {
      if (
        generating ||
        addingItems ||
        printingBill ||
        splitCheckSaving ||
        moveTableBusy ||
        moveTableBusyRef.current ||
        editItemBusy ||
        editItemBusyRef.current
      ) {
        return true;
      }
      if (splitBill) {
        setSplitBill(null);
        return true;
      }
      if (showMoveModal) {
        setShowMoveModal(false);
        return true;
      }
      if (editingItem) {
        if (editItemDismissRef.current) {
          return editItemDismissRef.current();
        }
        setEditingItem(null);
        return true;
      }
      onClose();
      return true;
    };
  });

  useEffect(() => {
    if (!onRegisterDismissHandler) return;
    onRegisterDismissHandler(() => dismissHandlerRef.current());
    return () => onRegisterDismissHandler(undefined);
  }, [onRegisterDismissHandler]);

  useEffect(() => {
    if (
      onRegisterDismissHandler ||
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    ) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== 'Escape') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      dismissHandlerRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onRegisterDismissHandler]);

  const handleMoveTable = () => {
    setShowMoveModal(true);
  };

  useEffect(() => {
    const controller = new AbortController();
    const fetchOrder = async () => {
      try {
        const { data } = await api.get(`/tables/${table.id}`, { signal: controller.signal });
        const tbl = data.table;
        const activeOrder = tbl.activeOrder || tbl.current_order;
        if (activeOrder) {
          const orderRes = await api.get(`/orders/${activeOrder.id}`, {
            signal: controller.signal,
          });
          setOrder(orderRes.data.order);
        }
      } catch {
        if (controller.signal.aborted) return;
        toast.error(t('loadOrderFailed'));
      } finally {
        setLoading(false);
      }
    };
    fetchOrder();
    return () => controller.abort();
  }, [table.id, t]);

  useEffect(() => {
    api
      .get('/settings/split_checks_enabled')
      .then((res) => setSplitChecksEnabled(res.data?.setting?.value === 'true'))
      .catch(() => setSplitChecksEnabled(false));
  }, []);

  const handlePayment = (bill: Bill) => onPayment(bill);

  const handleCheckout = async () => {
    if (!order) return;
    setGenerating(true);
    try {
      if (order.bill) {
        handlePayment({ ...order.bill, order });
        return;
      }
      const { data } = await api.post('/bills/generate', { order_id: order.id });
      handlePayment(data.bill);
    } catch {
      toast.error(t('generateBillFailed'));
    } finally {
      setGenerating(false);
    }
  };

  const handlePrintBill = async () => {
    if (!order || !onPrintBill) return;
    const reservedWindow = reservePrintWindow?.();
    let windowTransferred = false;
    setPrintingBill(true);
    try {
      let currentOrder: Order;
      try {
        const { data } = await api.get(`/orders/${order.id}`);
        currentOrder = data.order as Order;
      } catch {
        toast.error(t('loadOrderFailed'));
        return;
      }
      setOrder(currentOrder);
      if (
        currentOrder.bill?.split_group_id ||
        currentOrder.bills?.some((bill) => bill.split_group_id)
      )
        return;

      let targetBill = currentOrder.bill;
      if (!targetBill) {
        if (!canGenerateBill) return;
        const { data } = await api.post('/bills/generate', { order_id: currentOrder.id });
        targetBill = data.bill;
        setOrder({ ...currentOrder, bill: targetBill });
      }
      if (targetBill?.split_group_id) {
        const { data } = await api.get(`/orders/${currentOrder.id}`);
        setOrder(data.order as Order);
        return;
      }
      if (targetBill) {
        windowTransferred = true;
        await onPrintBill(
          { ...targetBill, order: targetBill.order ?? currentOrder },
          reservedWindow,
        );
      }
    } catch {
      toast.error(t('generateBillFailed'));
    } finally {
      if (!windowTransferred && reservedWindow && !reservedWindow.closed) reservedWindow.close();
      setPrintingBill(false);
    }
  };

  const handleSplitCheck = async (sourceBill?: Bill) => {
    if (!order) return;
    setGenerating(true);
    try {
      const bill = sourceBill
        ? ((await api.get(`/bills/${sourceBill.id}`)).data.bill as Bill)
        : order.bill || (await api.post('/bills/generate', { order_id: order.id })).data.bill;
      const detailedBill = bill.order
        ? bill
        : ((await api.get(`/bills/${bill.id}`)).data.bill as Bill);
      const splitOrder = detailedBill.order as Order | undefined;
      const splitItems = (splitOrder?.items || []).filter(
        (item) => !isTerminalItemStatus(item.status),
      );
      const hasDivisibleItems =
        splitItems.length > 0 &&
        splitItems.every(
          (item) => Number.isSafeInteger(Number(item.quantity)) && Number(item.quantity) > 0,
        ) &&
        splitItems.reduce((total, item) => total + Number(item.quantity), 0) >= 2;
      if (splitOrder?.type !== 'dine_in' || !hasDivisibleItems) {
        toast.error(t('splitCheckFailed'));
        return;
      }
      setSplitBill(detailedBill);
    } catch {
      toast.error(t('splitCheckFailed'));
    } finally {
      setGenerating(false);
    }
  };

  const handleAddCartToOrder = async () => {
    if (!order || !onAddCartToOrder) return;
    setAddingItems(true);
    try {
      await onAddCartToOrder(table, order);
    } catch {
      toast.error(t('addItemsFailed'));
    } finally {
      setAddingItems(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-card rounded-2xl p-8">
          <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-card rounded-2xl p-6 w-full max-w-md">
          <p className="text-muted-foreground text-center py-4">{t('noActiveOrder')}</p>
          <Button onClick={onClose} variant="outline" className="w-full">
            {t('close')}
          </Button>
        </div>
      </div>
    );
  }

  // Filter active items (not cancelled)
  const activeItems = (order.items || []).filter(
    (item: OrderItem) => !isTerminalItemStatus(item.status),
  );
  const splitBills = (order.bills || []).filter((bill) => Boolean(bill.split_group_id));
  const headerChips: CheckoutHeaderChipItem[] = [
    { key: 'order', label: t('orderNumber', { number: order.order_number }) },
    ...(order.bill?.bill_number
      ? [{ key: 'bill', label: t('billNumber', { number: order.bill.bill_number }) }]
      : []),
  ];
  const formatBillStatusLabel = (status: string | undefined) => {
    if (status === 'paid') return t('paid');
    if (status === 'partial' || status === 'partially_paid') return tOrders('partiallyPaid');
    if (status === 'refunded') return tOrders('refunded');
    if (status === 'partially_refunded') return tOrders('partiallyRefunded');
    return t('unpaid');
  };

  return (
    <>
      {editingItem && (
        <EditOrderItemModal
          orderId={order.id}
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onIdentityChanged={onClose}
          onBusyChange={handleEditItemBusyChange}
          onRegisterDismissHandler={registerEditItemDismiss}
          onSaved={() => {
            api
              .get(`/orders/${order.id}`)
              .then(({ data }) => setOrder(data.order as Order))
              .catch(() => toast.error(t('loadOrderFailed')));
          }}
        />
      )}
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-card border border-border/80 shadow-xl rounded-2xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden dark:border-white/10">
          <div className="flex justify-between items-start gap-3 px-5 py-4 border-b border-border/80 dark:border-white/10">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold tracking-tight text-foreground">{table.name}</h2>
                <span
                  className={`px-2.5 py-0.5 text-xs font-semibold rounded-full border ${
                    order.bill?.payment_status === 'paid'
                      ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                      : 'border-amber-500/35 bg-amber-500/12 text-amber-800 dark:text-amber-300'
                  }`}
                >
                  {formatBillStatusLabel(order.bill?.payment_status)}
                </span>
              </div>
              <CheckoutHeaderChips chips={headerChips} className="mt-1.5" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canMoveTable && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleMoveTable}
                  className="text-xs h-8 gap-1.5 rounded-lg bg-card dark:border-white/10"
                >
                  <ArrowRightLeft size={13} />
                  {tTables('moveTable')}
                </Button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="touch-target rounded-xl border border-border/75 bg-muted/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:border-white/10"
                aria-label={t('close')}
              >
                <X size={20} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {/* Existing order items - shown as disabled/reference */}
            <div className="mb-3">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">{t('previousItems')}</span>
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border/80 bg-muted/65 px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground dark:border-white/10">
                  {activeItems.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {activeItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex justify-between items-start gap-2 rounded-xl border border-border/75 bg-muted/35 px-3 py-2 dark:border-white/10 dark:bg-muted/20"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <CheckoutQtyBadge>{item.quantity}</CheckoutQtyBadge>
                        <p className="text-xs text-foreground font-semibold truncate">
                          {item.product_name}
                        </p>
                      </div>
                      {item.special_instructions && (
                        <p className="mt-0.5 ps-7 text-xs text-muted-foreground italic">
                          {item.special_instructions}
                        </p>
                      )}
                    </div>
                    <span className="text-xs font-semibold tabular-nums text-foreground ms-2 pt-0.5">
                      {formatItemTotal(item.total, item.subtotal)}
                    </span>
                    {canEditItems && order.bill?.payment_status !== 'paid' && (
                      <button
                        type="button"
                        onClick={() => setEditingItem(item)}
                        className="ms-1 size-6 flex items-center justify-center text-muted-foreground hover:text-foreground rounded-md hover:bg-background"
                        title={tOrders('editItem')}
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="p-5 border-t border-border/80 bg-muted/20 space-y-3 dark:border-white/10 dark:bg-muted/10">
            <div className="rounded-xl border border-border bg-card p-3.5 space-y-2 tabular-nums shadow-2xs dark:border-white/10">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('subtotal')}</span>
                <span className="font-medium text-foreground">{fmt(Number(order.subtotal))}</span>
              </div>
              <TaxBreakdown
                taxAmount={Number(order.tax_amount)}
                taxBreakdown={order.tax_breakdown}
                theme="light"
              />
              <div className="flex justify-between border-t border-border/80 pt-2 text-lg font-bold dark:border-white/10">
                <span>{t('total')}</span>
                <span className="text-brand dark:text-indigo-300">{fmt(Number(order.total))}</span>
              </div>
              {order.bill &&
                order.bill.payment_status !== 'paid' &&
                Number(order.bill.balance) > 0 && (
                  <div className="flex justify-between text-sm font-semibold text-amber-700 dark:text-amber-300">
                    <span>{t('balanceDue')}</span>
                    <span>{fmt(Number(order.bill.balance))}</span>
                  </div>
                )}
            </div>

            {splitBills.length > 0 && (
              <div className="space-y-2">
                {splitBills.map((bill) => (
                  <div
                    key={bill.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card p-2.5 shadow-2xs dark:border-white/10"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {bill.split_label}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="font-semibold tabular-nums text-foreground">
                          {fmt(Number(bill.total))}
                        </span>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                            bill.payment_status === 'paid'
                              ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                              : 'border-amber-500/35 bg-amber-500/12 text-amber-800 dark:text-amber-300'
                          }`}
                        >
                          {formatBillStatusLabel(bill.payment_status)}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {splitChecksEnabled &&
                        canReadBills &&
                        order.type === 'dine_in' &&
                        bill.payment_status === 'unpaid' &&
                        Number(bill.paid_amount || 0) === 0 &&
                        !bill.payment_details && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-lg bg-card dark:border-white/10"
                            onClick={() => handleSplitCheck(bill)}
                            disabled={generating}
                          >
                            <Users size={14} className="me-1" />
                            {t('splitCheck')}
                          </Button>
                        )}
                      {bill.payment_status !== 'paid' && (
                        <Button
                          size="sm"
                          className={`rounded-lg font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                          onClick={() => handlePayment(bill)}
                        >
                          {t('pay')}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Show different buttons based on cart state */}
            {splitBills.length === 0 &&
              splitChecksEnabled &&
              canReadBills &&
              order.type === 'dine_in' &&
              (!order.bill ||
                (order.bill.payment_status === 'unpaid' &&
                  Number(order.bill.paid_amount || 0) === 0 &&
                  !order.bill.payment_details)) && (
                <Button
                  variant="outline"
                  onClick={() => handleSplitCheck()}
                  disabled={generating}
                  className="w-full rounded-xl bg-card dark:border-white/10"
                >
                  <Users size={15} className="me-2" />
                  {t('splitCheck')}
                </Button>
              )}
            {cartItemCount > 0 ? (
              // Cart has items - show "Add items to order" option
              <div className="space-y-2">
                <Button
                  onClick={handleAddCartToOrder}
                  disabled={addingItems}
                  className={`w-full rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                  size="lg"
                >
                  <ShoppingCart size={16} className="me-2" />
                  {addingItems ? t('adding') : t('addToOrder', { count: cartItemCount })}
                </Button>
                <Button
                  onClick={handleCheckout}
                  variant="outline"
                  className="w-full rounded-xl bg-card dark:border-white/10"
                  disabled={generating}
                >
                  {generating ? t('generating') : t('checkoutInstead')}
                </Button>
              </div>
            ) : splitBills.length === 0 ? (
              // Cart empty - show both options
              <div
                className={`grid ${order.bill || canGenerateBill ? 'grid-cols-3' : 'grid-cols-2'} gap-2`}
              >
                <Button
                  variant="outline"
                  className="rounded-xl bg-card dark:border-white/10"
                  onClick={() => onAddItems(table, order)}
                  disabled={generating || printingBill}
                >
                  {t('addItems')}
                </Button>
                {(order.bill || canGenerateBill) && (
                  <Button
                    variant="outline"
                    onClick={handlePrintBill}
                    disabled={generating || printingBill}
                    className="rounded-xl bg-card font-medium dark:border-white/10"
                  >
                    {printingBill ? (
                      <Loader2 size={15} className="animate-spin me-1.5" />
                    ) : (
                      <Printer size={15} className="me-1.5" />
                    )}
                    {tReceipt('printBill')}
                  </Button>
                )}
                <Button
                  onClick={handleCheckout}
                  disabled={generating || printingBill}
                  className={`rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                >
                  {generating ? t('generating') : t('checkout')}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {splitBill && (
        <SplitCheckModal
          bill={splitBill}
          order={splitBill.order || order}
          onSubmittingChange={setSplitCheckSaving}
          onClose={() => {
            if (!splitCheckSaving) setSplitBill(null);
          }}
          onSplit={(bills) => {
            setOrder((current) => {
              if (!current) return current;
              const existingBills = current.bills || (current.bill ? [current.bill] : []);
              return {
                ...current,
                bill: bills[0],
                bills: [
                  ...existingBills.filter((existing) => existing.id !== splitBill.id),
                  ...bills,
                ],
              };
            });
            setSplitBill(null);
          }}
        />
      )}
      {showMoveModal && (
        <MoveTableModal
          sourceTable={table}
          tables={tables}
          onBusyChange={handleMoveTableBusyChange}
          onClose={() => setShowMoveModal(false)}
          onSuccess={(data) => {
            setShowMoveModal(false);
            onOrderMoved?.(data);
            onClose();
          }}
        />
      )}
    </>
  );
}
