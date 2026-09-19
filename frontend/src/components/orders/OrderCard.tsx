'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Utensils,
  ShoppingBag,
  Truck,
  Globe,
  Clock,
  Printer,
  MoreHorizontal,
  User,
  Plus,
  ChevronDown,
  ChevronRight,
  CreditCard,
  RotateCcw,
  Send,
  AlertCircle,
  MapPin,
  Info,
  FileText,
  Ban,
  Trash2,
  Lock,
  XCircle,
  Download,
  Loader2,
} from 'lucide-react';
import type { Order, OrderItem, Bill, Customer } from '@/lib/types';
import { Ltr } from '@/components/layout/Ltr';
import { useTranslations, type AppConfig } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { parseDbTimestamp } from '@/lib/utils';

type OrdersKey = keyof AppConfig['Messages']['orders'];
type WhatsAppStatusKey = keyof AppConfig['Messages']['whatsapp']['status'];

const orderStatusBadge: Record<Order['status'], { bg: string; text: string; labelKey: OrdersKey }> = {
  pending: { bg: 'bg-yellow-100 dark:bg-yellow-950/40', text: 'text-yellow-700 dark:text-yellow-300', labelKey: 'pending' },
  preparing: { bg: 'bg-blue-100 dark:bg-blue-950/40', text: 'text-blue-700 dark:text-blue-300', labelKey: 'preparing' },
  ready: { bg: 'bg-green-100 dark:bg-green-950/40', text: 'text-green-700 dark:text-green-300', labelKey: 'ready' },
  served: { bg: 'bg-purple-100 dark:bg-purple-950/40', text: 'text-purple-700 dark:text-purple-300', labelKey: 'served' },
  completed: { bg: 'bg-muted', text: 'text-muted-foreground', labelKey: 'completed' },
  cancelled: { bg: 'bg-red-100 dark:bg-red-950/40', text: 'text-red-700 dark:text-red-300', labelKey: 'cancelled' },
};

const paymentStatusBadge: Record<'paid' | 'partial' | 'unpaid', { bg: string; text: string; labelKey: OrdersKey }> = {
  paid: { bg: 'bg-green-100 dark:bg-green-950/40', text: 'text-green-700 dark:text-green-300', labelKey: 'paid' },
  partial: { bg: 'bg-amber-100 dark:bg-amber-950/40', text: 'text-amber-700 dark:text-amber-300', labelKey: 'partiallyPaid' },
  unpaid: { bg: 'bg-red-100 dark:bg-red-950/40', text: 'text-red-700 dark:text-red-300', labelKey: 'unpaidBadge' },
};

const whatsappReceiptStatusBadge: Record<'sent' | 'partial' | 'pending' | 'failed' | 'notSent', { bg: string; text: string; labelKey: WhatsAppStatusKey }> = {
  sent: { bg: 'bg-green-100 dark:bg-green-950/40', text: 'text-green-700 dark:text-green-300', labelKey: 'sent' },
  partial: { bg: 'bg-amber-100 dark:bg-amber-950/40', text: 'text-amber-700 dark:text-amber-300', labelKey: 'partial' },
  pending: { bg: 'bg-amber-100 dark:bg-amber-950/40', text: 'text-amber-700 dark:text-amber-300', labelKey: 'pending' },
  failed: { bg: 'bg-red-100 dark:bg-red-950/40', text: 'text-red-700 dark:text-red-300', labelKey: 'failed' },
  notSent: { bg: 'bg-muted', text: 'text-muted-foreground', labelKey: 'notSent' },
};

const itemStatusDot: Record<OrderItem['status'], { dot: string; labelKey: OrdersKey }> = {
  pending: { dot: 'bg-yellow-400', labelKey: 'itemStatusWaiting' },
  preparing: { dot: 'bg-blue-500', labelKey: 'itemStatusPreparing' },
  ready: { dot: 'bg-green-500', labelKey: 'itemStatusReady' },
  served: { dot: 'bg-purple-500', labelKey: 'itemStatusServed' },
  cancelled: { dot: 'bg-red-400', labelKey: 'itemStatusCancelled' },
  voided: { dot: 'bg-red-500', labelKey: 'itemStatusVoided' },
  void_adjustment: { dot: 'bg-red-300', labelKey: 'itemStatusVoidAdjustment' },
};

const ORDER_TYPE_KEYS = {
  dine_in: 'dineIn',
  takeaway: 'takeaway',
  delivery: 'delivery',
  online: 'online',
} as const satisfies Record<Order['type'], OrdersKey>;

interface OrderCardProps {
  order: Order;
  now: number;
  isOwnerOrManager: boolean;
  isWhatsAppReady: boolean;
  printHistory: Record<number, { id: number; print_type: string; user_name: string; printed_at: string }[]>;
  generatingBillId: number | null;
  printingBillId: number | null;
  sendingWaOrderId: number | null;
  cancellingOrderId: number | null;
  convertingOrderId: number | null;
  isLinkingCustomer?: boolean;
  linkCustomerSearch?: string;
  linkCustomerResults?: Customer[];
  linkingCustomer?: boolean;
  onCheckout: (orderId: number) => void;
  onAddItems: (order: Order) => void;
  onRefund: (order: Order, bills: Bill[]) => void;
  onConvertToTakeaway: (order: Order) => void;
  onCancelOrder: (order: Order) => void;
  onPrint: (billId: number) => void;
  onSendWhatsApp: (order: Order) => void;
  onLinkCustomer: (orderId: number) => void;
  onCancelLinkCustomer?: () => void;
  onSearchCustomer?: (query: string) => void;
  onSelectCustomer?: (orderId: number, customerId: string) => void;
  onCreateCustomer?: (orderId: number, search: string) => void;
  onCreateNewOrderForCustomer: (order: Order) => void;
  onDownloadPrintPreview?: (billId: number) => void;
  onDeleteItem?: (orderId: number, itemId: number) => void;
  onVoidItem?: (orderId: number, itemId: number, productName: string) => void;
  onRestoreItem?: (orderId: number, itemId: number) => void;
}

export function OrderCard({
  order,
  now,
  isOwnerOrManager,
  isWhatsAppReady,
  printHistory,
  generatingBillId,
  printingBillId,
  sendingWaOrderId,
  cancellingOrderId,
  convertingOrderId,
  isLinkingCustomer,
  linkCustomerSearch,
  linkCustomerResults,
  linkingCustomer,
  onCheckout,
  onAddItems,
  onRefund,
  onConvertToTakeaway,
  onCancelOrder,
  onPrint,
  onSendWhatsApp,
  onLinkCustomer,
  onCancelLinkCustomer,
  onSearchCustomer,
  onSelectCustomer,
  onCreateCustomer,
  onCreateNewOrderForCustomer,
  onDownloadPrintPreview,
  onDeleteItem,
  onVoidItem,
  onRestoreItem,
}: OrderCardProps) {
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const tReceipt = useTranslations('receipt');
  const tWhatsappStatus = useTranslations('whatsapp.status');
  const fmt = useFormatCurrency();
  const { formatTime, formatDateTime } = useFormatDate();

  const [showOrderNotes, setShowOrderNotes] = useState(false);
  const [showAllItems, setShowAllItems] = useState(false);
  const [showVoidedItems, setShowVoidedItems] = useState(false);
  const [showPrintActivity, setShowPrintActivity] = useState(false);

  const activeItems = (order.items || []).filter(
    (i) => !['cancelled', 'voided', 'void_adjustment'].includes(i.status)
  );
  const inactiveItems = (order.items || []).filter(
    (i) => ['cancelled', 'voided'].includes(i.status)
  );

  const bill = order.bill;
  const isPaid = bill?.payment_status === 'paid';
  const payStatus: 'paid' | 'partial' | 'unpaid' | null = (() => {
    if (order.status === 'cancelled') return null;
    if (bill?.payment_status === 'paid') return 'paid';
    if (bill?.payment_status === 'partial') return 'partial';
    return 'unpaid';
  })();

  const payBadge = payStatus ? paymentStatusBadge[payStatus] : null;

  const hasPaidBill = order.bills?.some((candidate) => candidate.payment_status === 'paid') ?? isPaid;
  const receiptStatusBadge =
    isWhatsAppReady && hasPaidBill && order.whatsapp_receipt_status
      ? whatsappReceiptStatusBadge[order.whatsapp_receipt_status] || null
      : null;

  const receiptStatusLabel = (() => {
    if (!receiptStatusBadge) return '';
    if (receiptStatusBadge.labelKey === 'sent') return tOrders('receiptSent');
    if (receiptStatusBadge.labelKey === 'failed') return tOrders('sendFailed');
    return tWhatsappStatus(receiptStatusBadge.labelKey);
  })();

  const subtotal = bill ? Number(bill.subtotal) : Number(order.subtotal);
  const discount = bill ? Number(bill.discount_amount) : Number(order.discount_amount);
  const tax = bill ? Number(bill.tax_amount) : Number(order.tax_amount);
  const total = bill ? Number(bill.total) : Number(order.total);
  const deliveryCharge = bill ? Number(bill.delivery_charge || 0) : Number(order.delivery_charge || 0);
  const serviceCharge = bill ? Number(bill.service_charge || 0) : Number(order.service_charge || 0);
  const packagingCharge = bill ? Number(bill.packaging_charge || 0) : Number(order.packaging_charge || 0);

  const orderBills = (() => {
    if (order.bills && order.bills.length > 0) return order.bills;
    if (order.bill) return [order.bill];
    return [];
  })();
  const paidBills = orderBills.filter((b) => Number(b.paid_amount) > 0 && b.payment_status !== 'refunded');
  const hasEligibleRefund = paidBills.length > 0;

  const checkoutButtonLabel = (() => {
    if (generatingBillId === order.id) return tOrders('generating');
    if (payStatus === 'partial') return tOrders('takePayment');
    return tOrders('checkout');
  })();

  const getTimeSince = (dateStr: string) => {
    const minutes = Math.floor((now - parseDbTimestamp(dateStr).getTime()) / 60000);
    if (minutes < 1) return tCommon('justNow');
    if (minutes < 60) return tCommon('timeMinutesAgo', { m: minutes });
    return tCommon('timeHoursMinutesAgo', { h: Math.floor(minutes / 60), m: minutes % 60 });
  };

  const statusBadgeInfo = orderStatusBadge[order.status];
  const orderPrints = bill?.id ? printHistory[bill.id] || [] : [];
  const printCount = orderPrints.length;

  const displayedItems = showAllItems ? activeItems : activeItems.slice(0, 3);
  const hiddenItemCount = Math.max(0, activeItems.length - 3);

  const orderTypeIcon = (() => {
    switch (order.type) {
      case 'dine_in':
        return <Utensils size={13} className="shrink-0 text-muted-foreground" />;
      case 'takeaway':
        return <ShoppingBag size={13} className="shrink-0 text-muted-foreground" />;
      case 'delivery':
        return <Truck size={13} className="shrink-0 text-muted-foreground" />;
      case 'online':
        return <Globe size={13} className="shrink-0 text-muted-foreground" />;
      default:
        return <ShoppingBag size={13} className="shrink-0 text-muted-foreground" />;
    }
  })();

  return (
    <div
      className={`bg-card rounded-xl border flex flex-col overflow-hidden transition-shadow hover:shadow-sm ${
        order.status === 'cancelled' ? 'border-red-200 dark:border-red-900/40 opacity-80' : 'border-border'
      }`}
    >
      {/* ── TOP HEADER ────────────────────────────────────────────────────────── */}
      <div className="px-4 py-3 bg-muted/40 border-b border-border space-y-2">
        {/* Header Row 1: Order Number, Status Badges, Quick Actions */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="font-bold text-base text-foreground tracking-tight">
              #<Ltr>{order.order_number}</Ltr>
            </span>
            {statusBadgeInfo && (
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${statusBadgeInfo.bg} ${statusBadgeInfo.text}`}>
                {tOrders(statusBadgeInfo.labelKey)}
              </span>
            )}
            {payBadge && (
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${payBadge.bg} ${payBadge.text}`}>
                {tOrders(payBadge.labelKey)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {bill && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => onPrint(bill.id)}
                disabled={printingBillId === bill.id}
                className="size-9 rounded-lg border-border/70 text-muted-foreground hover:text-foreground touch-manipulation active:scale-95"
                title={printCount > 0 ? tCommon('reprint') : tCommon('print')}
              >
                {printingBillId === bill.id ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Printer size={17} />
                )}
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9 rounded-lg border-border/70 text-muted-foreground hover:text-foreground touch-manipulation active:scale-95"
                >
                  <MoreHorizontal size={17} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {order.type === 'dine_in' && !['completed', 'cancelled'].includes(order.status) && (
                  <DropdownMenuItem
                    onClick={() => onConvertToTakeaway(order)}
                    disabled={convertingOrderId === order.id}
                  >
                    <ShoppingBag size={14} className="me-2" />
                    {convertingOrderId === order.id ? tOrders('converting') : tOrders('convertToTakeaway')}
                  </DropdownMenuItem>
                )}

                {!['completed', 'cancelled'].includes(order.status) && (
                  <DropdownMenuItem onClick={() => onLinkCustomer(order.id)}>
                    <User size={14} className="me-2" />
                    {order.customer ? tOrders('changeCustomer') : tOrders('linkCustomer')}
                  </DropdownMenuItem>
                )}

                {bill && onDownloadPrintPreview && (
                  <DropdownMenuItem onClick={() => onDownloadPrintPreview(bill.id)}>
                    <Download size={14} className="me-2" />
                    {tOrders('downloadPrintPreview')}
                  </DropdownMenuItem>
                )}

                {!['completed', 'cancelled'].includes(order.status) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => onCancelOrder(order)}
                      disabled={cancellingOrderId === order.id}
                      className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/40"
                    >
                      {order.status === 'pending' ? (
                        <XCircle size={14} className="me-2" />
                      ) : (
                        <Lock size={14} className="me-2" />
                      )}
                      {cancellingOrderId === order.id ? tOrders('cancelling') : tCommon('cancel')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Header Row 2: Type, Table, Elapsed Time, WhatsApp Status */}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 font-medium capitalize text-foreground">
              {orderTypeIcon}
              {tOrders(ORDER_TYPE_KEYS[order.type])}
            </span>

            {order.table && (
              <span className="font-medium text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40 px-2 py-0.5 rounded-md">
                {order.table.name}
              </span>
            )}

            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock size={12} />
              {getTimeSince(order.created_at)}
            </span>
          </div>

          {receiptStatusBadge && (
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${receiptStatusBadge.bg} ${receiptStatusBadge.text}`}
            >
              {receiptStatusBadge.labelKey === 'sent' && <Send size={11} />}
              {receiptStatusBadge.labelKey === 'failed' && <AlertCircle size={11} />}
              {receiptStatusLabel}
            </span>
          )}
        </div>
      </div>

      {/* ── CANCELLATION BANNER ──────────────────────────────────────────────── */}
      {order.status === 'cancelled' && (
        <div className="px-4 py-2 bg-red-50/80 dark:bg-red-950/30 border-b border-red-100 dark:border-red-900/40 flex items-center gap-2 text-xs text-red-700 dark:text-red-300">
          <Ban size={13} className="shrink-0 text-red-500" />
          <span className="truncate">
            {order.cancellation_reason
              ? tOrders('orderCancelledBanner', {
                  time: formatTime(order.cancelled_at || order.created_at),
                  reason: order.cancellation_reason,
                })
              : tOrders('orderCancelledBannerNoReason', {
                  time: formatTime(order.cancelled_at || order.created_at),
                })}
          </span>
        </div>
      )}

      {/* ── CUSTOMER STRIP ───────────────────────────────────────────────────── */}
      {isLinkingCustomer ? (
        <div className="px-4 py-2.5 bg-blue-50/80 dark:bg-blue-950/40 border-b border-blue-100 dark:border-blue-900/40 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={linkCustomerSearch || ''}
              onChange={(e) => onSearchCustomer?.(e.target.value)}
              placeholder={tOrders('searchCustomer')}
              className="flex-1 px-3 py-1.5 text-xs sm:text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              autoFocus
            />
            <button
              type="button"
              onClick={onCancelLinkCustomer}
              className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
            >
              <XCircle size={18} />
            </button>
          </div>

          {linkCustomerResults && linkCustomerResults.length > 0 && (
            <div className="max-h-40 overflow-y-auto space-y-1">
              {linkCustomerResults.map((customer) => (
                <button
                  key={customer.id}
                  type="button"
                  onClick={() => onSelectCustomer?.(order.id, String(customer.id))}
                  disabled={linkingCustomer}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 bg-card hover:bg-muted rounded-md border border-border text-xs text-start disabled:opacity-50 transition-colors"
                >
                  <div>
                    <span className="font-medium text-foreground">{customer.name}</span>
                    {customer.phone && (
                      <span className="text-muted-foreground ms-2"><Ltr>{customer.phone}</Ltr></span>
                    )}
                  </div>
                  {linkingCustomer && <span className="text-muted-foreground text-[10px]">{tOrders('linking')}</span>}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => onCreateCustomer?.(order.id, linkCustomerSearch || '')}
            disabled={linkingCustomer}
            className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-blue-600 dark:text-blue-400 bg-card hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded-md border border-dashed border-blue-300 dark:border-blue-700 font-medium text-start disabled:opacity-50 transition-colors"
          >
            <Plus size={14} />
            {linkCustomerSearch?.trim()
              ? `${tPos('addCustomer')} "${linkCustomerSearch.trim()}"`
              : tPos('addCustomer')}
          </button>
        </div>
      ) : (
        <div className="px-4 py-2 bg-blue-50/50 dark:bg-blue-950/20 border-b border-blue-100/50 dark:border-blue-900/20 flex items-center justify-between min-h-[44px]">
          <div
            role={!['completed', 'cancelled'].includes(order.status) ? 'button' : undefined}
            tabIndex={!['completed', 'cancelled'].includes(order.status) ? 0 : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                if (!['completed', 'cancelled'].includes(order.status)) {
                  onLinkCustomer(order.id);
                }
              }
            }}
            onClick={() => {
              if (!['completed', 'cancelled'].includes(order.status)) {
                onLinkCustomer(order.id);
              }
            }}
            className={`flex items-center gap-2 min-w-0 flex-1 py-1 ${
              !['completed', 'cancelled'].includes(order.status) ? 'cursor-pointer hover:opacity-80' : ''
            }`}
            title={order.customer ? tOrders('changeCustomer') : tOrders('linkCustomer')}
          >
            <User size={14} className="text-blue-600 dark:text-blue-400 shrink-0" />
            {order.customer ? (
              <>
                <span className="text-xs font-semibold text-blue-900 dark:text-blue-200 truncate">
                  {order.customer.name}
                </span>
                {order.customer.phone && (
                  <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">
                    <Ltr>{order.customer.phone}</Ltr>
                  </span>
                )}
                {order.type === 'delivery' && order.customer.address && (
                  <span className="inline-flex items-center gap-1 text-xs text-blue-700 dark:text-blue-300 truncate ms-1">
                    <MapPin size={11} className="shrink-0" />
                    <span className="truncate">{order.customer.address}</span>
                  </span>
                )}
              </>
            ) : (
              <span className="text-xs font-medium text-muted-foreground">
                {tOrders('walkInCustomer')}
              </span>
            )}
          </div>

          {order.customer && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCreateNewOrderForCustomer(order);
              }}
              className="flex items-center gap-1 text-xs font-semibold text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-950/60 hover:bg-blue-200 dark:hover:bg-blue-900/60 active:scale-95 px-3 py-1.5 min-h-[36px] rounded-lg transition-colors shrink-0 ms-2 touch-manipulation"
              title={tOrders('startNewOrderForCustomer')}
            >
              <Plus size={13} />
              <span>{tOrders('newOrder')}</span>
            </button>
          )}

          {!order.customer && !['completed', 'cancelled'].includes(order.status) && (
            <button
              type="button"
              onClick={() => onLinkCustomer(order.id)}
              className="flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 active:scale-95 px-3 py-1.5 min-h-[36px] rounded-lg transition-colors shrink-0 ms-2 touch-manipulation"
              title={tOrders('linkCustomer')}
            >
              <Plus size={13} />
              <span>{tOrders('linkCustomer')}</span>
            </button>
          )}
        </div>
      )}

      {/* ── COLLAPSIBLE ORDER NOTES BANNER ───────────────────────────────────── */}
      {order.special_instructions && (
        <div className="border-b border-amber-100 dark:border-amber-900/30">
          <button
            type="button"
            onClick={() => setShowOrderNotes((prev) => !prev)}
            className="w-full px-4 py-1.5 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-between text-xs text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-950/50 transition-colors text-start touch-manipulation active:scale-95"
          >
            <span className="inline-flex items-center gap-1.5 font-medium">
              <FileText size={13} className="text-amber-600 shrink-0" />
              {tOrders('orderNoteTap', { count: 1 })}
            </span>
            <ChevronDown
              size={13}
              className={`text-amber-600 transition-transform duration-200 ${
                showOrderNotes ? 'rotate-180' : ''
              }`}
            />
          </button>
          {showOrderNotes && (
            <div className="px-4 py-2 bg-amber-50/50 dark:bg-amber-950/20 text-xs text-amber-900 dark:text-amber-200 border-t border-amber-100/60 dark:border-amber-900/30 break-words">
              {order.special_instructions}
            </div>
          )}
        </div>
      )}

      {/* ── MIDDLE SECTION: ITEMS & TOTALS (FULL-WIDTH STACK) ────────────────── */}
      <div className="px-4 py-3 flex-1 flex flex-col justify-between">
        {/* Item list */}
        <div className="space-y-2">
          {displayedItems.map((item: OrderItem) => {
            const dotConfig = itemStatusDot[item.status] || itemStatusDot.pending;
            return (
              <div key={item.id} className="text-xs">
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${dotConfig.dot}`}
                      title={tOrders(dotConfig.labelKey)}
                    />
                    <span className="font-semibold text-foreground shrink-0">
                      {item.quantity}x
                    </span>
                    <span className="text-foreground truncate" title={item.product_name}>
                      {item.product_name}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-muted-foreground font-medium">
                      {fmt(Number(item.total))}
                    </span>

                    {/* Touchscreen-accessible item actions for Manager */}
                    {isOwnerOrManager && !isPaid && !['completed', 'cancelled'].includes(order.status) && (
                      <div className="flex items-center gap-1 ms-1 shrink-0">
                        {item.status === 'pending' && onDeleteItem && (
                          <button
                            type="button"
                            onClick={() => onDeleteItem(order.id, item.id)}
                            className="size-8 flex items-center justify-center text-red-400 hover:text-red-600 active:scale-95 rounded-md hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors touch-manipulation"
                            title={tCommon('removeItem')}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                        {(item.status === 'preparing' || item.status === 'ready') && onVoidItem && (
                          <button
                            type="button"
                            onClick={() => onVoidItem(order.id, item.id, item.product_name)}
                            className="size-8 flex items-center justify-center text-red-400 hover:text-red-600 active:scale-95 rounded-md hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors touch-manipulation"
                            title={tOrders('voidItem')}
                          >
                            <Ban size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Add-ons subline */}
                {item.addons && item.addons.length > 0 && (
                  <div className="ps-4 mt-0.5 text-[11px] text-muted-foreground truncate">
                    {item.addons.map((a) => `+ ${a.name}${(a.quantity || 1) > 1 ? ` ×${a.quantity}` : ''}`).join(' · ')}
                  </div>
                )}

                {/* Special instructions / notes subline */}
                {item.special_instructions && (
                  <div className="ps-4 mt-0.5 text-[11px] text-red-500/90 italic truncate">
                    &quot;{item.special_instructions}&quot;
                  </div>
                )}
              </div>
            );
          })}

          {/* Collapsible "+ X more items" and "Voided items" chips */}
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            {hiddenItemCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAllItems((prev) => !prev)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] rounded-full text-xs font-medium bg-muted hover:bg-muted/80 text-foreground transition-colors touch-manipulation active:scale-95"
              >
                <ChevronDown size={13} className={`transition-transform ${showAllItems ? 'rotate-180' : ''}`} />
                <span>{showAllItems ? tCommon('back') : tOrders('moreItems', { count: hiddenItemCount })}</span>
              </button>
            )}

            {inactiveItems.length > 0 && isOwnerOrManager && (
              <button
                type="button"
                onClick={() => setShowVoidedItems((prev) => !prev)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] rounded-full text-xs font-medium bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 hover:bg-red-100 transition-colors touch-manipulation active:scale-95"
              >
                <Ban size={13} />
                <span>{tOrders('voidedItemsCount', { count: inactiveItems.length })}</span>
                <ChevronDown size={13} className={`transition-transform ${showVoidedItems ? 'rotate-180' : ''}`} />
              </button>
            )}
          </div>

          {/* Expanded voided items list */}
          {showVoidedItems && inactiveItems.length > 0 && isOwnerOrManager && (
            <div className="mt-2 ps-2.5 border-s-2 border-red-200 dark:border-red-900/40 space-y-1.5 py-1">
              {inactiveItems.map((cItem: OrderItem) => (
                <div key={cItem.id} className="flex items-center justify-between text-xs opacity-70">
                  <span className="line-through text-muted-foreground truncate">
                    {cItem.quantity}x {cItem.product_name}
                  </span>
                  {cItem.status === 'cancelled' && !isPaid && !['completed', 'cancelled'].includes(order.status) && onRestoreItem && (
                    <button
                      type="button"
                      onClick={() => onRestoreItem(order.id, cItem.id)}
                      className="size-8 flex items-center justify-center hover:text-green-600 text-green-500 rounded active:scale-95 touch-manipulation"
                      title={tCommon('restore')}
                    >
                      <RotateCcw size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Dashed Separator */}
        <div className="my-3 border-t border-dashed border-border" />

        {/* Totals Breakdown */}
        <div className="space-y-1 text-xs">
          <div className="flex justify-between text-muted-foreground">
            <span>{tCommon('subtotal')}</span>
            <span className="font-medium text-foreground">{fmt(subtotal)}</span>
          </div>

          {discount > 0 && (
            <div className="flex justify-between text-emerald-600 dark:text-emerald-400 font-medium">
              <span>{tCommon('discount')}</span>
              <span>-{fmt(discount)}</span>
            </div>
          )}

          {deliveryCharge > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>{tReceipt('deliveryCharge')}</span>
              <span className="font-medium text-foreground">{fmt(deliveryCharge)}</span>
            </div>
          )}

          {serviceCharge > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>{tReceipt('serviceCharge')}</span>
              <span className="font-medium text-foreground">{fmt(serviceCharge)}</span>
            </div>
          )}

          {packagingCharge > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>{tPos('packaging')}</span>
              <span className="font-medium text-foreground">{fmt(packagingCharge)}</span>
            </div>
          )}

          <div className="flex justify-between text-muted-foreground">
            <span>{tCommon('tax')}</span>
            <span className="font-medium text-foreground">{tax > 0 ? fmt(tax) : '-'}</span>
          </div>

          <div className="pt-1.5 border-t border-border flex justify-between text-base font-bold text-foreground">
            <span>{tCommon('total')}</span>
            <span>{fmt(total)}</span>
          </div>
        </div>

        {/* Partial payment balance pill */}
        {bill && payStatus === 'partial' && (
          <div className="mt-2.5 p-2 rounded-lg bg-green-50/70 dark:bg-green-950/40 border border-green-200/60 dark:border-green-900/40 flex items-center justify-between text-xs">
            <span className="text-green-800 dark:text-green-300 flex items-center gap-1.5 font-medium">
              <CreditCard size={13} />
              {tOrders('paid')}: {fmt(Number(bill.paid_amount))}
            </span>
            <span className="text-red-600 dark:text-red-400 font-bold">
              {tOrders('balance')}: {fmt(Number(bill.balance))}
            </span>
          </div>
        )}

        {/* Compact Print Summary */}
        {bill && printCount > 0 && (
          <div className="mt-3 pt-2 border-t border-dashed border-border/60 text-[11px] text-muted-foreground flex items-center justify-between">
            <span className="inline-flex items-center gap-1">
              <Printer size={12} className="text-muted-foreground" />
              {tOrders('printedCount', { count: printCount })}
            </span>
            <button
              type="button"
              onClick={() => setShowPrintActivity((prev) => !prev)}
              className="py-1 hover:underline text-brand font-medium inline-flex items-center gap-0.5 active:scale-95 touch-manipulation min-h-[32px]"
            >
              {tOrders('viewActivity')}
              <ChevronRight size={10} className="rtl-flip" />
            </button>
          </div>
        )}

        {/* Expanded Print Activity Log */}
        {showPrintActivity && orderPrints.length > 0 && (
          <div className="mt-1.5 ps-3 border-s border-border text-[10px] text-muted-foreground space-y-0.5">
            {orderPrints.map((p, idx) => (
              <div key={p.id || idx}>
                {idx + 1}. {tOrders('printHistoryEntry', {
                  printedType: p.print_type === 'reprint' ? tOrders('reprint') : tOrders('printed'),
                  user: p.user_name,
                  time: formatDateTime(p.printed_at),
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── FOOTER ACTIONS BAR ────────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-t border-border bg-card">
        {order.status === 'cancelled' ? (
          <div className="w-full py-2 text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5 min-h-[40px]">
            <Info size={14} className="shrink-0 text-muted-foreground" />
            <span>{tOrders('noFurtherActions')}</span>
          </div>
        ) : isPaid || order.status === 'completed' ? (
          <div className="flex items-center gap-2">
            {/* Primary receipt action on POS: Print Thermal Receipt */}
            {bill && (
              <Button
                variant="outline"
                onClick={() => onPrint(bill.id)}
                disabled={printingBillId === bill.id}
                className="flex-1 h-10 border-border text-foreground hover:bg-muted active:scale-95 touch-manipulation font-semibold text-xs"
              >
                {printingBillId === bill.id ? (
                  <Loader2 size={15} className="animate-spin me-1.5" />
                ) : (
                  <Printer size={15} className="me-1.5 text-muted-foreground" />
                )}
                {printCount > 0 ? tCommon('reprint') : tCommon('print')}
              </Button>
            )}

            {/* WhatsApp button: ONLY when WhatsApp IS ready/configured AND customer has a phone */}
            {isWhatsAppReady && order.customer?.phone && (
              <Button
                variant="outline"
                onClick={() => onSendWhatsApp(order)}
                disabled={sendingWaOrderId === order.id}
                className="flex-1 h-10 border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/40 active:scale-95 touch-manipulation font-semibold text-xs"
              >
                {sendingWaOrderId === order.id ? (
                  <Loader2 size={15} className="animate-spin me-1.5" />
                ) : (
                  <Send size={15} className="me-1.5" />
                )}
                {tOrders('sendReceipt')}
              </Button>
            )}

            {/* Refund button for Owner / Manager (neutral outline, no purple) */}
            {isOwnerOrManager && hasEligibleRefund && (
              <Button
                variant="outline"
                onClick={() => onRefund(order, paidBills)}
                className="flex-1 h-10 border-border text-foreground hover:bg-muted active:scale-95 touch-manipulation font-semibold text-xs"
              >
                <RotateCcw size={15} className="me-1.5 text-muted-foreground" />
                {tOrders('refundButton')}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              onClick={() => onCheckout(order.id)}
              disabled={generatingBillId === order.id}
              className={`flex-1 h-10 justify-center active:scale-95 touch-manipulation font-semibold text-xs ${
                payStatus === 'partial'
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-foreground text-background hover:bg-foreground/90'
              }`}
            >
              <CreditCard size={15} className="me-1.5" />
              {checkoutButtonLabel}
            </Button>

            <Button
              variant="outline"
              onClick={() => onAddItems(order)}
              className="flex-1 h-10 justify-center border-green-300 text-green-600 hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-950/40 dark:border-green-800 active:scale-95 touch-manipulation font-semibold text-xs"
            >
              <Plus size={15} className="me-1.5" />
              {tOrders('addItem')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
