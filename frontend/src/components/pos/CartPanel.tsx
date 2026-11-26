'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ShoppingCart,
  UtensilsCrossed,
  Package,
  Truck,
  Globe,
  Plus,
  Minus,
  Trash2,
  Pause,
  MapPin,
  SquarePen,
  Tag,
  Users,
  StickyNote,
  CalendarClock,
  CreditCard,
  ChevronRight,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import api from '@/lib/api';
import type { CustomPaymentMethod } from '@/lib/payment-methods';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import type { Table, Order, OrderItem, CartItem } from '@/lib/types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { fractionalQuantityStep, roundToQuantityPrecision } from '@/lib/utils';
import { cartLineUnitPrice, cartVariantUnitPrice } from '@/lib/cart-price';
import { tenantCan } from '@/lib/permissions';
import { CartPriceOverrideModal } from '@/components/pos/CartPriceOverrideModal';
import { OrderDetailsDrawer } from '@/components/pos/OrderDetailsDrawer';
import { CHECKOUT_PRIMARY_CTA_CLASS } from './checkout-ui';
import { calculateAppliedCharges } from '@/lib/charges';
import { chargesForOrderType, useChargesStore } from '@/store/charges';
import { getCurrencyFractionDigits } from '@countries';
import { isTerminalItemStatus } from '../../../../shared/order-item-status';
import { formatScheduledInstantForDisplay, parseScheduledForInput } from '@/lib/scheduled-time';
import { PizzaLineActions, PizzaLineDetails } from './pizza/PizzaCartLine';
import type { PizzaPos } from './pizza/usePizzaPos';

interface Props {
  tables: Table[];
  currency: string;
  submitting: boolean;
  onPlaceOrder: () => void;
  onSendToPayment?: () => void;
  onOpenPaymentQueue?: () => void;
  counterRole?: 'ordering' | 'payment' | 'combined' | null;
  multiCounterEnabled?: boolean;
  scheduledOrdersEnabled?: boolean;
  onEditItem?: (item: CartItem) => void;
  /** The pizza screens, when a pizza menu is loaded: a pizza line gets its own action row. */
  pizza?: PizzaPos | null;
  onModalOpenChange?: (open: boolean) => void;
  variant?: 'sidebar' | 'drawer';
  existingOrder?: Order | null;
  storeTimezone?: string;
  onCancelExistingOrderMode?: () => void;
}

const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery', 'online'] as const;
type OrderType = (typeof ORDER_TYPES)[number];

const orderTypeIcons: Record<OrderType, typeof UtensilsCrossed> = {
  dine_in: UtensilsCrossed,
  takeaway: Package,
  delivery: Truck,
  online: Globe,
};

const ORDER_TYPE_ICON_PX = 13;
const TRACK_GAP_UNITS = 0.5;
const FULL_MODE_PADDING_X_UNITS = 0.5;
const FULL_MODE_GAP_UNITS = 0.5;
const SUBPIXEL_FIT_GUARD_PX = 1;

export function resolveFullModeOrderTypeChromePx(
  fullModeButtonStyle: Pick<
    CSSStyleDeclaration,
    'paddingLeft' | 'paddingRight' | 'columnGap'
  > | null,
  trackStyle: Pick<CSSStyleDeclaration, 'columnGap'> | null,
  rootFontSizePx: number,
): number {
  if (fullModeButtonStyle) {
    const padLeft = Number.parseFloat(fullModeButtonStyle.paddingLeft);
    const padRight = Number.parseFloat(fullModeButtonStyle.paddingRight);
    const colGap = Number.parseFloat(fullModeButtonStyle.columnGap);
    if (Number.isFinite(padLeft) && Number.isFinite(padRight) && Number.isFinite(colGap)) {
      return padLeft + padRight + colGap + ORDER_TYPE_ICON_PX + SUBPIXEL_FIT_GUARD_PX;
    }
  }
  const safeRootFontSize =
    Number.isFinite(rootFontSizePx) && rootFontSizePx > 0 ? rootFontSizePx : 16;
  const parsedTrackGap = trackStyle ? Number.parseFloat(trackStyle.columnGap) : Number.NaN;
  const spacingUnitPx =
    Number.isFinite(parsedTrackGap) && parsedTrackGap > 0
      ? parsedTrackGap / TRACK_GAP_UNITS
      : safeRootFontSize * 0.25;
  const fullSpacingUnits = 2 * FULL_MODE_PADDING_X_UNITS + FULL_MODE_GAP_UNITS;
  return fullSpacingUnits * spacingUnitPx + ORDER_TYPE_ICON_PX + SUBPIXEL_FIT_GUARD_PX;
}

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function ItemQuantityControl({
  item,
  updateQuantity,
}: {
  item: CartItem;
  updateQuantity: (cartItemId: string, quantity: number) => void;
}) {
  const t = useTranslations('pos');
  const step = fractionalQuantityStep(item.product);
  const [draft, setDraft] = useState(() => String(item.quantity));
  const [lastQuantity, setLastQuantity] = useState(item.quantity);
  if (lastQuantity !== item.quantity) {
    setLastQuantity(item.quantity);
    setDraft(String(item.quantity));
  }

  const commitDraft = () => {
    if (step == null) return;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(String(item.quantity));
      return;
    }
    const rounded = Math.max(step, roundToQuantityPrecision(parsed, step));
    updateQuantity(item.id, rounded);
    setDraft(String(rounded));
  };

  const stepBy = (sign: 1 | -1) => {
    if (step == null) {
      updateQuantity(item.id, item.quantity + sign);
      return;
    }
    const next = roundToQuantityPrecision(item.quantity + sign * step, step);
    updateQuantity(item.id, next);
    setDraft(String(next));
  };

  if (step == null) {
    return (
      <>
        <button
          type="button"
          onClick={() => stepBy(-1)}
          className="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
          aria-label={t('remove')}
        >
          <Minus size={13} />
        </button>
        <span
          data-testid="cart-item-qty"
          className="min-w-6 px-1 text-center text-xs font-semibold tabular-nums text-foreground"
        >
          {item.quantity}
        </span>
        <button
          type="button"
          onClick={() => stepBy(1)}
          className="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
          aria-label={t('addItems')}
        >
          <Plus size={13} />
        </button>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => stepBy(-1)}
        className="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
        aria-label={t('remove')}
      >
        <Minus size={13} />
      </button>
      <input
        type="number"
        inputMode="decimal"
        min={step}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitDraft();
        }}
        aria-label={t('quantity')}
        className="w-12 text-center text-xs font-semibold tabular-nums border-0 bg-transparent px-0.5 outline-none focus:ring-1 focus:ring-brand/30 rounded"
      />
      <button
        type="button"
        onClick={() => stepBy(1)}
        className="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
        aria-label={t('addItems')}
      >
        <Plus size={13} />
      </button>
    </>
  );
}

export default function CartPanel({
  tables,
  submitting,
  onPlaceOrder,
  onSendToPayment,
  onOpenPaymentQueue,
  counterRole,
  multiCounterEnabled = false,
  scheduledOrdersEnabled = false,
  onEditItem,
  pizza,
  onModalOpenChange,
  variant = 'sidebar',
  existingOrder,
  storeTimezone,
  onCancelExistingOrderMode,
}: Props) {
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const { user, currentTenant } = useAuthStore();
  const canOverridePrice = tenantCan(currentTenant, 'orders.item.price_override');
  const [priceOverrideState, setPriceOverrideState] = useState<{
    userId: string | number | undefined;
    itemId: string;
  } | null>(null);
  const priceOverrideItemId =
    canOverridePrice && priceOverrideState && priceOverrideState.userId === user?.id
      ? priceOverrideState.itemId
      : null;
  const setPriceOverrideItemId = (itemId: string | null) =>
    setPriceOverrideState(itemId ? { userId: user?.id, itemId } : null);
  const priceOverrideTarget =
    canOverridePrice && priceOverrideItemId
      ? cart.items.find((i) => i.id === priceOverrideItemId)
      : undefined;
  const priceOverrideOpen = Boolean(priceOverrideTarget);
  const [detailsDrawerOpen, setDetailsDrawerOpen] = useState(false);
  const [orderNotesExpanded, setOrderNotesExpanded] = useState(false);
  const effectiveDetailsDrawerOpen = detailsDrawerOpen && !existingOrder;
  useEffect(() => {
    onModalOpenChange?.(priceOverrideOpen || effectiveDetailsDrawerOpen);
    return () => onModalOpenChange?.(false);
  }, [priceOverrideOpen, effectiveDetailsDrawerOpen, onModalOpenChange]);
  const billingType = usePosSettingsStore((s) => s.billingType);
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const tOrders = useTranslations('orders');
  const tPrintKot = useTranslations('print.kot');
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const orderTypeTrackRef = useRef<HTMLDivElement | null>(null);
  const orderTypeLabelRefs = useRef<Partial<Record<OrderType, HTMLSpanElement | null>>>({});
  const [isOrderTypeCompact, setIsOrderTypeCompact] = useState(false);
  const [truncatedOrderTypes, setTruncatedOrderTypes] = useState<
    Partial<Record<OrderType, boolean>>
  >({});
  const orderTypeLabels: Record<OrderType, string> = {
    dine_in: t('orderTypeDineIn'),
    takeaway: t('orderTypeTakeaway'),
    delivery: t('orderTypeDelivery'),
    online: t('orderTypeOnline'),
  };
  const visibleOrderTypes = ORDER_TYPES.filter((type) => isRestaurant || type !== 'dine_in');
  const orderTypeMeasureKey = `${isRestaurant ? '1' : '0'}:${visibleOrderTypes.map((type) => orderTypeLabels[type]).join('|')}`;

  useIsomorphicLayoutEffect(() => {
    const track = orderTypeTrackRef.current;
    if (!track) return;

    const measure = () => {
      const currentTrack = orderTypeTrackRef.current;
      if (!currentTrack || currentTrack.clientWidth <= 0) return;

      const style = window.getComputedStyle(currentTrack);
      const inlinePadding =
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      const rootFontSize =
        typeof document !== 'undefined'
          ? Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
          : 16;
      const parsedGap = Number.parseFloat(style.columnGap);
      const gap = Number.isFinite(parsedGap) ? parsedGap : 0.125 * rootFontSize;
      const availableWidth = currentTrack.clientWidth - inlinePadding;
      if (availableWidth <= 0) return;

      const types = ORDER_TYPES.filter((type) => isRestaurant || type !== 'dine_in');
      const sampleFullModeButton = !isOrderTypeCompact
        ? (orderTypeLabelRefs.current[types[0]]?.parentElement ?? null)
        : null;
      const fullModeSegmentChromePx = resolveFullModeOrderTypeChromePx(
        sampleFullModeButton ? window.getComputedStyle(sampleFullModeButton) : null,
        style,
        rootFontSize,
      );

      let requiredFullWidth = Math.max(0, types.length - 1) * gap;
      for (const type of types) {
        const span = orderTypeLabelRefs.current[type];
        let labelWidth = span?.scrollWidth ?? 0;
        if (span && typeof document.createRange === 'function') {
          const range = document.createRange();
          range.selectNodeContents(span);
          labelWidth = Math.max(labelWidth, range.getBoundingClientRect().width);
        }
        requiredFullWidth += fullModeSegmentChromePx + Math.ceil(labelWidth);
      }

      const nextCompact = requiredFullWidth > availableWidth;
      setIsOrderTypeCompact((prev) => (prev === nextCompact ? prev : nextCompact));

      const nextTruncated: Partial<Record<OrderType, boolean>> = {};
      for (const type of types) {
        const span = orderTypeLabelRefs.current[type];
        if (
          span &&
          !span.classList.contains('sr-only') &&
          span.scrollWidth > span.clientWidth + 1
        ) {
          nextTruncated[type] = true;
        }
      }
      setTruncatedOrderTypes((prev) => {
        const unchanged = ORDER_TYPES.every(
          (type) => Boolean(prev[type]) === Boolean(nextTruncated[type]),
        );
        return unchanged ? prev : nextTruncated;
      });
    };

    measure();

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => measure());
      observer.observe(track);
      for (const type of ORDER_TYPES) {
        const span = orderTypeLabelRefs.current[type];
        if (span) observer.observe(span);
      }
    }

    let cancelled = false;
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [isRestaurant, orderTypeMeasureKey, cart.orderType, isOrderTypeCompact]);
  const fmt = useFormatCurrency();
  const effectiveTimezone = storeTimezone || currentTenant?.timezone || 'UTC';
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);
  const canScheduleCart =
    Boolean(scheduledOrdersEnabled) &&
    !existingOrder &&
    (cart.orderType === 'takeaway' || cart.orderType === 'delivery');
  const scheduleValidation =
    canScheduleCart && cart.scheduledFor.trim().length > 0
      ? parseScheduledForInput({
          input: cart.scheduledFor,
          timezone: effectiveTimezone,
          nowMs,
        })
      : null;
  const scheduleErrorMessage =
    scheduleValidation && !scheduleValidation.ok
      ? scheduleValidation.code === 'PAST_SCHEDULED_TIME'
        ? t('scheduledPastTimeError', { timezone: effectiveTimezone })
        : scheduleValidation.code === 'DST_NONEXISTENT_TIME'
          ? t('scheduledDstSkippedError', { timezone: effectiveTimezone })
          : scheduleValidation.code === 'DST_AMBIGUOUS_TIME'
            ? t('scheduledDstAmbiguousError', { timezone: effectiveTimezone })
            : t('scheduledInvalidTimeError', { timezone: effectiveTimezone })
      : null;
  const canHold =
    isRestaurant &&
    cart.orderType === 'dine_in' &&
    cart.tableId &&
    cart.items.length > 0 &&
    billingType === 'postpaid';

  const isDeliveryOrder = cart.orderType === 'delivery';
  const [customPaymentMethods, setCustomPaymentMethods] = useState<CustomPaymentMethod[]>([]);
  useEffect(() => {
    if (!isDeliveryOrder || existingOrder) return;
    api
      .get('/payment-methods')
      .then((res) => setCustomPaymentMethods(res.data.payment_methods || []))
      .catch(() => setCustomPaymentMethods([]));
  }, [isDeliveryOrder, existingOrder]);

  const charges = useChargesStore((s) => s.charges);
  const loadCharges = useChargesStore((s) => s.load);
  useEffect(() => {
    void loadCharges();
  }, [loadCharges]);

  // Preview only: the backend recomputes and persists the authoritative amounts.
  const applicableCharges = chargesForOrderType(charges, cart.orderType);
  const appliedCharges = calculateAppliedCharges({
    definitions: applicableCharges,
    orderType: cart.orderType,
    subtotal: cart.subtotal(),
    discountAmount: 0,
    waivedIds: cart.waivedChargeIds,
    optedInIds: cart.optedInChargeIds,
    currencyDecimals: getCurrencyFractionDigits(currentTenant?.currency || ''),
  });
  const chargeTotal = appliedCharges.reduce(
    (sum, charge) => sum + (charge.waived ? 0 : charge.amount),
    0,
  );
  // A charge the merchant left off by default is never applied until the cashier
  // adds it, so it has to be listed here or there is no way to add it.
  const addableCharges = applicableCharges.filter(
    (charge) => !charge.is_default_active && !cart.optedInChargeIds.has(charge.id),
  );

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
      await heldOrders.holdOrder(
        cart.tableId,
        cart.items,
        cart.customerId,
        cart.guestCount,
        cart.orderNotes,
        [...cart.waivedChargeIds],
        [...cart.optedInChargeIds],
      );
      cart.clearCart();
      toast.success(t('orderHeldFor', { table: tableName }));
    } catch {
      toast.error(t('holdOrderFailed'));
    }
  };

  const isDrawer = variant === 'drawer';

  const expectedPaymentSummaryLabel =
    cart.expectedPaymentMethodId !== null
      ? customPaymentMethods.find((m) => m.id === cart.expectedPaymentMethodId)?.name ||
        cart.expectedPaymentMethod ||
        tCommon('unknown')
      : cart.expectedPaymentMethod === 'pending'
        ? tOrders('pending')
        : cart.expectedPaymentMethod === 'cash'
          ? t('methodCash')
          : cart.expectedPaymentMethod === 'card'
            ? t('methodCard')
            : tCommon('unknown');

  const orderNotesShortLabel =
    t('orderNotesPlaceholder')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim() || t('orderNotesPlaceholder');

  return (
    <div
      data-testid="cart-shell"
      className={
        isDrawer
          ? 'flex flex-col w-full'
          : 'pos-cart-shell w-full h-full bg-card rounded-xl border border-border dark:border-border flex flex-col shadow-sm'
      }
    >
      {/* Order Type + Compact OrderDetailsSummary */}
      <div className="px-2.5 py-1 border-b border-border dark:border-border space-y-1">
        {existingOrder &&
          existingOrder.release_status &&
          existingOrder.release_status !== 'released' && (
            <div
              data-testid="cart-scheduled-existing-banner"
              className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50/70 px-2.5 py-1.5 text-xs text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200"
            >
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <CalendarClock size={14} className="shrink-0" />
                <span className="truncate font-medium">
                  {t('scheduledAddingToBanner', {
                    number: existingOrder.order_number,
                    time: existingOrder.scheduled_for
                      ? formatScheduledInstantForDisplay(
                          existingOrder.scheduled_for,
                          effectiveTimezone,
                        )
                      : '',
                  })}
                </span>
              </span>
              {onCancelExistingOrderMode && (
                <button
                  type="button"
                  onClick={onCancelExistingOrderMode}
                  aria-label={t('close')}
                  className="rounded p-0.5 hover:bg-blue-100 dark:hover:bg-blue-900/50 shrink-0"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}

        <TooltipProvider delayDuration={150}>
          <div
            ref={orderTypeTrackRef}
            role="group"
            aria-label={tPrintKot('type')}
            data-testid="pos-order-type-tabs"
            data-compact={isOrderTypeCompact ? 'true' : 'false'}
            className="flex h-7 w-full min-w-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
          >
            {visibleOrderTypes.map((type) => {
              const Icon = orderTypeIcons[type];
              const label = orderTypeLabels[type];
              const isSelected = cart.orderType === type;
              const isCompactIconOnly = isOrderTypeCompact && !isSelected;
              const isLabelTruncated = !isCompactIconOnly && Boolean(truncatedOrderTypes[type]);
              const showTooltip = isCompactIconOnly || isLabelTruncated;
              return (
                <Tooltip key={type} open={showTooltip ? undefined : false}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      disabled={Boolean(existingOrder && existingOrder.type !== type)}
                      onClick={() => cart.setOrderType(type)}
                      className={`touch-target relative h-6 min-h-6 ${
                        isCompactIconOnly
                          ? 'flex-none min-w-8 px-2.5'
                          : isOrderTypeCompact
                            ? 'flex-1 min-w-0 gap-1.5 px-2'
                            : 'flex-auto min-w-0 gap-0.5 px-0.5'
                      } whitespace-nowrap rounded-md text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed aria-pressed:forced-colors:outline-1 aria-pressed:forced-colors:outline-[Highlight] ${
                        isSelected
                          ? 'bg-card text-brand shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Icon size={ORDER_TYPE_ICON_PX} aria-hidden="true" className="shrink-0" />
                      <span
                        ref={(node) => {
                          orderTypeLabelRefs.current[type] = node;
                        }}
                        className={isCompactIconOnly ? 'sr-only' : 'min-w-0 truncate'}
                      >
                        {label}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    sideOffset={4}
                    aria-hidden="true"
                    hidden={!showTooltip}
                  >
                    {label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </TooltipProvider>

        {!existingOrder && cart.orderType === 'dine_in' && (
          <div
            data-testid="pos-order-details-summary"
            className="flex min-h-7 items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/50 px-2.5"
          >
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users size={13} className="shrink-0" />
              <span className="font-medium text-foreground">{t('pax')}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="inline-flex items-center rounded-full border border-border bg-card p-0.5">
                <button
                  type="button"
                  aria-label={t('decreasePax')}
                  onClick={() => cart.setGuestCount(Math.max(1, cart.guestCount - 1))}
                  className="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
                >
                  <Minus size={12} />
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
                  className="w-8 text-center text-xs font-semibold tabular-nums border-0 outline-none bg-transparent"
                />
                <button
                  type="button"
                  aria-label={t('increasePax')}
                  onClick={() => cart.setGuestCount(Math.min(99, cart.guestCount + 1))}
                  className="touch-target h-7 w-7 min-h-7 min-w-7 rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
                >
                  <Plus size={12} />
                </button>
              </div>
              <button
                type="button"
                data-testid="pos-order-details-edit-btn"
                onClick={() => setDetailsDrawerOpen(true)}
                className="inline-flex items-center gap-0.5 text-xs font-medium text-brand hover:underline"
              >
                <span>{tCommon('edit')}</span>
                <ChevronRight size={12} className="rtl-flip" />
              </button>
            </div>
          </div>
        )}

        {!existingOrder && cart.orderType === 'takeaway' && scheduledOrdersEnabled && (
          <div data-testid="pos-schedule-section">
            <div
              data-testid="pos-order-details-summary"
              role="button"
              tabIndex={0}
              onClick={() => setDetailsDrawerOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setDetailsDrawerOpen(true);
                }
              }}
              className="flex min-h-7 cursor-pointer items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/50 px-2.5 py-0.5 text-xs transition-colors hover:bg-muted"
            >
              <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
                <CalendarClock size={13} className="shrink-0 text-muted-foreground" />
                {scheduleErrorMessage ? (
                  <span
                    role="alert"
                    data-testid="pos-schedule-error"
                    className="truncate font-medium text-red-600 dark:text-red-400"
                  >
                    {scheduleErrorMessage}
                  </span>
                ) : cart.scheduledFor && scheduleValidation?.ok ? (
                  <span className="truncate font-medium text-brand">
                    {t('sendToKitchenAt')} ·{' '}
                    {formatScheduledInstantForDisplay(scheduleValidation.isoUtc, effectiveTimezone)}
                  </span>
                ) : (
                  <span className="truncate text-muted-foreground">
                    <span className="font-medium text-foreground">{t('sendToKitchenAt')}</span> ·{' '}
                    {t('sendImmediately')}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {cart.scheduledFor && (
                  <button
                    type="button"
                    data-testid="pos-schedule-clear-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      cart.setScheduledFor('');
                    }}
                    aria-label={t('sendImmediately')}
                    title={t('sendImmediately')}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <X size={12} />
                  </button>
                )}
                <button
                  type="button"
                  data-testid="pos-order-details-edit-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDetailsDrawerOpen(true);
                  }}
                  className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline"
                >
                  <span>{tCommon('edit')}</span>
                  <ChevronRight size={12} className="rtl-flip" />
                </button>
              </div>
            </div>
          </div>
        )}

        {!existingOrder && cart.orderType === 'delivery' && (
          <div data-testid={scheduledOrdersEnabled ? 'pos-schedule-section' : undefined}>
            <div
              data-testid="pos-order-details-summary"
              role="button"
              tabIndex={0}
              onClick={() => setDetailsDrawerOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setDetailsDrawerOpen(true);
                }
              }}
              className="flex min-h-7 cursor-pointer items-center justify-between gap-1.5 rounded-lg border border-border/60 bg-muted/50 px-2.5 py-0.5 text-xs transition-colors hover:bg-muted"
            >
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                <span className="inline-flex min-w-0 flex-1 items-center gap-1 truncate">
                  <MapPin
                    size={13}
                    className={
                      cart.deliveryAddress.trim()
                        ? 'shrink-0 text-muted-foreground'
                        : 'shrink-0 text-amber-600 dark:text-amber-400'
                    }
                  />
                  {cart.deliveryAddress.trim() ? (
                    <span className="truncate font-medium text-foreground">
                      {cart.deliveryAddress}
                    </span>
                  ) : (
                    <span className="truncate rounded bg-amber-500/15 px-1 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      {t('deliveryAddress')}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-muted-foreground/60">·</span>
                <span className="max-w-16 shrink-0 truncate rounded border border-border/50 bg-background/80 px-1 py-0.5 text-[11px] text-muted-foreground">
                  {expectedPaymentSummaryLabel}
                </span>
                {scheduledOrdersEnabled && (
                  <>
                    <span className="shrink-0 text-muted-foreground/60">·</span>
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px]">
                      <CalendarClock size={12} className="shrink-0 text-muted-foreground" />
                      <span className="sr-only">{t('sendToKitchenAt')}</span>
                      {scheduleErrorMessage ? (
                        <span
                          role="alert"
                          data-testid="pos-schedule-error"
                          className="max-w-20 truncate font-medium text-red-600 dark:text-red-400"
                        >
                          {scheduleErrorMessage}
                        </span>
                      ) : cart.scheduledFor && scheduleValidation?.ok ? (
                        <span className="max-w-20 truncate font-medium text-brand">
                          {formatScheduledInstantForDisplay(
                            scheduleValidation.isoUtc,
                            effectiveTimezone,
                          )}
                        </span>
                      ) : (
                        <span className="max-w-14 truncate text-muted-foreground">
                          {t('sendImmediately')}
                        </span>
                      )}
                    </span>
                  </>
                )}
                {cart.deliveryNote.trim().length > 0 && (
                  <StickyNote
                    size={12}
                    className="shrink-0 text-brand"
                    aria-label={cart.deliveryNote}
                  />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {scheduledOrdersEnabled && cart.scheduledFor && (
                  <button
                    type="button"
                    data-testid="pos-schedule-clear-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      cart.setScheduledFor('');
                    }}
                    aria-label={t('sendImmediately')}
                    title={t('sendImmediately')}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <X size={12} />
                  </button>
                )}
                <button
                  type="button"
                  data-testid="pos-order-details-edit-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDetailsDrawerOpen(true);
                  }}
                  className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline"
                >
                  <span>{tCommon('edit')}</span>
                  <ChevronRight size={12} className="rtl-flip" />
                </button>
              </div>
            </div>
          </div>
        )}

        {!existingOrder && cart.orderType === 'online' && (
          <div
            data-testid="pos-order-details-summary"
            role="button"
            tabIndex={0}
            onClick={() => setDetailsDrawerOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setDetailsDrawerOpen(true);
              }
            }}
            className="flex min-h-7 cursor-pointer items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/50 px-2.5 py-0.5 text-xs transition-colors hover:bg-muted"
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
              <Globe size={13} className="shrink-0 text-muted-foreground" />
              {cart.onlinePlatform.trim() ? (
                <span className="truncate font-medium text-foreground">
                  {cart.onlinePlatform}
                  {cart.externalOrderId.trim() ? ` · #${cart.externalOrderId.trim()}` : ''}
                </span>
              ) : (
                <span className="truncate text-muted-foreground">
                  {t('onlinePlatformPlaceholder')}
                  {cart.externalOrderId.trim() ? ` · #${cart.externalOrderId.trim()}` : ''}
                </span>
              )}
            </div>
            <button
              type="button"
              data-testid="pos-order-details-edit-btn"
              onClick={(e) => {
                e.stopPropagation();
                setDetailsDrawerOpen(true);
              }}
              className="inline-flex shrink-0 items-center gap-0.5 font-medium text-brand hover:underline"
            >
              <span>{tCommon('edit')}</span>
              <ChevronRight size={12} className="rtl-flip" />
            </button>
          </div>
        )}
      </div>

      {/* Cart Items */}
      {/* min-h-0 overrides the content-based automatic minimum size, so a long
          cart scrolls its rows instead of pushing the totals and checkout out. */}
      <div
        data-testid="cart-items-scroll"
        className={
          isDrawer
            ? 'overflow-y-auto px-2.5 py-1.5 max-h-[40vh]'
            : 'pos-cart-items flex-1 min-h-0 overflow-y-auto px-2.5 py-1.5'
        }
      >
        {/* Previously ordered items (add-items mode) */}
        {existingOrder &&
          existingOrder.items &&
          existingOrder.items.filter((i: OrderItem) => !isTerminalItemStatus(i.status)).length >
            0 && (
            <div className="mb-2.5 pb-2.5 border-b border-dashed border-border">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                {t('alreadyOrdered')}
              </p>
              <div className="space-y-1">
                {existingOrder.items
                  .filter((i: OrderItem) => !isTerminalItemStatus(i.status))
                  .map((item: OrderItem) => (
                    <div key={item.id} className="flex justify-between items-center">
                      <span className="text-xs text-muted-foreground">
                        {item.quantity}× {item.product_name}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {fmt(Number(item.total))}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

        {cart.items.length === 0 ? (
          <div
            className={`flex flex-col items-center justify-center text-muted-foreground ${existingOrder ? 'py-4' : isDrawer ? 'py-8' : 'h-full'}`}
          >
            <ShoppingCart size={existingOrder ? 24 : 40} />
            <p className="mt-2 text-sm">{existingOrder ? t('addNewItemsAbove') : t('cartEmpty')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {cart.items.map((item) => {
              const onlineSelected =
                cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0;
              const unitPrice = cartLineUnitPrice(item, onlineSelected);
              const addonUnitTotal = item.addons.reduce(
                (sum, a) => sum + Number(a.price) * (a.quantity || 1),
                0,
              );
              const effectiveUnitPrice = unitPrice + addonUnitTotal;
              const lineTotal = effectiveUnitPrice * item.quantity;
              const hasSubtext = item.addons.length > 0 || Boolean(item.special_instructions);
              const pizzaLine = Boolean(pizza?.isPizzaLine(item));
              return (
                <div key={item.id} data-testid="cart-item" className="py-1.5 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      data-testid="cart-item-remove-btn"
                      onClick={() => cart.removeItem(item.id)}
                      className="touch-target h-7 w-7 min-h-7 min-w-7 shrink-0 rounded-md text-red-500 dark:text-red-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-300 active:bg-red-100 dark:active:bg-red-950/60"
                      aria-label={t('remove')}
                      title={t('remove')}
                    >
                      <Trash2 size={13} />
                    </button>
                    <p className="min-w-0 flex-1 break-words text-sm font-medium leading-snug text-foreground">
                      {item.variant
                        ? `${item.product.name} (${item.variant.name})`
                        : item.product.name}
                    </p>
                    <div className="flex items-baseline gap-1.5 shrink-0">
                      {item.quantity > 1 && (
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {fmt(effectiveUnitPrice)}
                        </span>
                      )}
                      <span className="text-sm font-semibold tabular-nums text-foreground">
                        {fmt(lineTotal)}
                      </span>
                    </div>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {pizza && <PizzaLineDetails item={item} />}
                      {item.price_override && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 leading-snug break-words">
                          {tOrders('priceOverriddenMenu', {
                            price: fmt(cartVariantUnitPrice(item, onlineSelected)),
                          })}
                        </p>
                      )}
                      {hasSubtext && (
                        <p className="text-xs text-muted-foreground leading-snug break-words">
                          {item.addons.map((a, idx) => (
                            <span key={a.id}>
                              {idx > 0 && ' · '}
                              {`+ ${a.name}${(a.quantity || 1) > 1 ? ` ×${a.quantity}` : ''}${
                                Number(a.price) > 0
                                  ? ` (${fmt(Number(a.price) * (a.quantity || 1))})`
                                  : ''
                              }`}
                            </span>
                          ))}
                          {item.special_instructions && (
                            <>
                              {item.addons.length > 0 && ' · '}
                              <span className="italic">{item.special_instructions}</span>
                            </>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="ms-auto flex items-center gap-1.5 shrink-0">
                      {canOverridePrice && (
                        <button
                          type="button"
                          onClick={() => setPriceOverrideItemId(item.id)}
                          className="touch-target h-7 w-7 min-h-7 min-w-7 shrink-0 rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
                          aria-label={tOrders('overridePrice')}
                          title={tOrders('overridePrice')}
                        >
                          <Tag size={13} />
                        </button>
                      )}
                      {onEditItem && !pizzaLine && (
                        <button
                          type="button"
                          onClick={() => onEditItem(item)}
                          className="touch-target h-7 w-7 min-h-7 min-w-7 shrink-0 rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
                          aria-label={tCommon('edit')}
                          title={tCommon('edit')}
                        >
                          <SquarePen size={13} />
                        </button>
                      )}
                      {!pizzaLine && (
                        <div className="inline-flex items-center rounded-full border border-border bg-muted/50 p-0.5">
                          <ItemQuantityControl item={item} updateQuantity={cart.updateQuantity} />
                        </div>
                      )}
                    </div>
                  </div>
                  {pizza && pizzaLine && (
                    <PizzaLineActions
                      item={item}
                      onEdit={pizza.edit}
                      onCustomizeOne={pizza.customizeOne}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Cart Footer */}
      <div
        data-testid="cart-footer"
        className="px-2.5 py-1 border-t border-border dark:border-border bg-card space-y-1"
      >
        {/* Order Notes (shown only when non-empty or toggled open) */}
        {(cart.orderNotes.length > 0 || orderNotesExpanded) && (
          <div className="relative flex items-center">
            <StickyNote
              size={13}
              className="pointer-events-none absolute start-2 text-muted-foreground"
            />
            <input
              data-testid="pos-order-notes-input"
              type="text"
              value={cart.orderNotes}
              onChange={(e) => cart.setOrderNotes(e.target.value.slice(0, 200))}
              onBlur={() => {
                if (!cart.orderNotes.trim()) {
                  setOrderNotesExpanded(false);
                }
              }}
              placeholder={t('orderNotesPlaceholder')}
              maxLength={200}
              className="w-full h-7 ps-7 pe-7 text-xs border border-border bg-muted/40 rounded-md focus:outline-none focus:ring-1 focus:ring-brand/30 focus:border-brand"
            />
            <button
              type="button"
              onClick={() => {
                cart.setOrderNotes('');
                setOrderNotesExpanded(false);
              }}
              aria-label={tCommon('clear')}
              className="absolute end-1.5 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>
              {t('items')}{' '}
              <span className="ms-0.5 font-semibold text-foreground tabular-nums">
                {cart.itemCount()}
              </span>
            </span>
            {cart.orderNotes.length === 0 && !orderNotesExpanded && (
              <button
                type="button"
                data-testid="pos-order-note-toggle-btn"
                onClick={() => setOrderNotesExpanded(true)}
                className="inline-flex h-5 items-center gap-1 rounded border border-transparent px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground"
              >
                <span>+ {orderNotesShortLabel}</span>
              </button>
            )}
          </span>
          <span className="ms-auto flex flex-wrap items-baseline justify-end gap-1.5 min-w-0">
            <span className="text-xs font-semibold text-foreground">{t('subtotal')}</span>
            <span className="text-sm font-bold text-brand tabular-nums">
              {fmt(cart.subtotal())}
            </span>
          </span>
        </div>
        {(appliedCharges.length > 0 || addableCharges.length > 0) && (
          <div className="space-y-1 text-[11px] leading-tight" data-testid="cart-charges">
            {appliedCharges.map((charge) => {
              const definition = applicableCharges.find((c) => c.id === charge.id);
              const isOptional = definition?.is_optional ?? false;
              return (
                <div
                  key={charge.id}
                  className="flex items-center justify-between gap-2 text-[11px] leading-tight"
                >
                  <span
                    className={
                      charge.waived ? 'text-muted-foreground line-through' : 'text-muted-foreground'
                    }
                  >
                    {charge.name}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className={
                        charge.waived ? 'text-muted-foreground line-through' : 'font-medium'
                      }
                    >
                      {fmt(charge.amount)}
                    </span>
                    {isOptional && (
                      <button
                        type="button"
                        onClick={() => cart.toggleWaiveCharge(charge.id)}
                        aria-pressed={charge.waived}
                        className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground"
                      >
                        {charge.waived ? t('applyCharge') : t('waiveCharge')}
                      </button>
                    )}
                    {!definition?.is_default_active && (
                      <button
                        type="button"
                        onClick={() => cart.toggleOptedInCharge(charge.id)}
                        aria-pressed={!cart.optedInChargeIds.has(charge.id)}
                        className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground"
                      >
                        {cart.optedInChargeIds.has(charge.id) ? t('removeCharge') : t('addCharge')}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
            {addableCharges.map((charge) => (
              <div
                key={charge.id}
                className="flex items-center justify-between gap-2 text-[11px] leading-tight"
              >
                <span className="text-muted-foreground">{charge.name}</span>
                <button
                  type="button"
                  onClick={() => cart.toggleOptedInCharge(charge.id)}
                  className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground"
                >
                  {t('addCharge')}
                </button>
              </div>
            ))}
            {appliedCharges.length > 0 && (
              <div className="flex justify-between text-[11px] leading-tight font-medium">
                <span>{t('chargesTotal')}</span>
                <span>{fmt(chargeTotal)}</span>
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {canHold && (
            <Button variant="outline" onClick={handleHold} className="shrink-0 px-3">
              <Pause size={14} className="me-1 shrink-0" />
              <span className="truncate">{t('holdButton')}</span>
              <span
                aria-hidden="true"
                className="hidden sm:inline-flex shrink-0 ms-1 px-1 py-0.2 rounded border border-border text-[10px] font-mono text-muted-foreground"
              >
                F8
              </span>
            </Button>
          )}
          {existingOrder ? (
            <Button
              onClick={onPlaceOrder}
              disabled={submitting || cart.items.length === 0 || Boolean(scheduleErrorMessage)}
              className={`flex-1 min-w-0 px-3 ${CHECKOUT_PRIMARY_CTA_CLASS}`}
              data-testid="pos-append-existing-order-btn"
            >
              <span className="truncate">{submitting ? t('placing') : t('placeOrderButton')}</span>
              {!submitting && (
                <span
                  aria-hidden="true"
                  className="hidden sm:inline-flex shrink-0 ms-1.5 px-1.5 py-0.5 rounded bg-white/20 text-[10px] font-mono font-medium"
                >
                  Space
                </span>
              )}
            </Button>
          ) : multiCounterEnabled && counterRole === 'payment' ? (
            cart.items.length === 0 ? (
              <Button
                type="button"
                onClick={onOpenPaymentQueue}
                className={`flex-1 min-w-0 px-3 ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                data-testid="pos-open-payment-queue-btn"
              >
                <CreditCard className="me-2 h-4 w-4 shrink-0" />
                <span className="truncate">{t('paymentQueue')}</span>
              </Button>
            ) : (
              <>
                {onOpenPaymentQueue && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onOpenPaymentQueue}
                    className="flex-1 min-w-0 px-3"
                    data-testid="pos-open-payment-queue-btn"
                  >
                    <CreditCard className="me-2 h-4 w-4 shrink-0" />
                    <span className="truncate">{t('paymentQueue')}</span>
                  </Button>
                )}
                <Button
                  onClick={onPlaceOrder}
                  disabled={submitting || Boolean(scheduleErrorMessage)}
                  className={`flex-1 min-w-0 px-3 ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                >
                  <span className="truncate">
                    {submitting ? t('placing') : t('placeOrderButton')}
                  </span>
                  {!submitting && (
                    <span
                      aria-hidden="true"
                      className="hidden sm:inline-flex shrink-0 ms-1.5 px-1.5 py-0.5 rounded bg-white/20 text-[10px] font-mono font-medium"
                    >
                      Space
                    </span>
                  )}
                </Button>
              </>
            )
          ) : multiCounterEnabled &&
            onSendToPayment &&
            counterRole === 'ordering' &&
            (cart.orderType === 'takeaway' || cart.orderType === 'dine_in') ? (
            <Button
              onClick={onSendToPayment}
              disabled={submitting || cart.items.length === 0 || Boolean(scheduleErrorMessage)}
              className={`flex-1 min-w-0 px-3 ${CHECKOUT_PRIMARY_CTA_CLASS}`}
              data-testid="pos-send-to-payment-btn"
            >
              <span className="truncate">{submitting ? t('placing') : t('sendToPayment')}</span>
              {!submitting && (
                <span
                  aria-hidden="true"
                  className="hidden sm:inline-flex shrink-0 ms-1.5 px-1.5 py-0.5 rounded bg-white/20 text-[10px] font-mono font-medium"
                >
                  Space
                </span>
              )}
            </Button>
          ) : multiCounterEnabled &&
            onSendToPayment &&
            counterRole === 'combined' &&
            (cart.orderType === 'takeaway' || cart.orderType === 'dine_in') ? (
            <>
              <Button
                variant="outline"
                onClick={onSendToPayment}
                disabled={submitting || cart.items.length === 0 || Boolean(scheduleErrorMessage)}
                className="flex-1 min-w-0 px-3"
                data-testid="pos-send-to-payment-btn"
              >
                <span className="truncate">{t('sendToPayment')}</span>
              </Button>
              <Button
                onClick={onPlaceOrder}
                disabled={submitting || cart.items.length === 0 || Boolean(scheduleErrorMessage)}
                className={`flex-1 min-w-0 px-3 ${CHECKOUT_PRIMARY_CTA_CLASS}`}
              >
                <span className="truncate">
                  {submitting ? t('placing') : t('placeOrderButton')}
                </span>
                {!submitting && (
                  <span
                    aria-hidden="true"
                    className="hidden sm:inline-flex shrink-0 ms-1.5 px-1.5 py-0.5 rounded bg-white/20 text-[10px] font-mono font-medium"
                  >
                    Space
                  </span>
                )}
              </Button>
            </>
          ) : (
            <Button
              onClick={onPlaceOrder}
              disabled={submitting || cart.items.length === 0 || Boolean(scheduleErrorMessage)}
              className={`flex-1 min-w-0 px-3 ${CHECKOUT_PRIMARY_CTA_CLASS}`}
            >
              <span className="truncate">{submitting ? t('placing') : t('placeOrderButton')}</span>
              {!submitting && (
                <span
                  aria-hidden="true"
                  className="hidden sm:inline-flex shrink-0 ms-1.5 px-1.5 py-0.5 rounded bg-white/20 text-[10px] font-mono font-medium"
                >
                  Space
                </span>
              )}
            </Button>
          )}
        </div>
      </div>
      {priceOverrideTarget && (
        <CartPriceOverrideModal
          item={priceOverrideTarget}
          onlinePlatformSelected={
            cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0
          }
          onApply={(override) => cart.setItemPriceOverride(priceOverrideTarget.id, override)}
          onClose={() => setPriceOverrideItemId(null)}
        />
      )}
      <OrderDetailsDrawer
        open={effectiveDetailsDrawerOpen}
        onOpenChange={setDetailsDrawerOpen}
        effectiveTimezone={effectiveTimezone}
        scheduleErrorMessage={scheduleErrorMessage}
        customPaymentMethods={customPaymentMethods}
        scheduledOrdersEnabled={scheduledOrdersEnabled}
      />
    </div>
  );
}
