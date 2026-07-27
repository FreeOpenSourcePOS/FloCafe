import Decimal from 'decimal.js';
import { getDatabase } from '../db';
import { getBundledCountryPack } from '../tax-packs/bundled';

interface TenantInfo {
  country: string;
  business_type: string;
  state_code: string;
}

interface Product {
  id?: string | number;
  tax_type: string;
  tax_rate: number;
  tax_category?: string;
  tax_category_id?: string;
  tax_behavior?: 'country_default' | 'inclusive' | 'exclusive' | 'exempt';
}

interface Customer {
  gstin?: string;
  customer_state_code?: string;
}

interface TaxResult {
  tax_amount: number;
  tax_breakdown: TaxBreakdown[];
  tax_type: string;
  tax_snapshot?: Record<string, unknown> | null;
}

export interface TaxBreakdown {
  title: string;
  rate: number;
  amount: number;
}

export type ChargeTaxKind = 'packaging' | 'delivery' | 'service_charge';

export interface ChargeTaxCategorySelection {
  categoryId: string;
  overrideId?: string;
}

export interface ChargeTaxContext {
  packaging_charge?: number | string | null;
  delivery_charge?: number | string | null;
  service_charge?: number | string | null;
  packaging_tax_category_id?: string | null;
  delivery_tax_category_id?: string | null;
  service_charge_tax_category_id?: string | null;
}

export interface ChargeTaxSummary {
  taxAmount: number;
  exclusiveTaxAmount: number;
  breakdowns: TaxBreakdown[][];
  snapshotJson: string[];
}

export interface TaxRollup {
  taxAmount: number;
  exclusiveTaxAmount: number;
  breakdowns: TaxBreakdown[][];
  snapshotJson: string | null;
}

import { TaxEngine } from './tax-engine';
import type { CountryPack } from '../tax-packs/types';

function round(value: number, decimals: number = 2): number {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

// Same country -> bundled-pack selection used by calculateItemTax below and
// by the GET /api/tax/categories endpoint (routes/index.ts) — kept as one
// function so the two never drift apart on which pack is "active".
export function getActiveCountryPack(country: string): CountryPack {
  try {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT version.pack_json
      FROM country_packs AS pack
      JOIN country_pack_versions AS version ON version.id = pack.active_version_id
      WHERE pack.country IN (?, '*') AND pack.status = 'active'
      ORDER BY CASE WHEN pack.country = ? THEN 0 ELSE 1 END, pack.updated_at DESC
      LIMIT 1
    `).get(country, country) as { pack_json: string } | undefined;
    if (row) return JSON.parse(row.pack_json) as CountryPack;
  } catch {
    // Database initialization and isolated unit tests can call this before the
    // migration runner has registered bundled packs. The immutable bundled
    // JSON remains the required offline fallback.
  }
  return getBundledCountryPack(country);
}

export function hasConfiguredTaxCategories(pack: CountryPack, businessType: string): boolean {
  return pack.categories.some((category) => category.ruleIds.some((ruleId) => {
    const rule = pack.rules.find((candidate) => candidate.id === ruleId);
    return Boolean(rule
      && (!rule.conditions?.businessTypes || rule.conditions.businessTypes.includes(businessType)));
  }));
}

export function calculateItemTax(
  tenant: TenantInfo,
  product: Product,
  taxableAmount: number,
  customer: Customer | null
): TaxResult {
  const taxCategoryId = product.tax_category_id || product.tax_category;
  const pack = getActiveCountryPack(tenant.country);
  let merchantOverride: { id: string; categoryId: string } | null = null;
  if (product.id !== undefined && product.id !== null) {
    try {
      const db = getDatabase();
      const row = db.prepare(`
        SELECT override.id, override.value_json
        FROM tax_overrides AS override
        JOIN country_packs AS pack ON pack.active_version_id = override.pack_version_id
        WHERE pack.id = ?
          AND override.entity_type = 'product'
          AND override.entity_id = ?
          AND override.field_name = 'tax_category_id'
        ORDER BY override.updated_at DESC
        LIMIT 1
      `).get(pack.id, String(product.id)) as { id: string; value_json: string } | undefined;
      if (row) {
        const value = JSON.parse(row.value_json);
        const categoryId = typeof value === 'string' ? value : value?.categoryId;
        if (typeof categoryId === 'string' && categoryId) {
          merchantOverride = { id: row.id, categoryId };
        }
      }
    } catch {
      // An unavailable override table is possible only before migrations or
      // in isolated unit tests; normal checkout databases always have it.
    }
  }

  if (taxCategoryId || merchantOverride) {
    let calculation;
    try {
      calculation = TaxEngine.calculate({
        pack,
        country: tenant.country,
        businessType: tenant.business_type,
        storeStateCode: tenant.state_code,
        transactionDate: new Date().toISOString(),
        customer: customer
          ? {
            registrationNumber: customer.gstin,
            stateCode: customer.customer_state_code,
          }
          : null,
        lines: [{
          lineId: 'legacy-item-adapter',
          kind: 'product',
          quantity: '1',
          unitPrice: String(taxableAmount),
          merchantCategoryId: merchantOverride?.categoryId,
          productCategoryId: taxCategoryId,
          taxBehavior: product.tax_behavior || 'country_default',
        }],
      });
    } catch (engineError: any) {
      // A misconfigured category/pack is a data problem, not a server bug —
      // checkout must block loudly on a bad tax config, never fall through
      // to charging zero tax. statusCode lets route handlers return 400
      // instead of a generic 500 (see orders.ts / index.ts catch blocks).
      throw Object.assign(
        new Error(`Tax calculation failed: ${engineError.message}`),
        { statusCode: 400 },
      );
    }
    const line = calculation.lines[0];
    if (line.taxBehavior !== 'exempt' && line.components.length === 0) {
      throw Object.assign(
        new Error(`Tax calculation failed: no tax rules apply to category ${line.categoryId} for business type ${tenant.business_type}`),
        { statusCode: 400 },
      );
    }
    return {
      tax_amount: Number(line.taxAmount),
      tax_breakdown: line.components.map((component) => ({
        title: component.label,
        rate: Number(component.rate || 0),
        amount: Number(component.amount),
      })),
      // The engine resolves country_default against the active pack. Persist
      // that effective behavior on the order item so every later total
      // recomputation knows whether the tax is already included in the price.
      tax_type: line.taxBehavior === 'exempt' ? 'none' : line.taxBehavior,
      tax_snapshot: {
        ...calculation.snapshot,
        merchantOverridesApplied: merchantOverride ? [{
          overrideId: merchantOverride.id,
          entityType: 'product',
          entityId: String(product.id),
          fieldName: 'tax_category_id',
          categoryId: merchantOverride.categoryId,
        }] : [],
      },
    };
  }

  // Tax is opt-in through a resolved category. Legacy product.tax_type and
  // product.tax_rate columns remain in the schema only for non-destructive
  // upgrade compatibility; they are not authoritative for new transactions.
  return { tax_amount: 0, tax_breakdown: [], tax_type: 'none', tax_snapshot: null };
}

const CHARGE_KINDS: ChargeTaxKind[] = ['packaging', 'delivery', 'service_charge'];

export function getConfiguredChargeTaxCategories(
  country: string,
): Partial<Record<ChargeTaxKind, ChargeTaxCategorySelection>> {
  const pack = getActiveCountryPack(country);
  try {
    const rows = getDatabase().prepare(`
      SELECT override.id, override.entity_type, override.value_json
      FROM tax_overrides AS override
      JOIN country_packs AS country_pack
        ON country_pack.active_version_id = override.pack_version_id
      WHERE country_pack.id = ?
        AND override.entity_type IN ('packaging', 'delivery', 'service_charge')
        AND override.entity_id IS NULL
        AND override.field_name = 'tax_category_id'
      ORDER BY override.updated_at DESC
    `).all(pack.id) as Array<{ id: string; entity_type: ChargeTaxKind; value_json: string }>;
    const configured: Partial<Record<ChargeTaxKind, ChargeTaxCategorySelection>> = {};
    for (const row of rows) {
      if (configured[row.entity_type]) continue;
      try {
        const value = JSON.parse(row.value_json);
        const categoryId = typeof value === 'string' ? value : value?.categoryId;
        if (typeof categoryId === 'string' && categoryId) {
          configured[row.entity_type] = { categoryId, overrideId: row.id };
        }
      } catch { }
    }
    return configured;
  } catch {
    return {};
  }
}

function chargeAmount(context: ChargeTaxContext, kind: ChargeTaxKind): Decimal {
  const amountKey: keyof ChargeTaxContext = kind === 'service_charge'
    ? 'service_charge'
    : `${kind}_charge`;
  const raw = context[amountKey] ?? 0;
  try {
    const amount = new Decimal(raw as Decimal.Value);
    if (!amount.isFinite() || amount.isNegative()) {
      throw new Error(`${kind} charge must be a non-negative finite amount`);
    }
    return amount;
  } catch (error: any) {
    throw Object.assign(new Error(error.message || `${kind} charge is invalid`), { statusCode: 400 });
  }
}

function chargeCategoryId(context: ChargeTaxContext, kind: ChargeTaxKind): string | null {
  const value = context[`${kind}_tax_category_id` as keyof ChargeTaxContext];
  return typeof value === 'string' && value ? value : null;
}

export function calculateConfiguredChargeTaxes(
  tenant: TenantInfo,
  context: ChargeTaxContext,
  customer: Customer | null,
): ChargeTaxSummary {
  const pack = getActiveCountryPack(tenant.country);
  const breakdowns: TaxBreakdown[][] = [];
  const snapshotJson: string[] = [];
  let taxAmount = new Decimal(0);
  let exclusiveTaxAmount = new Decimal(0);

  for (const kind of CHARGE_KINDS) {
    const amount = chargeAmount(context, kind);
    const categoryId = chargeCategoryId(context, kind);
    // NULL means this order remains on the legacy path. Charges were
    // previously added untaxed, so preserve that behavior until the merchant
    // explicitly migrates this charge kind in Settings.
    if (amount.isZero() || !categoryId) continue;

    let calculation;
    try {
      calculation = TaxEngine.calculate({
        pack,
        country: tenant.country,
        businessType: tenant.business_type,
        storeStateCode: tenant.state_code,
        transactionDate: new Date().toISOString(),
        customer: customer
          ? {
            registrationNumber: customer.gstin,
            stateCode: customer.customer_state_code,
          }
          : null,
        lines: [{
          lineId: `charge:${kind}`,
          kind,
          quantity: '1',
          unitPrice: amount.toString(),
          merchantCategoryId: categoryId,
          taxBehavior: 'country_default',
        }],
      });
    } catch (engineError: any) {
      throw Object.assign(
        new Error(`Tax calculation failed for ${kind}: ${engineError.message}`),
        { statusCode: 400 },
      );
    }

    const line = calculation.lines[0];
    if (line.taxBehavior !== 'exempt' && line.components.length === 0) {
      throw Object.assign(
        new Error(`Tax calculation failed: no tax rules apply to ${kind} category ${line.categoryId}`),
        { statusCode: 400 },
      );
    }
    const lineTax = new Decimal(line.taxAmount);
    taxAmount = taxAmount.plus(lineTax);
    if (line.taxBehavior !== 'inclusive') exclusiveTaxAmount = exclusiveTaxAmount.plus(lineTax);
    breakdowns.push(line.components.map((component) => ({
      title: component.label,
      rate: Number(component.rate || 0),
      amount: Number(component.amount),
    })));
    snapshotJson.push(JSON.stringify({
      ...calculation.snapshot,
      chargeKind: kind,
      configuredCategoryId: categoryId,
    }));
  }

  return {
    taxAmount: taxAmount.toNumber(),
    exclusiveTaxAmount: exclusiveTaxAmount.toNumber(),
    breakdowns,
    snapshotJson,
  };
}

export function aggregateTaxBreakdown(itemBreakdowns: any[]): TaxBreakdown[] {
  const merged: Record<string, TaxBreakdown> = {};

  for (const breakdown of itemBreakdowns) {
    if (!Array.isArray(breakdown)) continue;
    for (const line of breakdown) {
      const key = `${line.title}_${line.rate}`;
      if (!merged[key]) {
        merged[key] = { title: line.title, rate: line.rate, amount: 0 };
      }
      merged[key].amount += line.amount;
    }
  }

  return Object.values(merged).map((line) => ({
    ...line,
    amount: round(line.amount, 2),
  }));
}

// Rolls up whichever active order_items carry a per-item engine snapshot
// (order_items.tax_snapshot, only present for category-driven items — see
// calculateItemTax above) into the order/bill-level tax_snapshot column.
// Uncategorized items are tax-free and therefore have no snapshot to roll up.
export function aggregateTaxSnapshots(itemSnapshotsJson: (string | null | undefined)[]): string | null {
  const snapshots = itemSnapshotsJson
    .map((raw) => {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    })
    .filter((snapshot) => snapshot !== null);

  return snapshots.length > 0 ? JSON.stringify(snapshots) : null;
}

// A prepared-item void is represented by a new negative order_item. Mirror
// the immutable tax evidence with signed amounts as well, otherwise the
// order-level snapshot would still claim positive tax after the rows net to 0.
export function invertTaxSnapshot(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const snapshot = JSON.parse(raw);
    if (!snapshot || !Array.isArray(snapshot.lines)) return null;
    const negate = (value: unknown) => {
      if (typeof value !== 'string' && typeof value !== 'number') return value;
      return new Decimal(value).negated().toString();
    };
    snapshot.lines = snapshot.lines.map((line: any) => ({
      ...line,
      lineId: `${line.lineId}:void-adjustment`,
      grossAmount: negate(line.grossAmount),
      taxableBase: negate(line.taxableBase),
      taxAmount: negate(line.taxAmount),
      components: Array.isArray(line.components)
        ? line.components.map((component: any) => ({
          ...component,
          amount: negate(component.amount),
          roundingRemainder: negate(component.roundingRemainder),
        }))
        : line.components,
    }));
    return JSON.stringify(snapshot);
  } catch {
    return null;
  }
}

export function invertTaxBreakdown(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const breakdown = JSON.parse(raw);
    if (!Array.isArray(breakdown)) return null;
    return JSON.stringify(breakdown.map((component: any) => ({
      ...component,
      amount: new Decimal(component.amount || 0).negated().toNumber(),
    })));
  } catch {
    return null;
  }
}

export function scaleTaxBreakdowns(
  breakdowns: any[],
  ratio: number,
  targetTaxAmount: number,
): any[] {
  const cloned = breakdowns.map((breakdown) => Array.isArray(breakdown)
    ? breakdown.map((component) => ({ ...component }))
    : breakdown);
  const entries: Array<{
    component: any;
    rounded: Decimal;
    remainder: Decimal;
    outerIndex: number;
    innerIndex: number;
  }> = [];
  const scale = new Decimal(ratio);

  cloned.forEach((breakdown, outerIndex) => {
    if (!Array.isArray(breakdown)) return;
    breakdown.forEach((component: any, innerIndex: number) => {
      const rawAmount = new Decimal(component.amount || 0).mul(scale);
      const rounded = rawAmount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      entries.push({
        component,
        rounded,
        remainder: rawAmount.minus(rounded),
        outerIndex,
        innerIndex,
      });
    });
  });

  if (entries.length === 0) return cloned;
  const roundedTotal = entries.reduce((sum, entry) => sum.plus(entry.rounded), new Decimal(0));
  const centsDelta = new Decimal(targetTaxAmount)
    .minus(roundedTotal)
    .mul(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  const direction = Math.sign(centsDelta);
  const allocationOrder = [...entries].sort((left, right) => {
    const remainderOrder = direction >= 0
      ? right.remainder.comparedTo(left.remainder)
      : left.remainder.comparedTo(right.remainder);
    if (remainderOrder !== 0) return remainderOrder;
    const titleOrder = String(left.component.title || '').localeCompare(String(right.component.title || ''));
    if (titleOrder !== 0) return titleOrder;
    return left.outerIndex - right.outerIndex || left.innerIndex - right.innerIndex;
  });

  for (let index = 0; index < Math.abs(centsDelta); index++) {
    const entry = allocationOrder[index % allocationOrder.length];
    entry.rounded = entry.rounded.plus(direction * 0.01);
  }
  for (const entry of entries) entry.component.amount = entry.rounded.toNumber();
  return cloned;
}

export function scaleTaxSnapshots(
  snapshotsJson: (string | null | undefined)[],
  ratio: number,
): string[] {
  const snapshots = snapshotsJson.flatMap((raw) => {
    if (!raw) return [];
    try {
      const snapshot = JSON.parse(raw);
      return snapshot && Array.isArray(snapshot.lines) ? [snapshot] : [];
    } catch {
      return [];
    }
  });
  const scale = new Decimal(ratio);
  const entries: Array<{
    component: any;
    line: any;
    raw: Decimal;
    rounded: Decimal;
    remainder: Decimal;
  }> = [];

  for (const snapshot of snapshots) {
    for (const line of snapshot.lines) {
      if (!Array.isArray(line.components)) continue;
      for (const component of line.components) {
        const raw = new Decimal(component.amount || 0).mul(scale);
        const rounded = raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        entries.push({ component, line, raw, rounded, remainder: raw.minus(rounded) });
      }
    }
  }

  if (entries.length > 0) {
    const targetTaxAmount = entries.reduce(
      (sum, entry) => sum.plus(new Decimal(entry.component.amount || 0)),
      new Decimal(0),
    ).mul(scale).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const roundedTotal = entries.reduce((sum, entry) => sum.plus(entry.rounded), new Decimal(0));
    const centsDelta = targetTaxAmount
      .minus(roundedTotal)
      .mul(100)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber();
    const direction = Math.sign(centsDelta);
    const ordered = [...entries].sort((left, right) => {
      const remainderOrder = direction >= 0
        ? right.remainder.comparedTo(left.remainder)
        : left.remainder.comparedTo(right.remainder);
      if (remainderOrder !== 0) return remainderOrder;
      const ruleOrder = String(left.component.ruleId || '').localeCompare(String(right.component.ruleId || ''));
      if (ruleOrder !== 0) return ruleOrder;
      return String(left.line.lineId || '').localeCompare(String(right.line.lineId || ''));
    });
    for (let index = 0; index < Math.abs(centsDelta); index += 1) {
      const entry = ordered[index % ordered.length];
      entry.rounded = entry.rounded.plus(direction * 0.01);
    }
    for (const entry of entries) {
      entry.component.amount = entry.rounded.toFixed(2);
      entry.component.roundingRemainder = entry.raw.minus(entry.rounded).toString();
    }
  }

  for (const snapshot of snapshots) {
    for (const line of snapshot.lines) {
      const scaleValue = (value: unknown) => {
        if (typeof value !== 'string' && typeof value !== 'number') return value;
        return new Decimal(value).mul(scale).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
      };
      line.grossAmount = scaleValue(line.grossAmount);
      line.taxableBase = scaleValue(line.taxableBase);
      if (Array.isArray(line.components)) {
        line.taxAmount = line.components.reduce(
          (sum: Decimal, component: any) => sum.plus(component.amount || 0),
          new Decimal(0),
        ).toFixed(2);
      } else {
        line.taxAmount = scaleValue(line.taxAmount);
      }
    }
  }
  return snapshots.map((snapshot) => JSON.stringify(snapshot));
}

export function combineItemAndChargeTaxes(args: {
  itemTaxAmount: number;
  itemExclusiveTaxAmount: number;
  itemBreakdowns: any[];
  itemSnapshots: (string | null | undefined)[];
  itemTaxRatio: number;
  chargeTaxes: ChargeTaxSummary;
}): TaxRollup {
  const scaledBreakdowns = scaleTaxBreakdowns(
    args.itemBreakdowns,
    args.itemTaxRatio,
    args.itemTaxAmount,
  );
  const scaledSnapshots = scaleTaxSnapshots(
    args.itemSnapshots,
    args.itemTaxRatio,
  );
  const nonEmptyBreakdowns = [
    ...scaledBreakdowns,
    ...args.chargeTaxes.breakdowns,
  ].filter((breakdown) => Array.isArray(breakdown) && breakdown.length > 0);
  return {
    taxAmount: new Decimal(args.itemTaxAmount).plus(args.chargeTaxes.taxAmount).toNumber(),
    exclusiveTaxAmount: new Decimal(args.itemExclusiveTaxAmount)
      .plus(args.chargeTaxes.exclusiveTaxAmount)
      .toNumber(),
    breakdowns: nonEmptyBreakdowns,
    snapshotJson: aggregateTaxSnapshots([...scaledSnapshots, ...args.chargeTaxes.snapshotJson]),
  };
}

export function calculateRoundOff(total: number): number {
  const rounded = Math.round(total);
  return round(rounded - total, 2);
}

// Tax preview endpoint handler
export async function calculateTaxPreview(req: any, res: any): Promise<void> {
  try {
    const {
      items,
      customer_id,
      packaging_charge,
      delivery_charge,
      service_charge,
    } = req.body;

    if (!items || items.length === 0) {
      res.status(400).json({ error: 'Items are required' });
      return;
    }

    const db = (await import('../db')).getDatabase();

    // Get settings
    const settings: Record<string, string> = {};
    db.prepare('SELECT key, value FROM settings').all().forEach((row: any) => {
      settings[row.key] = row.value;
    });

    const tenantInfo: TenantInfo = {
      country: settings.country || 'IN',
      business_type: settings.business_type || 'restaurant',
      state_code: settings.state_code || '',
    };

    const customer = customer_id
      ? (db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id) as Customer | undefined)
      : null;

    const itemResults: any[] = [];
    const allBreakdowns: any[] = [];
    let totalSubtotal = 0;
    let totalTax = 0;

    for (const itemData of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(itemData.product_id) as any;
      if (!product) continue;

      const unitPrice = parseFloat(product.price) || 0;
      const quantity = itemData.quantity || 1;
      const itemDiscount = itemData.discount_amount || 0;

      let subtotal = unitPrice * quantity;
      if (itemData.addons) {
        for (const addon of itemData.addons) {
          subtotal += (addon.price || 0) * (addon.quantity || 1) * quantity;
        }
      }
      subtotal = Math.max(0, subtotal - itemDiscount);

      const taxResult = calculateItemTax(tenantInfo, product as Product, subtotal, customer || null);

      itemResults.push({
        product_id: product.id,
        product_name: product.name,
        quantity,
        unit_price: unitPrice,
        subtotal: round(subtotal, 2),
        discount_amount: itemDiscount,
        tax_amount: taxResult.tax_amount,
        tax_breakdown: taxResult.tax_breakdown,
        tax_type: taxResult.tax_type,
        total: round(subtotal + taxResult.tax_amount, 2),
      });

      if (taxResult.tax_breakdown) {
        allBreakdowns.push(taxResult.tax_breakdown);
      }
      totalSubtotal += subtotal;
      totalTax += taxResult.tax_amount;
    }

    const packaging = packaging_charge || 0;
    const delivery = delivery_charge || 0;
    const service = service_charge || 0;
    const chargeCategories = getConfiguredChargeTaxCategories(tenantInfo.country);
    const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, {
      packaging_charge: packaging,
      delivery_charge: delivery,
      service_charge: service,
      packaging_tax_category_id: chargeCategories.packaging?.categoryId || null,
      delivery_tax_category_id: chargeCategories.delivery?.categoryId || null,
      service_charge_tax_category_id: chargeCategories.service_charge?.categoryId || null,
    }, customer || null);
    const aggregatedBreakdown = aggregateTaxBreakdown([
      ...allBreakdowns,
      ...chargeTaxes.breakdowns,
    ]);
    const previewTax = new Decimal(totalTax).plus(chargeTaxes.taxAmount).toNumber();
    // Preserve the legacy preview's item-tax total behavior. Configured charge
    // tax follows its pack behavior, so only exclusive charge tax increases
    // the payable amount.
    const preRoundTotal = totalSubtotal + totalTax + chargeTaxes.exclusiveTaxAmount
      + packaging + delivery + service;
    const roundOff = calculateRoundOff(preRoundTotal);

    res.json({
      items: itemResults,
      summary: {
        subtotal: round(totalSubtotal, 2),
        tax_amount: round(previewTax, 2),
        tax_breakdown: aggregatedBreakdown,
        packaging_charge: packaging,
        delivery_charge: delivery,
        service_charge: service,
        round_off: roundOff,
        total: round(preRoundTotal + roundOff, 2),
      },
    });
  } catch (error: any) {
    console.error('[Tax] Preview error:', error);
    res.status(500).json({ error: "Internal server error" });
  }
}
