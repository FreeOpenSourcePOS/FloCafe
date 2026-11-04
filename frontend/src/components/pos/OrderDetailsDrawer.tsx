'use client';

import {
  CalendarClock,
  Globe,
  MapPin,
  Minus,
  Package,
  Plus,
  StickyNote,
  Truck,
  Users,
  UtensilsCrossed,
  Wallet,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { CustomPaymentMethod } from '@/lib/payment-methods';
import { suggestFutureScheduleWallClock } from '@/lib/scheduled-time';
import { useCartStore } from '@/store/cart';

interface OrderDetailsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  effectiveTimezone: string;
  scheduleErrorMessage: string | null;
  customPaymentMethods: CustomPaymentMethod[];
  scheduledOrdersEnabled?: boolean;
}

const orderTypeIcons = {
  dine_in: UtensilsCrossed,
  takeaway: Package,
  delivery: Truck,
  online: Globe,
};

export function OrderDetailsDrawer({
  open,
  onOpenChange,
  effectiveTimezone,
  scheduleErrorMessage,
  customPaymentMethods,
  scheduledOrdersEnabled = false,
}: OrderDetailsDrawerProps) {
  const cart = useCartStore();
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const tOrders = useTranslations('orders');

  const Icon = orderTypeIcons[cart.orderType];
  const orderTypeLabel =
    cart.orderType === 'dine_in'
      ? t('orderTypeDineIn')
      : cart.orderType === 'takeaway'
        ? t('orderTypeTakeaway')
        : cart.orderType === 'delivery'
          ? t('orderTypeDelivery')
          : t('orderTypeOnline');

  const canSchedule =
    Boolean(scheduledOrdersEnabled) &&
    (cart.orderType === 'takeaway' || cart.orderType === 'delivery');

  const builtInMethods = [
    { key: 'unknown', value: '', label: tCommon('unknown') },
    { key: 'pending', value: 'pending', label: tOrders('pending') },
    { key: 'cash', value: 'cash', label: t('methodCash') },
    { key: 'card', value: 'card', label: t('methodCard') },
  ];

  const hasOrphanCustomMethod =
    cart.expectedPaymentMethodId !== null &&
    !customPaymentMethods.some((m) => m.id === cart.expectedPaymentMethodId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid="pos-order-details-drawer"
        className="flex flex-col gap-0 p-0 sm:max-w-sm"
      >
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Icon size={16} className="shrink-0 text-brand" />
            <span>{orderTypeLabel}</span>
          </SheetTitle>
          <SheetDescription className="sr-only">{orderTypeLabel}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-3.5 space-y-4">
          {cart.orderType === 'dine_in' && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Users size={15} className="shrink-0 text-muted-foreground" />
                <span>{t('pax')}</span>
              </div>
              <div className="inline-flex items-center rounded-full border border-border bg-card p-0.5">
                <button
                  type="button"
                  aria-label={t('decreasePax')}
                  onClick={() => cart.setGuestCount(Math.max(1, cart.guestCount - 1))}
                  className="relative touch-target h-7 w-7 min-h-7 min-w-7 rounded-full text-muted-foreground transition-colors after:content-[''] after:absolute after:-inset-1.5 hover:bg-muted hover:text-foreground active:bg-muted"
                >
                  <Minus size={14} />
                </button>
                <input
                  aria-label={t('pax')}
                  inputMode="numeric"
                  type="number"
                  min="1"
                  max="99"
                  value={cart.guestCount}
                  onChange={(e) =>
                    cart.setGuestCount(Math.min(99, Math.max(1, Number(e.target.value) || 1)))
                  }
                  className="w-10 text-center text-sm font-semibold tabular-nums border-0 outline-none bg-transparent"
                />
                <button
                  type="button"
                  aria-label={t('increasePax')}
                  onClick={() => cart.setGuestCount(Math.min(99, cart.guestCount + 1))}
                  className="relative touch-target h-7 w-7 min-h-7 min-w-7 rounded-full text-muted-foreground transition-colors after:content-[''] after:absolute after:-inset-1.5 hover:bg-muted hover:text-foreground active:bg-muted"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          )}

          {cart.orderType === 'delivery' && (
            <>
              <div className="space-y-1.5">
                <label
                  htmlFor="pos-delivery-address-drawer-input"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground"
                >
                  <MapPin size={14} className="shrink-0 text-muted-foreground" />
                  <span>{t('deliveryAddress')}</span>
                </label>
                <input
                  id="pos-delivery-address-drawer-input"
                  data-testid="pos-delivery-address-input"
                  type="text"
                  value={cart.deliveryAddress}
                  onChange={(e) => cart.setDeliveryAddress(e.target.value)}
                  placeholder={t('deliveryAddress')}
                  className="w-full min-h-10 px-3 py-2 text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <div className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Wallet size={14} className="shrink-0 text-muted-foreground" />
                  <span>{t('expectedPayment')}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {builtInMethods.map((method) => {
                    const selected =
                      cart.expectedPaymentMethodId === null &&
                      cart.expectedPaymentMethod === method.value;
                    return (
                      <button
                        key={method.key}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => cart.setExpectedPaymentMethod(method.value, null)}
                        className={`min-h-8 px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors ${
                          selected
                            ? 'border-brand bg-brand/10 text-brand'
                            : 'border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/60'
                        }`}
                      >
                        {method.label}
                      </button>
                    );
                  })}
                  {customPaymentMethods.map((method) => {
                    const selected = cart.expectedPaymentMethodId === method.id;
                    return (
                      <button
                        key={`custom:${method.id}`}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => cart.setExpectedPaymentMethod(method.name, method.id)}
                        className={`min-h-8 px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors ${
                          selected
                            ? 'border-brand bg-brand/10 text-brand'
                            : 'border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/60'
                        }`}
                      >
                        {method.name}
                      </button>
                    );
                  })}
                  {hasOrphanCustomMethod && (
                    <button
                      type="button"
                      aria-pressed={true}
                      onClick={() =>
                        cart.setExpectedPaymentMethod(
                          cart.expectedPaymentMethod,
                          cart.expectedPaymentMethodId,
                        )
                      }
                      className="min-h-8 px-2.5 py-1 rounded-lg border border-brand bg-brand/10 text-xs font-medium text-brand"
                    >
                      {cart.expectedPaymentMethod || tCommon('unknown')}
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="pos-delivery-note-drawer-input"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground"
                >
                  <StickyNote size={14} className="shrink-0 text-muted-foreground" />
                  <span>{t('deliveryNotePlaceholder')}</span>
                </label>
                <input
                  id="pos-delivery-note-drawer-input"
                  data-testid="pos-delivery-note-input"
                  type="text"
                  value={cart.deliveryNote}
                  onChange={(e) => cart.setDeliveryNote(e.target.value.slice(0, 200))}
                  placeholder={t('deliveryNotePlaceholder')}
                  maxLength={200}
                  className="w-full min-h-10 px-3 py-2 text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                />
              </div>
            </>
          )}

          {cart.orderType === 'online' && (
            <>
              <div className="space-y-1.5">
                <label
                  htmlFor="pos-online-platform-drawer-input"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground"
                >
                  <Globe size={14} className="shrink-0 text-muted-foreground" />
                  <span>{t('onlinePlatformPlaceholder')}</span>
                </label>
                <input
                  id="pos-online-platform-drawer-input"
                  data-testid="pos-online-platform-input"
                  type="text"
                  value={cart.onlinePlatform}
                  onChange={(e) => cart.setOnlinePlatform(e.target.value)}
                  placeholder={t('onlinePlatformPlaceholder')}
                  className="w-full min-h-10 px-3 py-2 text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="pos-external-order-id-drawer-input"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground"
                >
                  <span>{t('externalOrderIdPlaceholder')}</span>
                </label>
                <input
                  id="pos-external-order-id-drawer-input"
                  data-testid="pos-external-order-id-input"
                  type="text"
                  value={cart.externalOrderId}
                  onChange={(e) => cart.setExternalOrderId(e.target.value)}
                  placeholder={t('externalOrderIdPlaceholder')}
                  className="w-full min-h-10 px-3 py-2 text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                />
              </div>
            </>
          )}

          {canSchedule && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="pos-send-to-kitchen-drawer-input"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground"
                >
                  <CalendarClock size={14} className="shrink-0 text-muted-foreground" />
                  <span>{t('sendToKitchenAt')}</span>
                </label>
                {cart.scheduledFor ? (
                  <button
                    type="button"
                    data-testid="pos-schedule-clear-btn"
                    onClick={() => cart.setScheduledFor('')}
                    className="text-xs font-medium text-brand hover:underline"
                  >
                    {t('sendImmediately')}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="pos-schedule-suggest-btn"
                    onClick={() =>
                      cart.setScheduledFor(suggestFutureScheduleWallClock(effectiveTimezone))
                    }
                    className="text-xs font-medium text-brand hover:underline"
                  >
                    {t('scheduleOrderToggle')}
                  </button>
                )}
              </div>
              <input
                id="pos-send-to-kitchen-drawer-input"
                data-testid="pos-send-to-kitchen-input"
                type="datetime-local"
                value={cart.scheduledFor}
                onChange={(e) => cart.setScheduledFor(e.target.value)}
                className={`w-full min-h-10 px-2.5 py-1.5 text-sm border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand focus:border-brand ${
                  scheduleErrorMessage ? 'border-red-500' : 'border-border'
                }`}
              />
              <p className="text-[11px] text-muted-foreground leading-snug">
                {t('sendToKitchenHint', { timezone: effectiveTimezone })}
              </p>
              {scheduleErrorMessage && (
                <p
                  role="alert"
                  data-testid="pos-schedule-error"
                  className="text-xs text-red-600 dark:text-red-400 font-medium leading-snug"
                >
                  {scheduleErrorMessage}
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="pos-drawer-order-notes-input"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground"
            >
              <StickyNote size={14} className="shrink-0 text-muted-foreground" />
              <span>{t('orderNotesPlaceholder')}</span>
            </label>
            <input
              id="pos-drawer-order-notes-input"
              type="text"
              value={cart.orderNotes}
              onChange={(e) => cart.setOrderNotes(e.target.value.slice(0, 200))}
              placeholder={t('orderNotesPlaceholder')}
              maxLength={200}
              className="w-full min-h-10 px-3 py-2 text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
            />
          </div>
        </div>

        <SheetFooter className="border-t border-border p-3">
          <Button
            type="button"
            data-testid="pos-order-details-done-btn"
            onClick={() => onOpenChange(false)}
            className="w-full"
          >
            {tCommon('done')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
