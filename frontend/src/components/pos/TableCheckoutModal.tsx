'use client';

import { useState, useEffect } from 'react';
import { X, ShoppingCart, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import toast from 'react-hot-toast';
import type { Table, Order, Bill, OrderItem } from '@/lib/types';
import { SplitCheckModal } from '@/components/pos/SplitCheckModal';

interface Props {
  table: Table;
  currency: string;
  cartItemCount: number;
  onClose: () => void;
  onAddItems: (table: Table, order: Order) => void;
  onPayment: (bill: Bill) => void;
  onAddCartToOrder?: (table: Table, order: Order) => void;
}

export default function TableCheckoutModal({
  table,

  cartItemCount,
  onClose,
  onAddItems,
  onPayment,
  onAddCartToOrder
}: Props) {
  const t = useTranslations('pos');
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

  useEffect(() => {
    const controller = new AbortController();
    const fetchOrder = async () => {
      try {
        const { data } = await api.get(`/tables/${table.id}`, { signal: controller.signal });
        const tbl = data.table;
        const activeOrder = tbl.activeOrder || tbl.current_order;
        if (activeOrder) {
          const orderRes = await api.get(`/orders/${activeOrder.id}`, { signal: controller.signal });
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
    api.get('/settings/split_checks_enabled').then((res) => setSplitChecksEnabled(res.data?.setting?.value === 'true')).catch(() => setSplitChecksEnabled(false));
  }, []);

  const handleCheckout = async () => {
    if (!order) return;
    setGenerating(true);
    try {
      if (order.bill) {
        onPayment(order.bill);
        return;
      }
      const { data } = await api.post('/bills/generate', { order_id: order.id });
      onPayment(data.bill);
    } catch {
      toast.error(t('generateBillFailed'));
    } finally {
      setGenerating(false);
    }
  };

  const handleSplitCheck = async () => {
    if (!order) return;
    setGenerating(true);
    try {
      const bill = order.bill || (await api.post('/bills/generate', { order_id: order.id })).data.bill;
      setSplitBill(bill);
    } catch {
      toast.error(t('generateBillFailed'));
    }
    finally { setGenerating(false); }
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
        <div className="bg-white rounded-2xl p-8">
          <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-2xl p-6 w-full max-w-md">
          <p className="text-gray-500 text-center py-4">{t('noActiveOrder')}</p>
          <Button onClick={onClose} variant="outline" className="w-full">{t('close')}</Button>
        </div>
      </div>
    );
  }

  // Filter active items (not cancelled)
  const activeItems = (order.items || []).filter((item: OrderItem) => item.status !== 'cancelled');
  const splitBills = (order.bills || []).filter((bill) => Boolean(bill.split_group_id));

  return (
    <>
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] flex flex-col">
        <div className="flex justify-between items-center p-5 border-b border-gray-100">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-gray-900">{table.name}</h2>
              <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                order.bill?.payment_status === 'paid' 
                  ? 'bg-green-100 text-green-700' 
                  : 'bg-orange-100 text-orange-700'
              }`}>
                {order.bill?.payment_status === 'paid' ? t('paid') : t('unpaid')}
              </span>
            </div>
            <p className="text-sm text-gray-500">{t('orderNumber', { number: order.order_number })}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* Existing order items - shown as disabled/reference */}
          <div className="mb-3">
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">{t('previousItems')}</p>
            <div className="space-y-1">
              {activeItems.map((item) => (
                <div key={item.id} className="flex justify-between items-start py-1.5 px-2 bg-gray-50 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-700 font-medium">
                      {item.quantity}x {item.product_name}
                    </p>
                    {item.special_instructions && (
                      <p className="text-xs text-gray-400 italic">{item.special_instructions}</p>
                    )}
                  </div>
                  <span className="text-xs text-gray-600 ms-2 font-medium">
                    {formatItemTotal(item.total, item.subtotal)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="p-5 border-t border-gray-100 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">{t('subtotal')}</span>
            <span>{fmt(Number(order.subtotal))}</span>
          </div>
          <TaxBreakdown
            taxAmount={Number(order.tax_amount)}
            taxBreakdown={order.tax_breakdown}
            theme="light"
          />
          <div className="flex justify-between text-lg font-bold">
            <span>{t('total')}</span>
            <span className="text-brand">{fmt(Number(order.total))}</span>
          </div>
          {order.bill && order.bill.payment_status !== 'paid' && Number(order.bill.balance) > 0 && (
            <div className="flex justify-between text-sm font-medium">
              <span className="text-orange-600">{t('balanceDue')}</span>
              <span className="text-orange-600">{fmt(Number(order.bill.balance))}</span>
            </div>
          )}

          {splitBills.length > 0 && <div className="space-y-2">{splitBills.map((bill) => <div key={bill.id} className="flex items-center justify-between rounded-lg border p-2"><div><p className="text-sm font-medium">{bill.split_label}</p><p className="text-xs text-gray-500">{fmt(Number(bill.total))} · {bill.payment_status}</p></div>{bill.payment_status !== 'paid' && <Button size="sm" onClick={() => onPayment(bill)}>{t('pay')}</Button>}</div>)}</div>}

          {/* Show different buttons based on cart state */}
          {splitBills.length === 0 && splitChecksEnabled && order.type === 'dine_in' && order.bill?.payment_status !== 'paid' && <Button variant="outline" onClick={handleSplitCheck} disabled={generating} className="w-full"><Users size={15} className="me-2" />{t('splitCheck')}</Button>}
          {cartItemCount > 0 ? (
            // Cart has items - show "Add items to order" option
            <div className="space-y-2">
              <Button 
                onClick={handleAddCartToOrder} 
                disabled={addingItems}
                className="w-full"
                size="lg"
              >
                <ShoppingCart size={16} className="me-2" />
                {addingItems ? t('adding') : t('addToOrder', { count: cartItemCount })}
              </Button>
              <Button onClick={handleCheckout} variant="outline" className="w-full" disabled={generating}>
                {generating ? t('generating') : t('checkoutInstead')}
              </Button>
            </div>
          ) : splitBills.length === 0 ? (
            // Cart empty - show both options
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" onClick={() => onAddItems(table, order)}>
                {t('addItems')}
              </Button>
              <Button onClick={handleCheckout} disabled={generating}>
                {generating ? t('generating') : t('checkout')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
    {splitBill && <SplitCheckModal bill={splitBill} order={order} onClose={() => setSplitBill(null)} onSplit={(bills) => { setOrder({ ...order, bill: bills[0], bills }); setSplitBill(null); }} />}
    </>
  );
}
