import Decimal from 'decimal.js';
import { attachEffectiveAddons, getDatabase, parseItemJson, parseRowJson } from '../db';
import { getCurrencyMinorUnitFactor } from '../countries';
import { isExcludedFromBillReceipt } from '../../shared/order-item-status';
import { getTenantCurrency } from './refund';
import {
  allocateDocumentTaxRounding,
  computeDiscountTaxRatio,
  scaleTaxSnapshots,
  type DocumentTaxAllocationItemOutput,
} from './tax';

export type ChildItemAllocation = { weights: number[]; index: number };

export function allocateMinorUnits(sourceMinor: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const effectiveWeights = totalWeight === 0 ? Array(n).fill(1) : weights;
  const effectiveTotalWeight = effectiveWeights.reduce((sum, w) => sum + w, 0);

  const base: number[] = new Array(n);
  const remainders: { index: number; remainder: number }[] = new Array(n);
  let used = 0;

  for (let i = 0; i < n; i++) {
    const exact = (sourceMinor * effectiveWeights[i]) / effectiveTotalWeight;
    const b = Math.floor(exact);
    base[i] = b;
    used += b;
    remainders[i] = { index: i, remainder: exact - b };
  }

  const left = sourceMinor - used;
  remainders.sort((a, b) => {
    if (Math.abs(b.remainder - a.remainder) > 1e-9) {
      return b.remainder - a.remainder;
    }
    return a.index - b.index;
  });

  for (let i = 0; i < left; i++) {
    base[remainders[i].index] += 1;
  }

  return base;
}

// Allocate signed tax adjustments preserving sign with largest-remainder ordering.
export function allocateSignedMinorUnits(sourceMinor: number, weights: number[]): number[] {
  const sign = sourceMinor < 0 ? -1 : 1;
  return allocateMinorUnits(Math.abs(sourceMinor), weights).map((minor) => minor * sign);
}

export function parseTaxSnapshot(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function snapshotMinorAmount(value: unknown, minorFactor = 100): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * minorFactor);
}

export function formatSnapshotMinorAmount(
  original: unknown,
  minor: number,
  minorFactor = 100,
): string | number {
  const amount = minor / minorFactor;
  return typeof original === 'string' ? amount.toFixed(Math.log10(minorFactor)) : amount;
}

export function reconcileSnapshotAllocations(
  entries: Array<{ allocations: number[] }>,
  targets: number[],
): void {
  if (entries.length === 0 || targets.length === 0) return;
  const sums = targets.map((_, index) =>
    entries.reduce((sum, entry) => sum + entry.allocations[index], 0),
  );
  const deltas = targets.map((target, index) => target - sums[index]);

  while (true) {
    const deficitIndex = deltas.findIndex((delta) => delta > 0);
    const excessIndex = deltas.findIndex((delta) => delta < 0);
    if (deficitIndex === -1 || excessIndex === -1) return;

    const positiveEntry = entries.find((entry) => entry.allocations[excessIndex] > 0);
    if (positiveEntry) {
      positiveEntry.allocations[excessIndex] -= 1;
      positiveEntry.allocations[deficitIndex] += 1;
    } else {
      const negativeEntry = entries.find((entry) => entry.allocations[deficitIndex] < 0);
      if (!negativeEntry) return;
      negativeEntry.allocations[deficitIndex] += 1;
      negativeEntry.allocations[excessIndex] -= 1;
    }

    deltas[excessIndex] += 1;
    deltas[deficitIndex] -= 1;
  }
}

export function hasSnapshotLines(raw: unknown): boolean {
  const parsed = parseTaxSnapshot(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).some(
    (snapshot) =>
      snapshot && typeof snapshot === 'object' && Array.isArray((snapshot as any).lines),
  );
}

function allocateTaxBreakdownForChild(
  raw: unknown,
  weights: number[],
  childIndex: number,
  sourceTaxMinor?: number,
  minorFactor = 100,
): string | unknown {
  const parsed =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : raw;
  if (!Array.isArray(parsed) || parsed.length === 0) return raw;
  const isNested = Array.isArray(parsed[0]);
  const entries: Array<{
    outerIndex?: number;
    innerIndex: number;
    original: unknown;
    allocations: number[];
  }> = [];
  if (isNested) {
    parsed.forEach((outer: any, outerIndex: number) => {
      if (!Array.isArray(outer)) return;
      outer.forEach((component: any, innerIndex: number) => {
        const amount = snapshotMinorAmount(component?.amount, minorFactor);
        if (amount !== null)
          entries.push({
            outerIndex,
            innerIndex,
            original: component.amount,
            allocations: allocateSignedMinorUnits(amount, weights),
          });
      });
    });
  } else {
    parsed.forEach((component: any, innerIndex: number) => {
      const amount = snapshotMinorAmount(component?.amount, minorFactor);
      if (amount !== null)
        entries.push({
          innerIndex,
          original: component.amount,
          allocations: allocateSignedMinorUnits(amount, weights),
        });
    });
  }
  if (entries.length === 0) return raw;

  const target =
    sourceTaxMinor === undefined
      ? entries.reduce((sum, entry) => sum + snapshotMinorAmount(entry.original, minorFactor)!, 0)
      : sourceTaxMinor;
  reconcileSnapshotAllocations(entries, allocateSignedMinorUnits(target, weights));
  const cloned = JSON.parse(JSON.stringify(parsed));
  if (isNested) {
    cloned.forEach((outer: any[], outerIndex: number) => {
      if (!Array.isArray(outer)) return;
      outer.forEach((component: any, innerIndex: number) => {
        const entry = entries.find(
          (candidate) => candidate.outerIndex === outerIndex && candidate.innerIndex === innerIndex,
        );
        if (entry)
          component.amount = formatSnapshotMinorAmount(
            entry.original,
            entry.allocations[childIndex],
            minorFactor,
          );
      });
    });
  } else {
    cloned.forEach((component: any, innerIndex: number) => {
      const entry = entries.find(
        (candidate) => candidate.outerIndex === undefined && candidate.innerIndex === innerIndex,
      );
      if (entry)
        component.amount = formatSnapshotMinorAmount(
          entry.original,
          entry.allocations[childIndex],
          minorFactor,
        );
    });
  }
  return typeof raw === 'string' ? JSON.stringify(cloned) : cloned;
}

function scaleTaxBreakdown(
  raw: unknown,
  ratio: Decimal.Value,
  ownerWeights?: number[],
  childIndex = 0,
  sourceTaxMinor?: number,
  minorFactor = 100,
): unknown {
  if (ownerWeights && ownerWeights.length > 0) {
    return allocateTaxBreakdownForChild(raw, ownerWeights, childIndex, sourceTaxMinor, minorFactor);
  }
  const ratioDec = Decimal.isDecimal(ratio) ? ratio : new Decimal(ratio);
  if (raw === null || raw === undefined || ratioDec.eq(1)) return raw;
  const wasString = typeof raw === 'string';
  let parsed = raw;
  if (wasString) {
    try {
      parsed = JSON.parse(raw as string);
    } catch {
      return raw;
    }
  }
  const decimals = Math.log10(minorFactor);

  const scale = (value: any): any => {
    if (Array.isArray(value)) return value.map(scale);
    if (!value || typeof value !== 'object') return value;
    const result = { ...value };
    if (Object.prototype.hasOwnProperty.call(result, 'amount')) {
      const amount = Number(result.amount);
      if (Number.isFinite(amount)) {
        const scaled = new Decimal(amount)
          .mul(ratioDec)
          .toSignificantDigits(20, Decimal.ROUND_HALF_UP)
          .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
          .toNumber();
        result.amount = typeof value.amount === 'string' ? scaled.toFixed(decimals) : scaled;
      }
    }
    return result;
  };

  const scaled = scale(parsed);
  return wasString ? JSON.stringify(scaled) : scaled;
}

export function getTaxDiscountRatioDecimal(subtotal: unknown, discountAmount: unknown): Decimal {
  const base = Number(subtotal || 0);
  if (!Number.isFinite(base) || base <= 0) return new Decimal(1);
  const baseDec = new Decimal((subtotal || 0) as number | string);
  const rawDiscount = Number(discountAmount || 0);
  const discountDec = Decimal.max(
    0,
    Decimal.min(
      new Decimal(Number.isFinite(rawDiscount) ? ((discountAmount || 0) as number | string) : 0),
      baseDec,
    ),
  );
  return computeDiscountTaxRatio(baseDec.minus(discountDec), baseDec);
}

export function getTaxDiscountRatio(subtotal: unknown, discountAmount: unknown): number {
  return getTaxDiscountRatioDecimal(subtotal, discountAmount).toNumber();
}

export function projectOrderItems(
  order: any,
  rawItemRows: any[],
  allocations: any[] = [],
  childItemAllocations = new Map<number, ChildItemAllocation>(),
  minorFactor = 100,
): any[] {
  const allocated = new Map(
    allocations.map((row) => [Number(row.order_item_id), Number(row.quantity)]),
  );
  const taxDiscountRatioDec = getTaxDiscountRatioDecimal(order?.subtotal, order?.discount_amount);
  const decimals = Math.log10(minorFactor);
  const docOutputByItem = new Map<unknown, DocumentTaxAllocationItemOutput>();
  if (!taxDiscountRatioDec.eq(1)) {
    const parsedOrderSnap = parseTaxSnapshot(order?.tax_snapshot);
    const orderSnapEntries = Array.isArray(parsedOrderSnap)
      ? parsedOrderSnap
      : parsedOrderSnap
        ? [parsedOrderSnap]
        : [];
    const nonChargeSnapEntries = orderSnapEntries.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).chargeKind !== 'string' &&
        Array.isArray((entry as Record<string, unknown>).lines) &&
        ((entry as Record<string, unknown>).lines as unknown[]).length > 0,
    );
    const toSavedDocOutput = (
      snap: Record<string, unknown>,
    ): DocumentTaxAllocationItemOutput | null => {
      const lines = snap.lines as Record<string, unknown>[] | undefined;
      if (!Array.isArray(lines) || lines.length === 0) {
        return null;
      }
      const line = lines[0];
      const components = line?.components as Record<string, unknown>[] | undefined;
      if (!line || !Array.isArray(components)) return null;
      const lineTax = components.reduce(
        (sum: Decimal, c) => sum.plus(new Decimal((c.amount as string | number) || 0)),
        new Decimal(0),
      );
      return {
        handled: true,
        taxAmount: lineTax.toNumber(),
        breakdown: components.map((c) => ({
          title: String(c.label ?? c.title ?? c.name ?? ''),
          rate: Number(c.rate ?? c.amountPer ?? 0),
          amount: Number(c.amount || 0),
        })),
        snapshotJson: JSON.stringify(snap),
      };
    };
    const itemById = new Map(
      rawItemRows
        .filter((item) => item?.id !== undefined && item?.id !== null)
        .map((item) => [String(item.id), item]),
    );
    for (const snap of nonChargeSnapEntries) {
      const lines = snap.lines as Record<string, unknown>[] | undefined;
      const lineId = String(lines?.[0]?.lineId || '');
      const idMatch = /^line-\d+:(.+)$/.exec(lineId);
      if (idMatch) {
        const matchedItem = itemById.get(idMatch[1]);
        const out = matchedItem ? toSavedDocOutput(snap) : null;
        if (matchedItem && out) docOutputByItem.set(matchedItem, out);
      }
    }
    const billSnapshotItems = rawItemRows.filter(
      (item) => !isExcludedFromBillReceipt(item?.status) && hasSnapshotLines(item?.tax_snapshot),
    );
    if (docOutputByItem.size === 0 && nonChargeSnapEntries.length === billSnapshotItems.length) {
      billSnapshotItems.forEach((item, idx) => {
        const out = toSavedDocOutput(nonChargeSnapEntries[idx]);
        if (out) docOutputByItem.set(item, out);
      });
    }
    if (docOutputByItem.size === 0 && nonChargeSnapEntries.length === 0) {
      const chargeSnapJson = orderSnapEntries
        .filter(
          (entry) =>
            entry &&
            typeof entry === 'object' &&
            typeof (entry as Record<string, unknown>).chargeKind === 'string',
        )
        .map((entry) => JSON.stringify(entry));
      const activeItems = rawItemRows.filter((item) => !isExcludedFromBillReceipt(item?.status));
      const docAllocated = allocateDocumentTaxRounding({
        items: activeItems.map((item, idx) => ({
          snapshot: item.tax_snapshot,
          lineIdOverride: `line-${String(idx + 1).padStart(4, '0')}:${item.id}`,
        })),
        chargeTaxes: {
          taxAmount: 0,
          exclusiveTaxAmount: 0,
          breakdowns: chargeSnapJson.map(() => []),
          snapshotJson: chargeSnapJson,
        },
        currency: '',
        minorFactor,
        itemTaxRatio: taxDiscountRatioDec,
      });
      activeItems.forEach((item, idx) => {
        const out = docAllocated.itemOutputs[idx];
        if (out?.handled) docOutputByItem.set(item, out);
      });
    }
  }
  return rawItemRows
    .filter((item) => allocations.length === 0 || allocated.has(Number(item.id)))
    .map((item) => {
      const quantity = allocated.get(Number(item.id));
      const originalQuantity = Number(item.quantity);
      const quantityRatio =
        quantity === undefined || originalQuantity <= 0 ? 1 : quantity / originalQuantity;
      const ownerAllocation = childItemAllocations.get(Number(item.id));
      const docOut = docOutputByItem.get(item);
      const sourceTaxMinor = docOut
        ? Math.round(docOut.taxAmount * minorFactor)
        : new Decimal(item.tax_amount || 0)
            .mul(taxDiscountRatioDec)
            .toSignificantDigits(20, Decimal.ROUND_HALF_UP)
            .mul(minorFactor)
            .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
            .toNumber();
      const taxMinor = ownerAllocation
        ? allocateSignedMinorUnits(sourceTaxMinor, ownerAllocation.weights)[ownerAllocation.index]
        : Math.round(sourceTaxMinor * quantityRatio);
      const hasSnapshot = hasSnapshotLines(item.tax_snapshot);
      const scaledBreakdown = docOut
        ? typeof item.tax_breakdown === 'string'
          ? JSON.stringify(docOut.breakdown)
          : docOut.breakdown
        : hasSnapshot
          ? item.tax_breakdown
          : scaleTaxBreakdown(
              item.tax_breakdown,
              taxDiscountRatioDec,
              undefined,
              0,
              undefined,
              minorFactor,
            );
      const taxBreakdown = ownerAllocation
        ? scaleTaxBreakdown(
            scaledBreakdown,
            1,
            ownerAllocation.weights,
            ownerAllocation.index,
            sourceTaxMinor,
            minorFactor,
          )
        : scaleTaxBreakdown(scaledBreakdown, quantityRatio, undefined, 0, undefined, minorFactor);
      const discountedSnapshot = docOut
        ? typeof item.tax_snapshot === 'string'
          ? docOut.snapshotJson
          : docOut.snapshotJson
            ? JSON.parse(docOut.snapshotJson)
            : null
        : item.tax_snapshot;
      const taxSnapshot =
        ownerAllocation || !hasSnapshot || (taxDiscountRatioDec.eq(1) && quantityRatio === 1)
          ? item.tax_snapshot
          : docOut
            ? quantityRatio === 1
              ? discountedSnapshot
              : scaleTaxSnapshots([docOut.snapshotJson], quantityRatio, minorFactor)[0] || null
            : scaleTaxSnapshots(
                [
                  typeof item.tax_snapshot === 'string'
                    ? item.tax_snapshot
                    : JSON.stringify(item.tax_snapshot),
                ],
                taxDiscountRatioDec.mul(quantityRatio),
                minorFactor,
              )[0] || null;
      if (quantity === undefined && taxDiscountRatioDec.eq(1) && !ownerAllocation) return item;
      return {
        ...item,
        ...(quantity === undefined ? {} : { quantity }),
        subtotal: Number((Number(item.subtotal) * quantityRatio).toFixed(decimals)),
        tax_amount: taxMinor / minorFactor,
        tax_breakdown: taxBreakdown,
        tax_snapshot: taxSnapshot,
        total: Number((Number(item.total) * quantityRatio).toFixed(decimals)),
      };
    });
}

export function childAllocationsForBills(
  bills: any[],
  billItems: any[],
  billId: number,
): Map<number, ChildItemAllocation> {
  const childIds = bills.map((bill) => Number(bill.id));
  const childIdSet = new Set(childIds);
  const index = childIds.indexOf(billId);
  if (index === -1) return new Map();
  const quantities = new Map<number, number[]>();
  for (const row of billItems.filter((row) => childIdSet.has(Number(row.bill_id)))) {
    const itemId = Number(row.order_item_id);
    const weights = quantities.get(itemId) || new Array(childIds.length).fill(0);
    weights[childIds.indexOf(Number(row.bill_id))] = Number(row.quantity);
    quantities.set(itemId, weights);
  }
  return new Map(
    Array.from(quantities.entries()).map(([itemId, weights]) => [itemId, { weights, index }]),
  );
}

export function getPersistedChildTaxBreakdowns(
  sourceRaw: unknown,
  sourceItems: any[],
): Map<number, any> {
  const parsed = parseTaxSnapshot(sourceRaw);
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) return new Map();
  const result = new Map<number, any>();
  let itemIndex = 0;
  for (const breakdown of parsed) {
    while (itemIndex < sourceItems.length) {
      const item = sourceItems[itemIndex++];
      if (['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(item.status)) continue;
      const itemBreakdown = parseTaxSnapshot(item.tax_breakdown);
      if (!Array.isArray(itemBreakdown) || itemBreakdown.length === 0) continue;
      result.set(Number(item.id), breakdown);
      break;
    }
  }
  return result;
}

export function taxBreakdownMinorTotal(raw: unknown, minorFactor = 100): number {
  const parsed = parseTaxSnapshot(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.reduce((sum, entry) => {
    if (Array.isArray(entry)) return sum + taxBreakdownMinorTotal(entry, minorFactor);
    const amount = Number((entry as any)?.amount);
    return Number.isFinite(amount) ? sum + Math.round(amount * minorFactor) : sum;
  }, 0);
}

export function applyPersistedChildTaxBreakdowns(
  projectedItems: any[],
  sourceItems: any[],
  sourceRaw: unknown,
  minorFactor = 100,
): any[] {
  const childBreakdowns = getPersistedChildTaxBreakdowns(sourceRaw, sourceItems);
  if (childBreakdowns.size === 0) return projectedItems;
  return projectedItems.map((item) => {
    if (hasSnapshotLines(item.tax_snapshot)) return item;
    const breakdown = childBreakdowns.get(Number(item.id));
    if (breakdown === undefined) return item;
    return {
      ...item,
      tax_breakdown: [breakdown],
      tax_amount: taxBreakdownMinorTotal(breakdown, minorFactor) / minorFactor,
    };
  });
}

function selectRowsByIds<T>(
  db: ReturnType<typeof getDatabase>,
  ids: any[],
  queryForCount: (count: number) => string,
): T[] {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    rows.push(...(db.prepare(queryForCount(chunk.length)).all(...chunk) as T[]));
  }
  return rows;
}

export function getOrdersWithItemsForBills(
  db: ReturnType<typeof getDatabase>,
  bills: any[],
): Map<number, any> {
  const result = new Map<number, any>();
  if (bills.length === 0) return result;
  const orderIds = Array.from(new Set(bills.map((bill) => Number(bill.order_id))));
  const orderRows = selectRowsByIds<any>(
    db,
    orderIds,
    (count) => `SELECT * FROM orders WHERE id IN (${new Array(count).fill('?').join(',')})`,
  );
  const orders = new Map(orderRows.map((row) => [Number(row.id), parseRowJson(row)]));
  const itemRows = selectRowsByIds<any>(
    db,
    orderIds,
    (count) =>
      `SELECT * FROM order_items WHERE order_id IN (${new Array(count).fill('?').join(',')}) ORDER BY id`,
  );
  const itemsByOrder = new Map<number, any[]>();
  for (const item of itemRows) {
    const items = itemsByOrder.get(Number(item.order_id)) || [];
    items.push(item);
    itemsByOrder.set(Number(item.order_id), items);
  }

  const billIds = bills.map((bill) => Number(bill.id));
  const reportBillItems = selectRowsByIds<any>(
    db,
    billIds,
    (count) =>
      `SELECT bill_id, order_item_id, quantity FROM bill_items WHERE bill_id IN (${new Array(count).fill('?').join(',')})`,
  );
  const splitGroupIds = Array.from(
    new Set(bills.map((bill) => bill.split_group_id).filter(Boolean)),
  );
  const siblingBills =
    splitGroupIds.length === 0
      ? []
      : selectRowsByIds<any>(
          db,
          splitGroupIds,
          (count) =>
            `SELECT id, order_id, split_group_id FROM bills WHERE split_group_id IN (${new Array(count).fill('?').join(',')}) ORDER BY split_group_id, id`,
        );
  const allBillIds = Array.from(
    new Set([...billIds, ...siblingBills.map((bill) => Number(bill.id))]),
  );
  const allBillItems = selectRowsByIds<any>(
    db,
    allBillIds,
    (count) =>
      `SELECT bill_id, order_item_id, quantity FROM bill_items WHERE bill_id IN (${new Array(count).fill('?').join(',')})`,
  );
  const billItemsByBill = new Map<number, any[]>();
  for (const row of reportBillItems) {
    const rows = billItemsByBill.get(Number(row.bill_id)) || [];
    rows.push(row);
    billItemsByBill.set(Number(row.bill_id), rows);
  }
  const siblingsByGroup = new Map<string, any[]>();
  for (const bill of siblingBills) {
    const groupBills = siblingsByGroup.get(String(bill.split_group_id)) || [];
    groupBills.push(bill);
    siblingsByGroup.set(String(bill.split_group_id), groupBills);
  }

  const projected = new Map<number, any>();
  const addonItems = new Map<number, any>();
  const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  for (const bill of bills) {
    const order = orders.get(Number(bill.order_id));
    if (!order) continue;
    const groupBills = bill.split_group_id
      ? siblingsByGroup.get(String(bill.split_group_id)) || []
      : [];
    const allocations = billItemsByBill.get(Number(bill.id)) || [];
    const itemAllocations =
      groupBills.length > 0
        ? childAllocationsForBills(groupBills, allBillItems, Number(bill.id))
        : new Map<number, ChildItemAllocation>();
    const rawItems = itemsByOrder.get(Number(bill.order_id)) || [];
    const projectedItems = projectOrderItems(
      order,
      rawItems,
      allocations,
      itemAllocations,
      minorFactor,
    );
    const items = applyPersistedChildTaxBreakdowns(
      projectedItems,
      rawItems,
      bill.tax_breakdown,
      minorFactor,
    ).map(parseItemJson);
    items.forEach((item) => addonItems.set(Number(item.id), item));
    projected.set(Number(bill.id), { ...order, items });
  }
  const hydratedAddons = attachEffectiveAddons(db, Array.from(addonItems.values()));
  const addonsByItem = new Map(hydratedAddons.map((item) => [Number(item.id), item.addons]));
  for (const [billId, order] of projected) {
    order.items = order.items.map((item: any) => ({
      ...item,
      addons: addonsByItem.get(Number(item.id)) || [],
    }));
    result.set(billId, order);
  }
  return result;
}
