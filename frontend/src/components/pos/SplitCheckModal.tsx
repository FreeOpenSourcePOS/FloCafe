'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Bill, Order, OrderItem } from '@/lib/types';
import { isTerminalItemStatus } from '../../../../shared/order-item-status';
import {
  CHECKOUT_PRIMARY_CTA_CLASS,
  CheckoutHeaderChips,
  CheckoutQtyBadge,
  type CheckoutHeaderChipItem,
} from './checkout-ui';

type SplitMode = 'table' | 'guest';

// Bounds shared with the equal-share payer count: both divide one check into a
// small, bounded number of parts.
export const MIN_CHECKS = 2;
export const MAX_CHECKS = 20;
const MAX_LABEL_LENGTH = 40;

/** Only whole, positive quantities of live lines can be divided. */
function selectableItems(order: Order | null): OrderItem[] {
  return ((order?.items || []) as OrderItem[]).filter(
    (item) =>
      !isTerminalItemStatus(item.status) &&
      Number.isSafeInteger(Number(item.quantity)) &&
      Number(item.quantity) > 0,
  );
}

function clampLabel(value: string, fallback: string): string {
  return value.trim().slice(0, MAX_LABEL_LENGTH) || fallback.slice(0, MAX_LABEL_LENGTH);
}

export function buildEvenAllocations(
  items: OrderItem[],
  checkCount: number,
): Record<number, number[]> {
  let nextSlot = 0;
  return Object.fromEntries(
    items.map((item) => {
      const slots = Array(checkCount).fill(0);
      for (let unit = 0; unit < Number(item.quantity); unit++) slots[nextSlot++ % checkCount]++;
      return [item.id, slots];
    }),
  );
}

/**
 * Updates one check's item count and pulls any excess from other checks so a
 * single tap transfers units cleanly without leaving the row over-allocated.
 */
export function rebalanceRowAllocation(
  slots: number[],
  targetIndex: number,
  nextValue: number,
  itemQuantity: number,
): number[] {
  const maxQty = Math.max(0, Math.trunc(Number(itemQuantity) || 0));
  const clamped = Math.max(
    0,
    Math.min(maxQty, Number.isFinite(nextValue) ? Math.trunc(nextValue) : 0),
  );
  const nextSlots = slots.map((qty, idx) => (idx === targetIndex ? clamped : qty));
  let excess = nextSlots.reduce((sum, qty) => sum + qty, 0) - maxQty;
  while (excess > 0) {
    let donorIndex = -1;
    for (let idx = 0; idx < nextSlots.length; idx++) {
      if (idx === targetIndex || nextSlots[idx] <= 0) continue;
      if (donorIndex === -1 || nextSlots[idx] >= nextSlots[donorIndex]) {
        donorIndex = idx;
      }
    }
    if (donorIndex === -1) break;
    nextSlots[donorIndex] -= 1;
    excess -= 1;
  }
  return nextSlots;
}

/**
 * Divides one unpaid check. The cashier either spreads the whole check across a
 * number of evenly shared checks, or picks the quantities the leaving guest is
 * paying for and leaves every other quantity on an unpaid check. The second mode
 * is what makes repeatable guest checkout possible: the remainder keeps this
 * bill's identity and can be divided again when the next guest leaves.
 */
export function SplitCheckModal({
  bill,
  order,
  onClose,
  onSplit,
  onSubmittingChange,
}: {
  bill: Bill;
  order: Order;
  onClose: () => void;
  onSplit: (bills: Bill[], departingBill: Bill | null) => void;
  onSubmittingChange?: (submitting: boolean) => void;
}) {
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  // The caller passes the bill-scoped projection, so these quantities are this
  // check's own share and never a paid sibling's.
  const [sourceOrder, setSourceOrder] = useState<Order>(order);
  const items = useMemo(() => selectableItems(sourceOrder), [sourceOrder]);
  const availableUnits = items.reduce((sum, item) => sum + Number(item.quantity), 0);
  const canSplitTable = availableUnits >= MIN_CHECKS;
  const maxTableChecks = Math.min(MAX_CHECKS, availableUnits);
  const checkTotal = Number(bill.total || 0);

  // A split-group child is divided for a leaving guest by default; the first
  // split of an untouched check keeps the familiar all-items grid.
  const [mode, setMode] = useState<SplitMode>(
    bill.split_group_id || !canSplitTable ? 'guest' : 'table',
  );
  const initialCount = canSplitTable
    ? Math.min(8, maxTableChecks, Math.max(MIN_CHECKS, order.guest_count || MIN_CHECKS))
    : MIN_CHECKS;
  const [count, setCount] = useState(initialCount);
  const [labels, setLabels] = useState(() =>
    Array.from({ length: initialCount }, (_, i) => `Guest ${i + 1}`),
  );
  const [allocations, setAllocations] = useState<Record<number, number[]>>(() =>
    buildEvenAllocations(items, initialCount),
  );
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [guestLabel, setGuestLabel] = useState(() =>
    t('leavingGuestLabel').slice(0, MAX_LABEL_LENGTH),
  );
  const [remainderLabel, setRemainderLabel] = useState(() =>
    (bill.split_label || t('remainingCheckLabel')).slice(0, MAX_LABEL_LENGTH),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    onSubmittingChange?.(saving);
    return () => onSubmittingChange?.(false);
  }, [saving, onSubmittingChange]);

  const resize = (next: number) => {
    if (!canSplitTable) return;
    next = Math.min(maxTableChecks, Math.max(MIN_CHECKS, next));
    setLabels((old) => Array.from({ length: next }, (_, i) => old[i] || `Guest ${i + 1}`));
    setAllocations((old) =>
      Object.fromEntries(
        items.map((item) => {
          const slots = Array.from({ length: next }, (_, i) => old[item.id]?.[i] || 0);
          const assigned = slots.reduce((sum, value) => sum + value, 0);
          if (assigned < item.quantity) slots[0] += item.quantity - assigned;
          if (assigned > item.quantity)
            slots[0] = Math.max(0, slots[0] - (assigned - item.quantity));
          return [item.id, slots];
        }),
      ),
    );
    setCount(next);
  };

  const distributeEvenly = () => {
    if (!canSplitTable || saving) return;
    setAllocations(buildEvenAllocations(items, count));
  };

  const updateTableCell = (item: OrderItem, checkIndex: number, value: number) => {
    setAllocations((old) => {
      const currentSlots = Array.from({ length: count }, (_, idx) => old[item.id]?.[idx] || 0);
      return {
        ...old,
        [item.id]: rebalanceRowAllocation(currentSlots, checkIndex, value, Number(item.quantity)),
      };
    });
  };

  const totals = useMemo(
    () =>
      Array.from({ length: count }, (_, checkIndex) =>
        items.reduce(
          (sum, item) =>
            sum + (Number(item.total) * (allocations[item.id]?.[checkIndex] || 0)) / item.quantity,
          0,
        ),
      ),
    [allocations, count, items],
  );

  const selectedUnits = items.reduce((sum, item) => sum + (selected[item.id] || 0), 0);
  const remainingUnits = availableUnits - selectedUnits;
  const unassignedUnits = items.reduce(
    (sum, item) =>
      sum +
      Math.max(
        0,
        Number(item.quantity) -
          (allocations[item.id] || []).reduce((total, value) => total + value, 0),
      ),
    0,
  );
  const invalidTableAllocation =
    items.some(
      (item) =>
        (allocations[item.id] || []).reduce((sum, value) => sum + value, 0) !== item.quantity,
    ) ||
    Array.from({ length: count }, (_, check) =>
      items.every((item) => !(allocations[item.id]?.[check] > 0)),
    ).some(Boolean);
  const guestEstimate = items.reduce(
    (sum, item) => sum + (Number(item.total) * (selected[item.id] || 0)) / Number(item.quantity),
    0,
  );
  const remainingEstimate = Math.max(0, checkTotal - guestEstimate);

  const setQuantity = (item: OrderItem, value: number) =>
    setSelected((old) => ({
      ...old,
      [item.id]: Math.max(
        0,
        Math.min(Number(item.quantity), Number.isFinite(value) ? Math.trunc(value) : 0),
      ),
    }));

  /**
   * A rejected or unanswered split means the source may have moved on. Re-read
   * the check and keep only the draft that still fits its quantities; the
   * mutation itself is never retried automatically.
   */
  const refreshSource = useCallback(async () => {
    try {
      const { data } = await api.get(`/bills/${bill.id}`);
      const refreshed = (data?.bill?.order ?? null) as Order | null;
      if (!refreshed) return;
      const nextItems = selectableItems(refreshed);
      setSourceOrder(refreshed);
      setSelected((old) =>
        Object.fromEntries(
          nextItems.map((item) => [
            item.id,
            Math.max(0, Math.min(Number(item.quantity), old[item.id] || 0)),
          ]),
        ),
      );
      setAllocations((old) =>
        Object.fromEntries(
          nextItems.map((item) => [
            item.id,
            Array.from({ length: count }, (_, index) =>
              Math.max(0, Math.min(Number(item.quantity), old[item.id]?.[index] || 0)),
            ),
          ]),
        ),
      );
    } catch {
      // The draft stays untouched when the check cannot be re-read.
    }
  }, [bill.id, count]);

  const submitAllItems = async () => {
    if (invalidTableAllocation) return toast.error(t('allocateAllItems'));
    setSaving(true);
    try {
      const checks = Array.from({ length: count }, (_, checkIndex) => ({
        label: labels[checkIndex],
        items: items.flatMap((item) => {
          const quantity = allocations[item.id]?.[checkIndex] || 0;
          return quantity > 0 ? [{ order_item_id: item.id, quantity }] : [];
        }),
      }));
      const { data } = await api.post(`/bills/${bill.id}/split-check`, { checks });
      onSplit(data.bills, null);
    } catch {
      await refreshSource();
      toast.error(t('splitCheckFailed'));
    } finally {
      setSaving(false);
    }
  };

  const submitLeavingGuest = async () => {
    if (saving || selectedUnits === 0 || remainingUnits === 0) return;
    setSaving(true);
    try {
      // The remainder keeps this bill as checks[0]; the leaving guest is the new
      // check, so the table stays open for whoever leaves next.
      const checks = [
        {
          label: clampLabel(remainderLabel, t('remainingCheckLabel')),
          items: items.flatMap((item) => {
            const quantity = Number(item.quantity) - (selected[item.id] || 0);
            return quantity > 0 ? [{ order_item_id: item.id, quantity }] : [];
          }),
        },
        {
          label: clampLabel(guestLabel, t('leavingGuestLabel')),
          items: items.flatMap((item) => {
            const quantity = selected[item.id] || 0;
            return quantity > 0 ? [{ order_item_id: item.id, quantity }] : [];
          }),
        },
      ];
      const { data } = await api.post(`/bills/${bill.id}/split-check`, { checks });
      const departing =
        (data.bills as Bill[]).find((created) => Number(created.id) !== Number(bill.id)) ?? null;
      onSplit(data.bills, departing);
    } catch {
      await refreshSource();
      toast.error(t('splitCheckFailed'));
    } finally {
      setSaving(false);
    }
  };

  const allSelected = selectedUnits > 0 && remainingUnits === 0;
  const stepperBtnClass =
    'size-11 min-h-11 min-w-11 rounded-lg border border-border bg-card text-foreground shadow-2xs flex items-center justify-center transition-[color,background-color,border-color,box-shadow,transform] hover:border-brand/40 hover:bg-brand-light/25 active:scale-[0.98] disabled:opacity-40 dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:border-indigo-400/45 dark:hover:bg-[var(--color-brand-light)]';

  const headerChips: CheckoutHeaderChipItem[] = [
    { key: 'bill', label: t('billNumber', { number: bill.bill_number }) },
    ...(bill.split_label
      ? [{ key: 'split', label: bill.split_label, variant: 'brand' as const }]
      : []),
    ...(order?.order_number
      ? [{ key: 'order', label: t('orderNumber', { number: order.order_number }) }]
      : []),
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-0 sm:p-4">
      <div className="bg-card border border-border/80 shadow-xl flex h-[100dvh] w-full max-w-[1400px] flex-col overflow-hidden sm:h-[95dvh] sm:rounded-2xl dark:border-white/10">
        <div className="px-5 py-4 border-b border-border/80 bg-card flex items-start justify-between gap-3 dark:border-white/10">
          <div className="min-w-0">
            <h2 className="text-lg font-bold tracking-tight text-foreground">{t('splitCheck')}</h2>
            <CheckoutHeaderChips chips={headerChips} className="mt-1.5" />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {mode === 'guest' ? t('selectItemsHint') : t('splitCheckHint')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label={tCommon('close')}
            className="touch-target shrink-0 rounded-xl border border-border/75 bg-muted/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 dark:border-white/10"
          >
            <X size={20} />
          </button>
        </div>
        <div className="px-5 py-3.5 border-b border-border/80 bg-muted/30 flex flex-wrap items-center gap-3 dark:border-white/10 dark:bg-muted/15">
          <div className="inline-flex rounded-xl border border-border/80 bg-muted/60 p-1 dark:border-white/10 dark:bg-muted/35">
            <Button
              variant={mode === 'guest' ? 'default' : 'ghost'}
              size="sm"
              className={
                mode === 'guest'
                  ? 'min-h-11 rounded-lg bg-brand text-white shadow-xs hover:bg-brand-hover'
                  : 'min-h-11 rounded-lg text-muted-foreground hover:text-foreground'
              }
              onClick={() => setMode('guest')}
              disabled={saving}
            >
              {t('splitModeSelected')}
            </Button>
            <Button
              variant={mode === 'table' ? 'default' : 'ghost'}
              size="sm"
              className={
                mode === 'table'
                  ? 'min-h-11 rounded-lg bg-brand text-white shadow-xs hover:bg-brand-hover'
                  : 'min-h-11 rounded-lg text-muted-foreground hover:text-foreground'
              }
              onClick={() => setMode('table')}
              disabled={saving || !canSplitTable}
            >
              {t('splitModeAll')}
            </Button>
          </div>
          {mode === 'table' ? (
            <div className="flex flex-wrap items-center gap-2 ms-auto">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 rounded-lg bg-card dark:border-white/10"
                onClick={distributeEvenly}
                disabled={saving || !canSplitTable || items.length === 0}
                data-testid="split-distribute-evenly"
              >
                <RotateCcw size={14} className="me-1.5" />
                {t('distributeEvenly')}
              </Button>
              <span className="text-sm font-medium text-muted-foreground ms-1">
                {t('numberOfChecks')}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={t('decreasePax')}
                  data-testid="split-check-count-decrement"
                  onClick={() => resize(count - 1)}
                  disabled={saving || count <= MIN_CHECKS}
                  className={stepperBtnClass}
                >
                  <Minus size={15} />
                </button>
                <input
                  type="number"
                  min={MIN_CHECKS}
                  max={maxTableChecks}
                  step={1}
                  inputMode="numeric"
                  aria-label={t('numberOfChecks')}
                  data-testid="split-check-count"
                  disabled={saving || !canSplitTable}
                  value={count}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (Number.isFinite(parsed) && parsed >= MIN_CHECKS) resize(Math.trunc(parsed));
                  }}
                  className="min-h-11 w-14 rounded-lg border border-border bg-card px-2 py-1 text-center font-semibold tabular-nums text-foreground shadow-2xs outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 dark:border-white/10"
                />
                <button
                  type="button"
                  aria-label={t('increasePax')}
                  data-testid="split-check-count-increment"
                  onClick={() => resize(count + 1)}
                  disabled={saving || count >= maxTableChecks}
                  className={stepperBtnClass}
                >
                  <Plus size={15} />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5 ms-auto text-sm tabular-nums">
              <span
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                  selectedUnits > 0
                    ? 'border-brand/30 bg-brand-light text-brand dark:border-indigo-400/40 dark:bg-[var(--color-brand-light)] dark:text-indigo-300'
                    : 'border-border/80 bg-card text-muted-foreground dark:border-white/10'
                }`}
              >
                <span>{t('selectedQuantity')}</span>
                <strong className="font-bold">{selectedUnits}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground dark:border-white/10">
                <span>{t('remainingQuantity')}</span>
                <strong className="font-bold text-foreground">{remainingUnits}</strong>
              </span>
              {selectedUnits > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 rounded-lg"
                  onClick={() => setSelected({})}
                  disabled={saving}
                  data-testid="guest-split-clear"
                >
                  {tCommon('clear')}
                </Button>
              )}
            </div>
          )}
        </div>
        {mode === 'table' ? (
          <div className="min-h-0 flex-1 overflow-auto p-5">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-start p-2.5 text-xs font-semibold text-muted-foreground sticky start-0 z-10 bg-card">
                    {t('items')}
                  </th>
                  {Array.from({ length: count }, (_, i) => (
                    <th key={i} className="p-2 min-w-36">
                      <input
                        value={labels[i]}
                        disabled={saving}
                        onChange={(e) =>
                          setLabels((old) =>
                            old.map((label, n) =>
                              n === i ? e.target.value.slice(0, MAX_LABEL_LENGTH) : label,
                            ),
                          )
                        }
                        className="min-h-11 w-full rounded-lg border border-border bg-card px-2.5 py-1 text-center font-medium text-foreground shadow-2xs outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 dark:border-white/10"
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item: OrderItem) => {
                  const maxItemQty = Number(item.quantity);
                  const rowAssigned = (allocations[item.id] || []).reduce(
                    (sum, value) => sum + value,
                    0,
                  );
                  const rowUnassigned = maxItemQty - rowAssigned;
                  return (
                    <tr key={item.id} className="border-t border-border/80 dark:border-white/10">
                      <td className="p-2.5 sticky start-0 z-10 bg-card">
                        <div className="flex items-center gap-2">
                          <CheckoutQtyBadge>{item.quantity}</CheckoutQtyBadge>
                          <span className="font-semibold text-foreground">{item.product_name}</span>
                        </div>
                        <div className="mt-0.5 ps-7 text-xs tabular-nums text-muted-foreground">
                          {item.quantity} × {fmt(Number(item.total) / item.quantity)}
                        </div>
                        {rowUnassigned > 0 && (
                          <div className="mt-1.5 ps-7">
                            <span
                              data-testid={`split-row-unassigned-${item.id}`}
                              className="inline-flex items-center rounded-full border border-amber-500/35 bg-amber-500/12 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:text-amber-300"
                            >
                              {t('remainingCount', { count: rowUnassigned })}
                            </span>
                          </div>
                        )}
                      </td>
                      {Array.from({ length: count }, (_, i) => {
                        const cellQty = allocations[item.id]?.[i] || 0;
                        return (
                          <td key={i} className="p-2">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                aria-label={t('decreaseQuantity')}
                                data-testid={`split-cell-dec-${item.id}-${i}`}
                                disabled={saving || cellQty <= 0}
                                onClick={() => updateTableCell(item, i, cellQty - 1)}
                                className={stepperBtnClass}
                              >
                                <Minus size={15} />
                              </button>
                              <input
                                type="number"
                                min="0"
                                max={maxItemQty}
                                step={1}
                                inputMode="numeric"
                                disabled={saving}
                                aria-label={`${item.product_name} - ${labels[i] || `Guest ${i + 1}`}`}
                                value={cellQty}
                                onChange={(e) =>
                                  updateTableCell(item, i, Number(e.target.value) || 0)
                                }
                                className={`min-h-11 w-12 rounded-lg border px-1 py-1 text-center font-semibold tabular-nums outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 ${
                                  cellQty > 0
                                    ? 'border-brand/40 bg-brand-light/35 text-brand dark:border-indigo-400/45 dark:bg-[var(--color-brand-light)] dark:text-indigo-300'
                                    : 'border-border bg-card text-foreground dark:border-white/10'
                                }`}
                              />
                              <button
                                type="button"
                                aria-label={t('increaseQuantity')}
                                data-testid={`split-cell-inc-${item.id}-${i}`}
                                disabled={saving || cellQty >= maxItemQty}
                                onClick={() => updateTableCell(item, i, cellQty + 1)}
                                className={stepperBtnClass}
                              >
                                <Plus size={15} />
                              </button>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-card font-semibold dark:border-white/15">
                  <td className="sticky start-0 z-10 bg-card p-3 text-foreground">
                    {t('estimatedItemsTotal')}
                  </td>
                  {totals.map((total, i) => (
                    <td
                      key={i}
                      className="p-3 text-center tabular-nums text-brand dark:text-indigo-300"
                    >
                      {fmt(total)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noSplitCheckItems')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-start p-2.5 text-xs font-semibold text-muted-foreground sticky start-0 z-10 bg-card">
                      {t('items')}
                    </th>
                    <th className="p-2.5 min-w-28 text-xs font-semibold text-muted-foreground">
                      {t('sourceQuantity')}
                    </th>
                    <th className="p-2.5 min-w-44 text-xs font-semibold text-muted-foreground">
                      {t('selectedQuantity')}
                    </th>
                    <th className="p-2.5 min-w-28 text-xs font-semibold text-muted-foreground">
                      {t('remainingQuantity')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item: OrderItem) => {
                    const selectedQty = selected[item.id] || 0;
                    const maxItemQty = Number(item.quantity);
                    return (
                      <tr
                        key={item.id}
                        className={`border-t border-border/80 transition-colors dark:border-white/10 ${
                          selectedQty > 0 ? 'bg-brand-light dark:bg-[var(--color-brand-light)]' : ''
                        }`}
                      >
                        <td
                          className={`p-2.5 sticky start-0 z-10 transition-colors ${
                            selectedQty > 0
                              ? 'bg-brand-light dark:bg-[var(--color-brand-light)]'
                              : 'bg-card'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <CheckoutQtyBadge>{item.quantity}</CheckoutQtyBadge>
                            <span className="font-semibold text-foreground">
                              {item.product_name}
                            </span>
                          </div>
                          <div className="mt-0.5 ps-7 text-xs tabular-nums text-muted-foreground">
                            {item.quantity} × {fmt(Number(item.total) / item.quantity)}
                          </div>
                        </td>
                        <td className="p-2.5 text-center font-medium tabular-nums">
                          {item.quantity}
                        </td>
                        <td className="p-2.5">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              aria-label={t('decreaseQuantity')}
                              data-testid={`guest-item-dec-${item.id}`}
                              disabled={saving || selectedQty <= 0}
                              onClick={() => setQuantity(item, selectedQty - 1)}
                              className={stepperBtnClass}
                            >
                              <Minus size={15} />
                            </button>
                            <input
                              type="number"
                              min="0"
                              max={item.quantity}
                              step={1}
                              inputMode="numeric"
                              disabled={saving}
                              aria-label={t('selectedQuantity')}
                              value={selectedQty}
                              onChange={(e) => setQuantity(item, Number(e.target.value))}
                              className={`min-h-11 w-16 rounded-lg border px-2 py-1 text-center font-semibold tabular-nums outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 ${
                                selectedQty > 0
                                  ? 'border-brand/40 bg-brand-light/35 text-brand dark:border-indigo-400/45 dark:bg-[var(--color-brand-light)] dark:text-indigo-300'
                                  : 'border-border bg-card text-foreground dark:border-white/10'
                              }`}
                            />
                            <button
                              type="button"
                              aria-label={t('increaseQuantity')}
                              data-testid={`guest-item-inc-${item.id}`}
                              disabled={saving || selectedQty >= maxItemQty}
                              onClick={() => setQuantity(item, selectedQty + 1)}
                              className={stepperBtnClass}
                            >
                              <Plus size={15} />
                            </button>
                          </div>
                        </td>
                        <td className="p-2.5 text-center font-medium tabular-nums">
                          {maxItemQty - selectedQty}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {selectedUnits === 0 && items.length > 0 && (
              <p className="mt-3 text-sm text-muted-foreground">{t('selectAtLeastOneItem')}</p>
            )}
            {allSelected && (
              <p className="mt-3 text-sm text-muted-foreground">{t('allItemsSelected')}</p>
            )}
            {items.length > 0 && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="block text-xs font-medium text-muted-foreground mb-1.5">
                    {t('leavingGuestLabel')}
                  </span>
                  <input
                    value={guestLabel}
                    maxLength={MAX_LABEL_LENGTH}
                    onChange={(e) => setGuestLabel(e.target.value)}
                    className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-2xs outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 dark:border-white/10"
                  />
                </label>
                <label className="text-sm">
                  <span className="block text-xs font-medium text-muted-foreground mb-1.5">
                    {t('remainingCheckLabel')}
                  </span>
                  <input
                    value={remainderLabel}
                    maxLength={MAX_LABEL_LENGTH}
                    onChange={(e) => setRemainderLabel(e.target.value)}
                    className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-2xs outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 dark:border-white/10"
                  />
                </label>
              </div>
            )}
            {items.length > 0 && (
              <div className="mt-4 space-y-1.5 rounded-xl border border-border bg-muted/35 p-3.5 text-sm tabular-nums dark:border-white/10 dark:bg-muted/20">
                <div className="flex justify-between font-semibold text-foreground">
                  <span>{t('estimatedLeavingGuestTotal')}</span>
                  <strong className="text-brand dark:text-indigo-300">{fmt(guestEstimate)}</strong>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('remainingCheckLabel')}</span>
                  <span className="font-medium text-foreground">{fmt(remainingEstimate)}</span>
                </div>
                <p className="pt-0.5 text-xs text-muted-foreground">{t('estimateDisclaimer')}</p>
              </div>
            )}
          </div>
        )}
        <div className="shrink-0 px-5 py-4 border-t border-border/80 bg-muted/25 flex justify-end gap-2.5 dark:border-white/10 dark:bg-muted/15">
          {mode === 'table' && unassignedUnits > 0 && (
            <span
              data-testid="split-unassigned-total"
              className="me-auto inline-flex items-center self-center rounded-full border border-amber-500/35 bg-amber-500/12 px-3 py-1 text-xs font-semibold text-amber-800 dark:text-amber-300"
              aria-live="polite"
            >
              {t('remainingCount', { count: unassignedUnits })}
            </span>
          )}
          <Button
            variant="outline"
            onClick={onClose}
            disabled={saving}
            className="min-h-11 rounded-xl bg-card dark:border-white/10"
          >
            {tCommon('cancel')}
          </Button>
          {mode === 'table' ? (
            <Button
              className={`min-h-11 rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
              data-testid="split-create-checks"
              onClick={submitAllItems}
              disabled={saving || !canSplitTable || items.length === 0 || invalidTableAllocation}
            >
              {saving ? tCommon('saving') : t('createChecks')}
            </Button>
          ) : allSelected ? (
            <Button
              onClick={onClose}
              disabled={saving}
              className={`min-h-11 rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
            >
              {t('payThisCheck')}
            </Button>
          ) : (
            <Button
              className={`min-h-11 rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
              onClick={submitLeavingGuest}
              disabled={saving || selectedUnits === 0 || items.length === 0}
            >
              {saving ? tCommon('saving') : t('createChecks')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
