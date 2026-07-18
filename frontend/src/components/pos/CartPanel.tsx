'use client';

import {
  ShoppingCart, UtensilsCrossed, Package, Truck,
  Plus, Minus, Trash2, Pause, MapPin,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useI18n } from '@/hooks/useI18n';
import toast from 'react-hot-toast';
import type { Table, Order, OrderItem } from '@/lib/types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

interface Props {
  tables: Table[];
  currency: string;
  submitting: boolean;
  onPlaceOrder: () => void;
  onShowTablePicker: () => void;
  variant?: 'sidebar' | 'drawer';
  existingOrder?: Order | null;
}

const orderTypeIcons = {
  dine_in: UtensilsCrossed,
  takeaway: Package,
  delivery: Truck,
};

export default function CartPanel({ tables, submitting, onPlaceOrder, variant = 'sidebar', existingOrder }: Props) {
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const { currentTenant } = useAuthStore();
  const billingType = usePosSettingsStore((s) => s.billingType);
  const { t } = useI18n();
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const fmt = useFormatCurrency();
  const canHold = isRestaurant && cart.orderType === 'dine_in' && cart.tableId && cart.items.length > 0 && billingType === 'postpaid';

  const handleHold = async () => {
    if (!cart.tableId) {
      toast.error(t('pos.selectTableFirst'));
      return;
    }
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    const tableName = tables.find((t) => t.id === cart.tableId)?.name || cart.tableId;
    try {
      await heldOrders.holdOrder(cart.tableId, cart.items, cart.customerId, cart.guestCount, cart.orderNotes);
      cart.clearCart();
      toast.success(t('pos.orderHeldFor', { table: tableName }));
    } catch (err: unknown) {
      const e = err as Error;
      toast.error(e.message || t('pos.holdOrderFailed'));
    }
  };

  const isDrawer = variant === 'drawer';

  return (
    <div className={
      isDrawer
        ? 'flex flex-col w-full'
        : 'w-full h-full bg-white rounded-xl border border-gray-100 flex flex-col shadow-sm'
    }>
      {/* Order Type */}
      <div className="p-4 border-b border-gray-100 space-y-2">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(['dine_in', 'takeaway', 'delivery'] as const)
            .filter((type) => isRestaurant || type !== 'dine_in')
            .map((type) => {
              const Icon = orderTypeIcons[type];
              const label = type === 'dine_in' ? t('pos.orderTypeDineIn') : type === 'takeaway' ? t('pos.orderTypeTakeaway') : t('pos.orderTypeDelivery');
              return (
                <button
                  key={type}
                  onClick={() => cart.setOrderType(type)}
                  className={`flex-1 flex items-center justify-center gap-1 py-2 rounded-md text-xs font-medium transition-colors ${
                    cart.orderType === type
                      ? 'bg-white text-brand shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </button>
              );
            })}
        </div>

        {/* Delivery address — shown inline when delivery is selected */}
        {cart.orderType === 'delivery' && (
          <div className="flex items-center gap-2">
            <MapPin size={14} className="text-gray-400 shrink-0" />
            <input
              type="text"
              value={cart.deliveryAddress}
              onChange={(e) => cart.setDeliveryAddress(e.target.value)}
              placeholder={t('pos.deliveryAddress')}
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
            />
          </div>
        )}
      </div>

      {/* Cart Items */}
      <div className={isDrawer ? 'overflow-y-auto p-4 max-h-[40vh]' : 'flex-1 overflow-y-auto p-4'}>
        {/* Previously ordered items (add-items mode) */}
        {existingOrder && existingOrder.items && existingOrder.items.filter((i: OrderItem) => i.status !== 'cancelled').length > 0 && (
          <div className="mb-3 pb-3 border-b border-dashed border-gray-200">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{t('pos.alreadyOrdered')}</p>
            <div className="space-y-1.5">
              {existingOrder.items.filter((i: OrderItem) => i.status !== 'cancelled').map((item: OrderItem) => (
                <div key={item.id} className="flex justify-between items-center">
                  <span className="text-xs text-gray-500">{item.quantity}× {item.product_name}</span>
                  <span className="text-xs text-gray-400">{fmt(Number(item.total))}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {cart.items.length === 0 ? (
          <div className={`flex flex-col items-center justify-center text-gray-400 ${existingOrder ? 'py-4' : isDrawer ? 'py-8' : 'h-full'}`}>
            <ShoppingCart size={existingOrder ? 24 : 40} />
            <p className="mt-2 text-sm">{existingOrder ? t('pos.addNewItemsAbove') : t('pos.cartEmpty')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {cart.items.map((item) => (
              <div key={item.id} className="flex items-start gap-3">
                <button
                  onClick={() => cart.removeItem(item.id)}
                  className="w-6 h-6 rounded-full text-gray-300 hover:text-red-500 hover:bg-red-50 flex items-center justify-center transition-colors mt-0.5 shrink-0"
                >
                  <Trash2 size={13} />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {item.product.name}
                  </p>
                  {item.addons.length > 0 && (
                    <div className="mt-0.5">
                      {item.addons.map((a) => (
                        <p key={a.id} className="text-xs text-gray-400">
                          + {a.name} {Number(a.price) > 0 && `(${fmt(Number(a.price))})`}
                        </p>
                      ))}
                    </div>
                  )}
                  {item.special_instructions && (
                    <p className="text-xs text-gray-400 italic mt-0.5 break-words">{item.special_instructions}</p>
                  )}
                  <p className="text-sm text-gray-500">
                    {fmt(Number(item.product.price))}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => cart.updateQuantity(item.id, item.quantity - 1)}
                    className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-colors"
                  >
                    <Minus size={14} />
                  </button>
                  <span className="text-sm font-medium w-5 text-center">{item.quantity}</span>
                  <button
                    onClick={() => cart.updateQuantity(item.id, item.quantity + 1)}
                    className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-colors"
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cart Footer */}
      <div className="p-4 border-t border-gray-100">
        {/* Order Notes */}
        {cart.items.length > 0 && (
          <div className="mb-3">
            <textarea
              value={cart.orderNotes}
              onChange={(e) => cart.setOrderNotes(e.target.value.slice(0, 200))}
              placeholder={t('pos.orderNotesPlaceholder')}
              rows={2}
              maxLength={200}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
            />
            <p className="text-xs text-gray-400 text-right mt-0.5">{cart.orderNotes.length}/200</p>
          </div>
        )}
        <div className="flex justify-between mb-1 text-sm">
          <span className="text-gray-500">{t('pos.items')}</span>
          <span className="font-medium">{cart.itemCount()}</span>
        </div>
        <div className="flex justify-between mb-4 text-lg">
          <span className="font-semibold text-gray-900">{t('pos.subtotal')}</span>
          <span className="font-bold text-brand">
            {fmt(cart.subtotal())}
          </span>
        </div>
        <div className="flex gap-2">
          {canHold && (
            <Button variant="outline" onClick={handleHold} className="flex-1">
              <Pause size={14} className="mr-1" /> {t('pos.holdButton')}
            </Button>
          )}
          <Button
            onClick={onPlaceOrder}
            disabled={submitting || cart.items.length === 0}
            className="flex-1"
            size="lg"
          >
            {submitting ? t('pos.placing') : t('pos.placeOrderButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}
