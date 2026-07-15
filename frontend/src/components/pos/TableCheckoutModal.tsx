'use client';

import { useState, useEffect } from 'react';
import { X, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';
import toast from 'react-hot-toast';
import type { Table, Order, Bill, OrderItem } from '@/lib/types';
import { useAuthStore } from '@/store/auth';

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
  currency,
  cartItemCount,
  onClose,
  onAddItems,
  onPayment,
  onAddCartToOrder
}: Props) {
  const { t } = useI18n();
  const { currentTenant } = useAuthStore();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [addingItems, setAddingItems] = useState(false);

  useEffect(() => {
    const fetchOrder = async () => {
      try {
        const { data } = await api.get(`/tables/${table.id}`);
        const tbl = data.table;
        const activeOrder = tbl.activeOrder || tbl.current_order;
        if (activeOrder) {
          const orderRes = await api.get(`/orders/${activeOrder.id}`);
          setOrder(orderRes.data.order);
        }
      } catch {
        toast.error(t('pos.loadOrderFailed'));
      } finally {
        setLoading(false);
      }
    };
    fetchOrder();
  }, [table.id, t]);

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
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error.response?.data?.message || t('pos.generateBillFailed'));
    } finally {
      setGenerating(false);
    }
  };

  const handleAddCartToOrder = async () => {
    if (!order || !onAddCartToOrder) return;
    setAddingItems(true);
    try {
      await onAddCartToOrder(table, order);
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
          <p className="text-gray-500 text-center py-4">{t('pos.noActiveOrder')}</p>
          <Button onClick={onClose} variant="outline" className="w-full">{t('pos.close')}</Button>
        </div>
      </div>
    );
  }

  // Filter active items (not cancelled)
  const activeItems = (order.items || []).filter((item: OrderItem) => item.status !== 'cancelled');

  return (
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
                {order.bill?.payment_status === 'paid' ? t('pos.paid') : t('pos.unpaid')}
              </span>
            </div>
            <p className="text-sm text-gray-500">{t('pos.orderNumber', { number: order.order_number })}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* Existing order items - shown as disabled/reference */}
          <div className="mb-3">
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">{t('pos.previousItems')}</p>
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
                  <span className="text-xs text-gray-600 ml-2 font-medium">
                    {currency}{Number(item.total).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="p-5 border-t border-gray-100 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">{t('pos.subtotal')}</span>
            <span>{currency}{Number(order.subtotal).toLocaleString()}</span>
          </div>
          <TaxBreakdown
            taxAmount={Number(order.tax_amount)}
            taxBreakdown={order.tax_breakdown}
            currencyCode={currentTenant?.currency || 'INR'}
            theme="light"
          />
          <div className="flex justify-between text-lg font-bold">
            <span>{t('pos.total')}</span>
            <span className="text-brand">{currency}{Number(order.total).toLocaleString()}</span>
          </div>
          {order.bill && order.bill.payment_status !== 'paid' && Number(order.bill.balance) > 0 && (
            <div className="flex justify-between text-sm font-medium">
              <span className="text-orange-600">{t('pos.balanceDue')}</span>
              <span className="text-orange-600">{currency}{Number(order.bill.balance).toLocaleString()}</span>
            </div>
          )}

          {/* Show different buttons based on cart state */}
          {cartItemCount > 0 ? (
            // Cart has items - show "Add items to order" option
            <div className="space-y-2">
              <Button 
                onClick={handleAddCartToOrder} 
                disabled={addingItems}
                className="w-full"
                size="lg"
              >
                <ShoppingCart size={16} className="mr-2" />
                {addingItems ? t('pos.adding') : t('pos.addToOrder', { count: cartItemCount })}
              </Button>
              <Button onClick={handleCheckout} variant="outline" className="w-full" disabled={generating}>
                {generating ? t('pos.generating') : t('pos.checkoutInstead')}
              </Button>
            </div>
          ) : (
            // Cart empty - show both options
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" onClick={() => onAddItems(table, order)}>
                {t('pos.addItems')}
              </Button>
              <Button onClick={handleCheckout} disabled={generating}>
                {generating ? t('pos.generating') : t('pos.checkout')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
