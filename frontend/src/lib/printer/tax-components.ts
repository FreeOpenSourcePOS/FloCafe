import type { Bill, Order } from '@/lib/types';

export interface DisplayTaxComponent {
  title: string;
  rate: number | null;
  amount: number;
}

interface TaxSource {
  tax_snapshot?: unknown;
  tax_breakdown?: unknown;
}

interface TaxDocument extends TaxSource {
  tax_amount?: unknown;
  order?: { items?: Array<TaxSource & { status?: string | null }> };
  items?: Array<TaxSource & { status?: string | null }>;
}

const SPLIT_TAX_SNAPSHOT_VERSION = 'minor-unit-v1';

export function preferChildScopedBill(bill: Bill, fallbackOrder?: Order): Bill {
  if (bill.order || !fallbackOrder) return bill;
  return { ...bill, order: fallbackOrder };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hasSplitAllocatedSnapshot(value: unknown): boolean {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed.some(hasSplitAllocatedSnapshot);
  if (!parsed || typeof parsed !== 'object') return false;
  const snapshot = parsed as Record<string, unknown>;
  return snapshot.splitAllocation === SPLIT_TAX_SNAPSHOT_VERSION
    && Array.isArray(snapshot.lines);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function snapshotComponents(
  value: unknown,
  onlyChargeSnapshots = false,
): { present: boolean; components: DisplayTaxComponent[] } {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => snapshotComponents(entry, onlyChargeSnapshots));
    return {
      present: results.some((result) => result.present),
      components: results.flatMap((result) => result.components),
    };
  }
  if (!parsed || typeof parsed !== 'object') return { present: false, components: [] };
  const snapshot = parsed as Record<string, unknown>;
  if (!Array.isArray(snapshot.lines)) return { present: false, components: [] };
  if (onlyChargeSnapshots && typeof snapshot.chargeKind !== 'string') {
    return { present: false, components: [] };
  }

  const components: DisplayTaxComponent[] = [];
  for (const line of snapshot.lines) {
    if (!line || typeof line !== 'object') continue;
    const lineComponents = (line as Record<string, unknown>).components;
    if (!Array.isArray(lineComponents)) continue;
    for (const component of lineComponents) {
      if (!component || typeof component !== 'object') continue;
      const raw = component as Record<string, unknown>;
      const amount = finiteNumber(raw.amount);
      if (amount === null) continue;
      components.push({
        title: String(raw.label || raw.title || raw.name || raw.ruleId || 'Tax'),
        rate: finiteNumber(raw.rate),
        amount,
      });
    }
  }
  return { present: true, components };
}

function legacyComponents(value: unknown): DisplayTaxComponent[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const components: DisplayTaxComponent[] = [];
  for (const entry of parsed) {
    if (Array.isArray(entry)) {
      components.push(...legacyComponents(entry));
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const amount = finiteNumber(raw.amount);
    if (amount === null) continue;
    components.push({
      title: String(raw.title || raw.name || 'Tax'),
      rate: finiteNumber(raw.rate),
      amount,
    });
  }
  return components;
}

function reconcileSplitSnapshotComponents(
  components: DisplayTaxComponent[],
  targetValue: unknown,
): DisplayTaxComponent[] {
  const target = finiteNumber(targetValue);
  let result = components.map((component) => ({
    ...component,
    amount: Math.round(component.amount * 1_000_000) / 1_000_000,
  }));
  if (target === null) return result;
  if (result.length === 0) return target === 0 ? [] : [{ title: 'Tax', rate: null, amount: target }];

  const current = result.reduce((sum, component) => sum + component.amount, 0);
  if (Math.abs(current - target) > 0.0000001) {
    if (current === 0) return target === 0 ? result : [{ title: 'Tax', rate: null, amount: target }];
    const ratio = target / current;
    result = result.map((component) => ({
      ...component,
      amount: Math.round(component.amount * ratio * 1_000_000) / 1_000_000,
    }));
    const allocated = result.reduce((sum, component) => sum + component.amount, 0);
    result[result.length - 1].amount = Math.round(
      (result[result.length - 1].amount + target - allocated) * 1_000_000,
    ) / 1_000_000;
  }
  return result;
}

function legacyItemComponents(items: Array<TaxSource & { status?: string | null }> | undefined): DisplayTaxComponent[] {
  return (items || []).filter(
    (item) => item.status !== 'cancelled' && item.status !== 'voided' && item.status !== 'void_adjustment',
  ).flatMap((item) => {
    const snapshot = snapshotComponents(item.tax_snapshot);
    return snapshot.present ? [] : legacyComponents(item.tax_breakdown);
  });
}

function documentLegacyComponents(document: TaxDocument): DisplayTaxComponent[] {
  const remainingItems = new Map<string, number>();
  for (const component of legacyItemComponents(document.order?.items ?? document.items)) {
    const key = `${component.title}\u0000${component.rate ?? ''}`;
    remainingItems.set(key, (remainingItems.get(key) || 0) + component.amount);
  }
  return legacyComponents(document.tax_breakdown).flatMap((component) => {
    const key = `${component.title}\u0000${component.rate ?? ''}`;
    const itemAmount = remainingItems.get(key) || 0;
    const sameSign = itemAmount === 0 || component.amount === 0 || Math.sign(itemAmount) === Math.sign(component.amount);
    const consumed = sameSign ? Math.min(Math.abs(itemAmount), Math.abs(component.amount)) * Math.sign(component.amount) : 0;
    const residual = component.amount - consumed;
    remainingItems.set(key, itemAmount - consumed);
    return Math.abs(residual) < 0.0000001 ? [] : [{ ...component, amount: residual }];
  });
}

export function resolveTaxComponents(document: TaxDocument): DisplayTaxComponent[] {
  // A split bill carries child-specific snapshot amounts. The order-item rows
  // are shared by every child and retain source-order amounts, so using them
  // here would misattribute item tax against the full charge-tax snapshot.
  if (hasSplitAllocatedSnapshot(document.tax_snapshot)) {
    const splitSnapshot = snapshotComponents(document.tax_snapshot);
    if (splitSnapshot.present) {
      const merged = new Map<string, DisplayTaxComponent>();
      for (const component of [
        ...splitSnapshot.components,
        ...legacyItemComponents(document.order?.items ?? document.items),
        ...documentLegacyComponents(document),
      ]) {
        const key = `${component.title}\u0000${component.rate ?? ''}`;
        const current = merged.get(key);
        if (current) current.amount += component.amount;
        else merged.set(key, { ...component });
      }
      return reconcileSplitSnapshotComponents(Array.from(merged.values()), document.tax_amount);
    }
  }

  const items = document.order?.items ?? document.items;
  const activeItems = items?.filter(
    (item) => item.status !== 'cancelled' && item.status !== 'voided' && item.status !== 'void_adjustment',
  );
  const components: DisplayTaxComponent[] = [];
  let usedSnapshot = false;
  let chargeReconciledSeparately = false;

  if (activeItems && activeItems.length > 0) {
    let hasItemTaxEvidence = false;
    for (const item of activeItems) {
      const snapshot = snapshotComponents(item.tax_snapshot);
      const legacy = snapshot.present ? [] : legacyComponents(item.tax_breakdown);
      usedSnapshot ||= snapshot.present;
      hasItemTaxEvidence ||= snapshot.present || legacy.length > 0;
      components.push(...(snapshot.present ? snapshot.components : legacy));
    }
    if (!hasItemTaxEvidence) {
      const snapshot = snapshotComponents(document.tax_snapshot);
      usedSnapshot = snapshot.present;
      components.push(
        ...(snapshot.present ? snapshot.components : legacyComponents(document.tax_breakdown)),
      );
    } else {
      const chargeSnapshot = snapshotComponents(document.tax_snapshot, true);
      if (chargeSnapshot.present) {
        const target = finiteNumber(document.tax_amount);
        const chargeTotal = chargeSnapshot.components.reduce(
          (sum, component) => sum + component.amount,
          0,
        );
        const itemTotal = components.reduce((sum, component) => sum + component.amount, 0);
        if (target !== null && itemTotal !== 0) {
          const ratio = (target - chargeTotal) / itemTotal;
          for (const component of components) {
            component.amount = Math.round(component.amount * ratio * 1_000_000) / 1_000_000;
          }
          const allocated = components.reduce((sum, component) => sum + component.amount, 0);
          components[components.length - 1].amount = Math.round(
            (components[components.length - 1].amount + target - chargeTotal - allocated) * 1_000_000,
          ) / 1_000_000;
        }
        components.push(...chargeSnapshot.components);
        chargeReconciledSeparately = true;
      } else if (!usedSnapshot) {
        const documentLegacy = legacyComponents(document.tax_breakdown);
        if (documentLegacy.length > 0) components.splice(0, components.length, ...documentLegacy);
      }
    }
  } else {
    const snapshot = snapshotComponents(document.tax_snapshot);
    usedSnapshot = snapshot.present;
    components.push(
      ...(snapshot.present ? snapshot.components : legacyComponents(document.tax_breakdown)),
    );
  }

  const merged = new Map<string, DisplayTaxComponent>();
  for (const component of components) {
    const key = `${component.title}\u0000${component.rate ?? ''}`;
    const current = merged.get(key);
    if (current) current.amount += component.amount;
    else merged.set(key, { ...component });
  }
  let result = Array.from(merged.values()).map((component) => ({
    ...component,
    amount: Math.round(component.amount * 1_000_000) / 1_000_000,
  }));

  const target = finiteNumber(document.tax_amount);
  if (usedSnapshot && !chargeReconciledSeparately && target !== null && result.length > 0) {
    const current = result.reduce((sum, component) => sum + component.amount, 0);
    if (current !== 0 && Math.abs(current - target) > 0.0000001) {
      const ratio = target / current;
      result = result.map((component) => ({
        ...component,
        amount: Math.round(component.amount * ratio * 1_000_000) / 1_000_000,
      }));
      const allocated = result.reduce((sum, component) => sum + component.amount, 0);
      result[result.length - 1].amount = Math.round(
        (result[result.length - 1].amount + target - allocated) * 1_000_000,
      ) / 1_000_000;
    }
  }
  if (result.length === 0 && target !== null && target !== 0) {
    return [{ title: 'Tax', rate: null, amount: target }];
  }
  return result;
}

export function formatTaxComponentLabel(component: DisplayTaxComponent): string {
  return component.rate === null
    ? component.title
    : `${component.title} @${component.rate}%`;
}
