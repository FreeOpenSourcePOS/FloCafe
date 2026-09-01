'use client';

import {
  ShoppingCart, UtensilsCrossed, Package, Truck, Globe,
  Plus, Minus, Trash2, Pause, MapPin, SquarePen,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import type { Table, Order, OrderItem, CartItem } from '@/lib/types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

interface Props {
  tables: Table[];
  currency: string;
  submitting: boolean;
  onPlaceOrder: () => void;
  onShowTablePicker: () => void;
  onEditItem?: (item: CartItem) => void;
  variant?: 'sidebar' | 'drawer';
  existingOrder?: Order | null;
}

const orderTypeIcons = {
  dine_in: UtensilsCrossed,
  takeaway: Package,
  delivery: Truck,
  online: Globe,
};

export default function CartPanel({ tables, submitting, onPlaceOrder, onEditItem, variant = 'sidebar', existingOrder }: Props) {
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const { currentTenant } = useAuthStore();
  const billingType = usePosSettingsStore((s) => s.billingType);
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const fmt = useFormatCurrency();
  const canHold = isRestaurant && cart.orderType === 'dine_in' && cart.tableId && cart.items.length > 0 && billingType === 'postpaid';

  const handleHold = async () => {
    if (!cart.tableId) {
      toast.error(t('selectTableFirst'));
      return;
    }
    if (cart.items.length === 0) {
      toast.error(t('cartEmpty'));
      return;
    }
    const tableName = tables.find((t) => t.id === cart.tableId)?.name || cart.tableId;
    try {
      await heldOrders.holdOrder(cart.tableId, cart.items, cart.customerId, cart.guestCount, cart.orderNotes);
      cart.clearCart();
      toast.success(t('orderHeldFor', { table: tableName }));
    } catch {
      toast.error(t('holdOrderFailed'));
    }
  };

  const isDrawer = variant === 'drawer';

  return (
    <div className={
      isDrawer
        ? 'flex flex-col w-full'
        : 'w-full h-full bg-card rounded-xl border border-border dark:border-border flex flex-col shadow-sm'
    }>
      {/* Order Type */}
      <div className="p-4 border-b border-border dark:border-border space-y-2">
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {(['dine_in', 'takeaway', 'delivery', 'online'] as const)
            .filter((type) => isRestaurant || type !== 'dine_in')
            .map((type) => {
              const Icon = orderTypeIcons[type];
              const label = type === 'dine_in' ? t('orderTypeDineIn') : type === 'takeaway' ? t('orderTypeTakeaway') : type === 'delivery' ? t('orderTypeDelivery') : t('orderTypeOnline');
              return (
                <button
                  key={type}
                  onClick={() => cart.setOrderType(type)}
                  className={`touch-target flex-1 gap-1 px-2 rounded-md text-xs font-medium transition-colors ${
                    cart.orderType === type
                      ? 'bg-card text-brand shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </button>
              );
            })}
        </div>

        {cart.orderType === 'dine_in' && (
          <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Users size={15} /><span>{t('pax')}</span></div>
            <div className="flex items-center gap-2">
              <button type="button" aria-label={t('decreasePax')} onClick={() => cart.setGuestCount(Math.max(1, cart.guestCount - 1))} className="touch-target rounded-full bg-muted"><Minus size={15} /></button>
              <input aria-label={t('pax')} inputMode="numeric" type="number" min="1" max="99" value={cart.guestCount} onChange={(e) => cart.setGuestCount(Math.min(99, Math.max(1, Number(e.target.value) || 1)))} className="w-12 text-center text-base font-semibold border-0 outline-none bg-transparent" />
              <button type="button" aria-label={t('increasePax')} onClick={() => cart.setGuestCount(Math.min(99, cart.guestCount + 1))} className="touch-target rounded-full bg-muted"><Plus size={15} /></button>
            </div>
          </div>
        )}

        {/* Delivery address — shown inline when delivery is selected */}
        {cart.orderType === 'delivery' && (
          <div className="flex items-center gap-2">
            <MapPin size={14} className="text-gray-400 shrink-0" />
            <input
              type="text"
              value={cart.deliveryAddress}
              onChange={(e) => cart.setDeliveryAddress(e.target.value)}
              placeholder={t('deliveryAddress')}
              className="flex-1 min-h-11 px-3 py-2 text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
            />
          </div>
        )}

        {/* Online platform + external order id — shown inline when online is selected */}
        {cart.orderType === 'online' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-gray-400 shrink-0" />
              <input
                type="text"
                value={cart.onlinePlatform}
                onChange={(e) => cart.setOnlinePlatform(e.target.value)}
                placeholder={t('onlinePlatformPlaceholder')}
                className="flex-1 min-h-11 px-3 py-2 text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
              />
            </div>
            <input
              type="text"
              value={cart.externalOrderId}
              onChange={(e) => cart.setExternalOrderId(e.target.value)}
              placeholder={t('externalOrderIdPlaceholder')}
              className="flex-1 min-h-11 px-3 py-2 text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
            />
          </div>
        )}
      </div>

      {/* Cart Items */}
      <div className={isDrawer ? 'overflow-y-auto p-4 max-h-[40vh]' : 'flex-1 overflow-y-auto p-4'}>
        {/* Previously ordered items (add-items mode) */}
        {existingOrder && existingOrder.items && existingOrder.items.filter((i: OrderItem) => i.status !== 'cancelled').length > 0 && (
          <div className="mb-3 pb-3 border-b border-dashed border-border">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{t('alreadyOrdered')}</p>
            <div className="space-y-1.5">
              {existingOrder.items.filter((i: OrderItem) => i.status !== 'cancelled').map((item: OrderItem) => (
                <div key={item.id} className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">{item.quantity}× {item.product_name}</span>
                  <span className="text-xs text-gray-400">{fmt(Number(item.total))}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {cart.items.length === 0 ? (
          <div className={`flex flex-col items-center justify-center text-gray-400 ${existingOrder ? 'py-4' : isDrawer ? 'py-8' : 'h-full'}`}>
            <ShoppingCart size={existingOrder ? 24 : 40} />
            <p className="mt-2 text-sm">{existingOrder ? t('addNewItemsAbove') : t('cartEmpty')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {cart.items.map((item) => (
              <div key={item.id} className="flex items-start gap-3">
                <button
                  onClick={() => cart.removeItem(item.id)}
                  className="touch-target -ms-2 -mt-2 rounded-full text-gray-300 hover:text-red-500 hover:bg-red-50 active:bg-red-50 transition-colors shrink-0"
                  aria-label={t('remove')}
                >
                  <Trash2 size={16} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-foreground truncate">
                      {item.product.name}
                    </p>
                    {onEditItem && (
                      <button
                        onClick={() => onEditItem(item)}
                        className="touch-target shrink-0 gap-1 rounded-full bg-amber-100 px-3 text-amber-700 hover:bg-amber-200 active:bg-amber-200 text-xs font-medium transition-colors"
                      >
                        <SquarePen size={12} />
                        {tCommon('edit')}
                      </button>
                    )}
                  </div>
                  {item.addons.length > 0 && (
                    <div className="mt-0.5">
                      {item.addons.map((a) => (
                        <p key={a.id} className="text-xs text-gray-400">
                          + {a.name}{(a.quantity || 1) > 1 ? ` ×${a.quantity}` : ''} {Number(a.price) > 0 && `(${fmt(Number(a.price) * (a.quantity || 1))})`}
                        </p>
                      ))}
                    </div>
                  )}
                  {item.special_instructions && (
                    <p className="text-xs text-gray-400 italic mt-0.5 break-words">{item.special_instructions}</p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {fmt(Number(item.product.price))}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => cart.updateQuantity(item.id, item.quantity - 1)}
                    className="touch-target rounded-full bg-muted hover:bg-muted/70 active:bg-muted/70 transition-colors"
                    aria-label={t('remove')}
                  >
                    <Minus size={16} />
                  </button>
                  <span className="text-base font-semibold w-6 text-center tabular-nums">{item.quantity}</span>
                  <button
                    onClick={() => cart.updateQuantity(item.id, item.quantity + 1)}
                    className="touch-target rounded-full bg-muted hover:bg-muted/70 active:bg-muted/70 transition-colors"
                    aria-label={t('addItems')}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cart Footer */}
      <div className="p-4 border-t border-border dark:border-border">
        {/* Order Notes */}
        {cart.items.length > 0 && (
          <div className="mb-3">
            <textarea
              value={cart.orderNotes}
              onChange={(e) => cart.setOrderNotes(e.target.value.slice(0, 200))}
              placeholder={t('orderNotesPlaceholder')}
              rows={2}
              maxLength={200}
              className="w-full min-h-20 px-3 py-2 text-sm border border-border bg-card rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
            />
            <p className="text-xs text-gray-400 text-end mt-0.5">{cart.orderNotes.length}/200</p>
          </div>
        )}
        <div className="flex justify-between mb-1 text-sm">
          <span className="text-muted-foreground">{t('items')}</span>
          <span className="font-medium">{cart.itemCount()}</span>
        </div>
        <div className="flex justify-between mb-4 text-lg">
          <span className="font-semibold text-foreground">{t('subtotal')}</span>
          <span className="font-bold text-brand">
            {fmt(cart.subtotal())}
          </span>
        </div>
        <div className="flex gap-2">
          {canHold && (
            <Button variant="outline" onClick={handleHold} className="flex-1">
              <Pause size={14} className="me-1" /> {t('holdButton')}
            </Button>
          )}
          <Button
            onClick={onPlaceOrder}
            disabled={submitting || cart.items.length === 0}
            className="flex-1"
            size="lg"
          >
            {submitting ? t('placing') : t('placeOrderButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}
