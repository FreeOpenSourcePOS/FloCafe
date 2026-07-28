import Decimal from 'decimal.js';

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
  items?: Array<TaxSource & { status?: string | null }>;
}

interface DecimalTaxComponent {
  title: string;
  rate: string | null;
  amount: Decimal;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decimalOrNull(value: unknown): Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

function flattenSnapshots(
  value: unknown,
  onlyChargeSnapshots = false,
): { present: boolean; components: DecimalTaxComponent[] } {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => flattenSnapshots(entry, onlyChargeSnapshots));
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

  const components: DecimalTaxComponent[] = [];
  for (const line of snapshot.lines) {
    if (!line || typeof line !== 'object') continue;
    const lineComponents = (line as Record<string, unknown>).components;
    if (!Array.isArray(lineComponents)) continue;
    for (const component of lineComponents) {
      if (!component || typeof component !== 'object') continue;
      const raw = component as Record<string, unknown>;
      const amount = decimalOrNull(raw.amount);
      if (!amount) continue;
      const rate = decimalOrNull(raw.rate);
      components.push({
        title: String(raw.label || raw.title || raw.name || raw.ruleId || 'Tax'),
        rate: rate?.toString() ?? null,
        amount,
      });
    }
  }
  return { present: true, components };
}

function flattenLegacyBreakdown(value: unknown): DecimalTaxComponent[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const components: DecimalTaxComponent[] = [];
  for (const entry of parsed) {
    if (Array.isArray(entry)) {
      components.push(...flattenLegacyBreakdown(entry));
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const amount = decimalOrNull(raw.amount);
    if (!amount) continue;
    const rate = decimalOrNull(raw.rate);
    components.push({
      title: String(raw.title || raw.name || 'Tax'),
      rate: rate?.toString() ?? null,
      amount,
    });
  }
  return components;
}

function mergeComponents(components: DecimalTaxComponent[]): DisplayTaxComponent[] {
  const merged = new Map<string, DecimalTaxComponent>();
  for (const component of components) {
    const key = `${component.title}\u0000${component.rate ?? ''}`;
    const current = merged.get(key);
    if (current) {
      current.amount = current.amount.plus(component.amount);
    } else {
      merged.set(key, { ...component });
    }
  }

  return Array.from(merged.values()).map((component) => ({
    title: component.title,
    rate: component.rate === null ? null : new Decimal(component.rate).toNumber(),
    amount: component.amount.toDecimalPlaces(6).toNumber(),
  }));
}

function reconcileTotal(
  components: DisplayTaxComponent[],
  targetValue: unknown,
): DisplayTaxComponent[] {
  const target = decimalOrNull(targetValue);
  if (!target) return components;
  if (components.length === 0) {
    return target.isZero() ? [] : [{ title: 'Tax', rate: null, amount: target.toDecimalPlaces(6).toNumber() }];
  }
  const current = components.reduce(
    (sum, component) => sum.plus(component.amount),
    new Decimal(0),
  );
  if (current.equals(target)) return components;
  if (current.isZero()) {
    return target.isZero() ? components : [{ title: 'Tax', rate: null, amount: target.toDecimalPlaces(6).toNumber() }];
  }

  const ratio = target.dividedBy(current);
  const reconciled = components.map((component) => ({
    ...component,
    amount: new Decimal(component.amount).times(ratio).toDecimalPlaces(6).toNumber(),
  }));
  const allocated = reconciled.reduce(
    (sum, component) => sum.plus(component.amount),
    new Decimal(0),
  );
  reconciled[reconciled.length - 1].amount = new Decimal(
    reconciled[reconciled.length - 1].amount,
  ).plus(target.minus(allocated)).toDecimalPlaces(6).toNumber();
  return reconciled;
}

/**
 * Resolves receipt/report tax components without double-counting mixed orders.
 * A valid item snapshot (including an exempt snapshot with zero components)
 * is authoritative for that item; uncategorized items retain their legacy
 * tax_breakdown. Document-level data is used only when item rows are absent.
 */
export function resolveTaxComponents(document: TaxDocument): DisplayTaxComponent[] {
  const activeItems = document.items?.filter(
    (item) => item.status !== 'cancelled' && item.status !== 'voided',
  );

  if (activeItems && activeItems.length > 0) {
    const components: DecimalTaxComponent[] = [];
    let hasItemTaxEvidence = false;
    let hasSnapshotEvidence = false;
    for (const item of activeItems) {
      const snapshot = flattenSnapshots(item.tax_snapshot);
      const legacy = snapshot.present ? [] : flattenLegacyBreakdown(item.tax_breakdown);
      hasSnapshotEvidence ||= snapshot.present;
      hasItemTaxEvidence ||= snapshot.present || legacy.length > 0;
      components.push(...(snapshot.present ? snapshot.components : legacy));
    }
    if (hasItemTaxEvidence) {
      const chargeSnapshot = flattenSnapshots(document.tax_snapshot, true);
      if (!hasSnapshotEvidence && !chargeSnapshot.present) {
        const documentLegacy = flattenLegacyBreakdown(document.tax_breakdown);
        if (documentLegacy.length > 0) return mergeComponents(documentLegacy);
      }
      if (chargeSnapshot.present) {
        const chargeComponents = mergeComponents(chargeSnapshot.components);
        const chargeTotal = chargeComponents.reduce(
          (sum, component) => sum.plus(component.amount),
          new Decimal(0),
        );
        const documentTotal = decimalOrNull(document.tax_amount);
        const itemTarget = documentTotal ? documentTotal.minus(chargeTotal).toString() : undefined;
        return mergeComponents([
          ...reconcileTotal(mergeComponents(components), itemTarget),
          ...chargeComponents,
        ].map((component) => ({
          title: component.title,
          rate: component.rate === null ? null : new Decimal(component.rate).toString(),
          amount: new Decimal(component.amount),
        })));
      }
      return reconcileTotal(mergeComponents(components), document.tax_amount);
    }
  }

  const snapshot = flattenSnapshots(document.tax_snapshot);
  const components = mergeComponents(
    snapshot.present ? snapshot.components : flattenLegacyBreakdown(document.tax_breakdown),
  );
  return reconcileTotal(
    components,
    snapshot.present || components.length === 0 ? document.tax_amount : undefined,
  );
}

export function aggregateTaxComponents(
  documents: TaxDocument[],
): DisplayTaxComponent[] {
  const components: DecimalTaxComponent[] = [];
  for (const document of documents) {
    for (const component of resolveTaxComponents(document)) {
      components.push({
        title: component.title,
        rate: component.rate === null ? null : new Decimal(component.rate).toString(),
        amount: new Decimal(component.amount),
      });
    }
  }
  return mergeComponents(components);
}
