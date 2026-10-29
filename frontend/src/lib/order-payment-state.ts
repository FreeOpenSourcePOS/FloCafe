import type { Bill, Order } from './types';

export type OrderPaymentBadgeStatus =
  | 'paid'
  | 'partial'
  | 'partially_refunded'
  | 'refunded'
  | 'unpaid';

export function getOrderBills(order: Pick<Order, 'bill' | 'bills'>): Bill[] {
  if (order.bills && order.bills.length > 0) return order.bills;
  if (order.bill) return [order.bill];
  return [];
}

export function getRefundEligibleBills(order: Pick<Order, 'bill' | 'bills'>): Bill[] {
  return getOrderBills(order).filter(
    (bill) => Number(bill.paid_amount) > 0 && bill.payment_status !== 'refunded',
  );
}

export function isPayableBillStatus(status: unknown): boolean {
  return status === 'unpaid' || status === 'partial' || status === 'partially_paid';
}

export function isPayableBill(bill: Pick<Bill, 'payment_status'> | null | undefined): boolean {
  if (!bill) return false;
  return isPayableBillStatus(bill.payment_status);
}

export function canPayScheduledOrder(order: Pick<Order, 'bill' | 'bills'>): boolean {
  const bills = getOrderBills(order);
  return bills.length === 0 || bills.some(isPayableBill);
}

function hasNonEmptyPaymentDetails(raw: unknown): boolean {
  if (!raw) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '[]' || trimmed === 'null') return false;
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
    } catch {
      return true;
    }
  }
  return typeof raw === 'object';
}

export function orderHasCollectedFunds(order: Pick<Order, 'bill' | 'bills'>): boolean {
  return getOrderBills(order).some((candidate) => {
    const status = String(candidate.payment_status || '');
    const paidAmount = Number(candidate.paid_amount || 0);
    const total = Number(candidate.total || 0);
    const hasDetails = hasNonEmptyPaymentDetails(candidate.payment_details);
    return (
      (paidAmount > 0 && status !== 'refunded') ||
      status === 'partial' ||
      status === 'partially_refunded' ||
      (status === 'paid' && (total > 0 || hasDetails))
    );
  });
}

export function hasRecordedOrderPayment(bills: Bill[]): boolean {
  return bills.some(
    (bill) =>
      ['paid', 'partial', 'partially_paid', 'partially_refunded', 'refunded'].includes(
        String(bill.payment_status || ''),
      ) ||
      Number(bill.paid_amount || 0) > 0 ||
      hasNonEmptyPaymentDetails(bill.payment_details),
  );
}

export function isScheduledOrder(
  order: Pick<Order, 'scheduled_for' | 'release_status'> | null | undefined,
): boolean {
  if (!order) return false;
  return Boolean(
    order.scheduled_for ||
    (typeof order.release_status === 'string' &&
      order.release_status.length > 0 &&
      order.release_status !== 'released'),
  );
}

export function isScheduledOrderEditLocked(
  order: Pick<Order, 'scheduled_for' | 'release_status' | 'bill' | 'bills'> | null | undefined,
  explicitBills?: Bill[],
): boolean {
  if (!isScheduledOrder(order)) return false;
  const orderBills = order ? getOrderBills(order) : [];
  const combinedBills =
    explicitBills && explicitBills.length > 0 ? [...explicitBills, ...orderBills] : orderBills;
  return hasRecordedOrderPayment(combinedBills);
}

export function resolveOrderPaymentStatus(
  order: Pick<Order, 'status' | 'bill' | 'bills'>,
): OrderPaymentBadgeStatus | null {
  if (order.status === 'cancelled') return null;
  const bills = getOrderBills(order);
  if (bills.length === 0) return 'unpaid';
  if (bills.length === 1) {
    const status = bills[0].payment_status;
    if (
      status === 'paid' ||
      status === 'partial' ||
      status === 'partially_refunded' ||
      status === 'refunded'
    ) {
      return status;
    }
    return 'unpaid';
  }
  if (bills.some((b) => b.payment_status === 'unpaid' || b.payment_status === 'partial')) {
    return orderHasCollectedFunds(order) ? 'partial' : 'unpaid';
  }
  if (bills.every((b) => b.payment_status === 'paid')) return 'paid';
  if (bills.every((b) => b.payment_status === 'refunded')) return 'refunded';
  return 'partially_refunded';
}

export function isBillPayableForCheckout(bill: Bill): boolean {
  const status = bill.payment_status;
  if (status === 'paid' || status === 'partially_refunded' || status === 'refunded') {
    return false;
  }
  const balance = Number(bill.balance ?? 0);
  if (balance > 0) return true;
  return (
    status === 'unpaid' && Number(bill.total ?? 0) === 0 && Number(bill.paid_amount ?? 0) === 0
  );
}

export function canCheckoutOrder(order: Pick<Order, 'status' | 'bill' | 'bills'>): boolean {
  if (order.status === 'completed' || order.status === 'cancelled') return false;
  const bills = getOrderBills(order);
  if (bills.length === 0) return true;
  return bills.some(isBillPayableForCheckout);
}

export function isOrderCustomerEditLocked(
  order: Pick<Order, 'status' | 'scheduled_for' | 'release_status' | 'bill' | 'bills'>,
): boolean {
  if (order.status === 'completed' || order.status === 'cancelled') return true;
  if (isScheduledOrderEditLocked(order)) return true;
  return getOrderBills(order).some(
    (bill) =>
      Boolean(bill.split_group_id) ||
      ['paid', 'partial', 'partially_refunded', 'refunded'].includes(
        String(bill.payment_status || ''),
      ) ||
      Number(bill.paid_amount || 0) > 0,
  );
}

export function isOrderItemEditLocked(
  order: Pick<Order, 'status' | 'scheduled_for' | 'release_status' | 'bill' | 'bills'>,
): boolean {
  if (order.status === 'completed' || order.status === 'cancelled') return true;
  if (isScheduledOrderEditLocked(order)) return true;
  return getOrderBills(order).some((b) =>
    ['paid', 'partially_refunded', 'refunded'].includes(String(b.payment_status || '')),
  );
}

export function getCancelOrderFailureKind(
  error: unknown,
): 'refund_required_before_cancel' | 'pin_required' | 'generic' {
  const err = error as {
    response?: { data?: { error?: unknown; code?: unknown } };
    message?: unknown;
  };
  const code = typeof err?.response?.data?.code === 'string' ? err.response.data.code : '';
  if (code === 'REFUND_REQUIRED_BEFORE_CANCEL') {
    return 'refund_required_before_cancel';
  }
  const message =
    typeof err?.response?.data?.error === 'string'
      ? err.response.data.error
      : typeof err?.message === 'string'
        ? err.message
        : '';
  if (/PIN/i.test(message)) {
    return 'pin_required';
  }
  return 'generic';
}

export function isScheduledEditLockedError(error: unknown): boolean {
  const err = error as { response?: { data?: { code?: unknown } } };
  const code = err?.response?.data?.code;
  return code === 'SCHEDULED_ORDER_PAID';
}
