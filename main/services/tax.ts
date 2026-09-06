import Decimal from 'decimal.js';
import { getDatabase, getSettingValue } from '../db';
import { getBundledCountryPack } from '../tax-packs/bundled';
import { getCountryByCode, getCurrencyFractionDigits, getCurrencyMinorUnitFactor, type TaxIdFormat } from '../countries';

interface TenantInfo {
  country: string;
  business_type: string;
  state_code: string;
  currency?: string;
  // Passed explicitly by caller to allow isolated unit testing without a database.
  taxes_enabled: boolean;
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
  taxRegistrationNumber?: string;
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

import { TaxEngine, applyPayableRounding } from './tax-engine';
import type { CountryPack, TaxRule } from '../tax-packs/types';

function round(value: number, decimals: number = 2): number {
  if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) return 0;
  return Number(Math.round(Number(value + 'e' + decimals)) + 'e-' + decimals);
}

// Shared helper to retrieve the active country pack for tax calculation and categories API.
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
    // Fall back to immutable bundled pack JSON if DB migrations haven't run.
  }
  return getBundledCountryPack(country);
}

// Checks if taxation is enabled and backed by an official active country pack.
export function isTaxModuleActiveForCountry(country: string): boolean {
  if (getSettingValue('taxes_enabled') !== 'true') return false;
  try {
    return getActiveCountryPack(country).publisher !== 'local';
  } catch {
    return false;
  }
}

export function resolveTaxIdFormat(country: string): TaxIdFormat | null {
  if (!isTaxModuleActiveForCountry(country)) return null;
  return getActiveCountryPack(country).registrationNumberFormat
    || getCountryByCode(country)?.taxIdFormat
    || null;
}

// Bounds input length to 24 chars as a defense-in-depth safeguard against ReDoS backtracking.
export const MAX_TAX_ID_LENGTH = 24;

export function validateTaxRegistrationNumber(
  country: string,
  value: string,
): { valid: boolean; format: TaxIdFormat | null } {
  const format = resolveTaxIdFormat(country);
  if (!format || !value) return { valid: true, format };
  const trimmed = value.trim();
  if (trimmed.length > MAX_TAX_ID_LENGTH) return { valid: false, format };
  let regex: RegExp;
  try {
    regex = new RegExp(format.pattern, 'i');
  } catch {
    return { valid: true, format: null };
  }
  return { valid: regex.test(trimmed), format };
}

// Computes a display-only preview tax rate for UI category pickers.
// Authoritative calculation always goes through TaxEngine.calculate.
export function previewCategoryRate(
  pack: CountryPack,
  businessType: string,
  categoryId: string,
): { percent: number; label: string } | null {
  const category = pack.categories.find((candidate) => candidate.id === categoryId);
  if (!category) return null;
  const ruleById = new Map(pack.rules.map((rule) => [rule.id, rule]));
  const percentRules = category.ruleIds.reduce<TaxRule[]>((acc, ruleId) => {
    const rule = ruleById.get(ruleId);
    if (!rule || rule.type !== 'percent' || !rule.categoryIds.includes(categoryId)) return acc;
    const conditions = rule.conditions;
    if (conditions) {
      if (conditions.businessTypes && !conditions.businessTypes.includes(businessType)) return acc;
      if (conditions.customerStateRelation === 'interstate') return acc;
    }
    acc.push(rule);
    return acc;
  }, []);
  if (percentRules.length === 0) return null;
  const percent = percentRules.reduce((sum, rule) => sum + Number(rule.rate || 0), 0);
  return {
    percent: Math.round(percent * 100) / 100,
    label: percentRules.map((rule) => `${rule.label} ${rule.rate}%`).join(' + '),
  };
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
  if (!tenant.taxes_enabled) {
    return { tax_amount: 0, tax_breakdown: [], tax_type: 'none', tax_snapshot: null };
  }
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
        currency: tenant.currency,
        country: tenant.country,
        businessType: tenant.business_type,
        storeStateCode: tenant.state_code,
        transactionDate: new Date().toISOString(),
        customer: customer
          ? {
            registrationNumber: customer.taxRegistrationNumber,
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
      // Surface tax configuration errors as 400 bad request instead of 500.
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
      // Persist resolved tax behavior on the item so subsequent recalculations know if tax is inclusive.
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

  // Tax is opt-in through resolved categories; legacy columns are not used for new orders.
  return { tax_amount: 0, tax_breakdown: [], tax_type: 'none', tax_snapshot: null };
}

const CHARGE_KINDS: ChargeTaxKind[] = ['packaging', 'delivery', 'service_charge'];

export function getConfiguredChargeTaxCategories(
  country: string,
): Partial<Record<ChargeTaxKind, ChargeTaxCategorySelection>> {
  if (getSettingValue('taxes_enabled') !== 'true') return {};
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

export function normalizeChargeAmount(value: unknown, kind: ChargeTaxKind): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw Object.assign(new Error(`${kind} charge must be a non-negative finite amount`), { statusCode: 400 });
  }
  try {
    const amount = new Decimal(value as Decimal.Value);
    if (!amount.isFinite() || amount.isNegative()) {
      throw new Error(`${kind} charge must be a non-negative finite amount`);
    }
    const numericAmount = amount.toNumber();
    if (!Number.isFinite(numericAmount)) {
      throw new Error(`${kind} charge must be a non-negative finite amount`);
    }
    return numericAmount;
  } catch (error: any) {
    throw Object.assign(new Error(error.message || `${kind} charge is invalid`), { statusCode: 400 });
  }
}

function chargeAmount(context: ChargeTaxContext, kind: ChargeTaxKind): Decimal {
  const amountKey: keyof ChargeTaxContext = kind === 'service_charge'
    ? 'service_charge'
    : `${kind}_charge`;
  return new Decimal(normalizeChargeAmount(context[amountKey], kind));
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
    // Skip unconfigured charges to preserve untaxed legacy behavior.
    if (amount.isZero() || !categoryId) continue;

    let calculation;
    try {
      calculation = TaxEngine.calculate({
        pack,
        currency: tenant.currency,
        country: tenant.country,
        businessType: tenant.business_type,
        storeStateCode: tenant.state_code,
        transactionDate: new Date().toISOString(),
        customer: customer
          ? {
            registrationNumber: customer.taxRegistrationNumber,
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

export function aggregateTaxBreakdown(itemBreakdowns: TaxBreakdown[][], minorFactor = 100): TaxBreakdown[] {
  const merged: Record<string, TaxBreakdown> = {};

  for (const breakdown of itemBreakdowns) {
    if (!Array.isArray(breakdown)) continue;
    for (const line of breakdown) {
      if (!line || typeof line.amount !== 'number' || !Number.isFinite(line.amount)) continue;
      const key = `${line.title}_${line.rate}`;
      if (!merged[key]) {
        merged[key] = { title: line.title, rate: line.rate, amount: 0 };
      }
      merged[key].amount = round(merged[key].amount + line.amount, 4);
    }
  }

  return Object.values(merged).map((line) => ({
    ...line,
    amount: round(line.amount, Math.log10(minorFactor)),
  }));
}

// Aggregates item-level tax snapshots into an order/bill-level snapshot array.
export function aggregateTaxSnapshots(itemSnapshotsJson: (string | null | undefined)[]): string | null {
  const snapshots = itemSnapshotsJson
    .map((raw) => {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    })
    .filter((snapshot) => snapshot !== null);

  return snapshots.length > 0 ? JSON.stringify(snapshots) : null;
}

// Inverts tax snapshot line amounts for negative void/refund adjustment rows.
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
  minorFactor = 100,
): any[] {
  const decimals = Math.log10(minorFactor);
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
      const rounded = rawAmount.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
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
  const minorDelta = new Decimal(targetTaxAmount)
    .minus(roundedTotal)
    .mul(minorFactor)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  const direction = Math.sign(minorDelta);
  const allocationOrder = [...entries].sort((left, right) => {
    const remainderOrder = direction >= 0
      ? right.remainder.comparedTo(left.remainder)
      : left.remainder.comparedTo(right.remainder);
    if (remainderOrder !== 0) return remainderOrder;
    const titleOrder = String(left.component.title || '').localeCompare(String(right.component.title || ''));
    if (titleOrder !== 0) return titleOrder;
    return left.outerIndex - right.outerIndex || left.innerIndex - right.innerIndex;
  });

  for (let index = 0; index < Math.abs(minorDelta); index++) {
    const entry = allocationOrder[index % allocationOrder.length];
    entry.rounded = entry.rounded.plus(direction / minorFactor);
  }
  for (const entry of entries) entry.component.amount = entry.rounded.toNumber();
  return cloned;
}

export function scaleTaxSnapshots(
  snapshotsJson: (string | null | undefined)[],
  ratio: number,
  minorFactor = 100,
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
  const decimals = Math.log10(minorFactor);
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
        const rounded = raw.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
        entries.push({ component, line, raw, rounded, remainder: raw.minus(rounded) });
      }
    }
  }

  if (entries.length > 0) {
    const targetTaxAmount = entries.reduce(
      (sum, entry) => sum.plus(new Decimal(entry.component.amount || 0)),
      new Decimal(0),
    ).mul(scale).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    const roundedTotal = entries.reduce((sum, entry) => sum.plus(entry.rounded), new Decimal(0));
    const centsDelta = targetTaxAmount
      .minus(roundedTotal)
      .mul(minorFactor)
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
      entry.rounded = entry.rounded.plus(direction / minorFactor);
    }
    for (const entry of entries) {
      entry.component.amount = entry.rounded.toFixed(decimals);
      entry.component.roundingRemainder = entry.raw.minus(entry.rounded).toString();
    }
  }

  for (const snapshot of snapshots) {
    for (const line of snapshot.lines) {
      const scaleValue = (value: unknown) => {
        if (typeof value !== 'string' && typeof value !== 'number') return value;
        return new Decimal(value).mul(scale).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
      };
      line.grossAmount = scaleValue(line.grossAmount);
      line.taxableBase = scaleValue(line.taxableBase);
      if (Array.isArray(line.components)) {
        line.taxAmount = line.components.reduce(
          (sum: Decimal, component: any) => sum.plus(component.amount || 0),
          new Decimal(0),
        ).toFixed(decimals);
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
  minorFactor?: number;
}): TaxRollup {
  const scaledBreakdowns = scaleTaxBreakdowns(
    args.itemBreakdowns,
    args.itemTaxRatio,
    args.itemTaxAmount,
    args.minorFactor,
  );
  const scaledSnapshots = scaleTaxSnapshots(
    args.itemSnapshots,
    args.itemTaxRatio,
    args.minorFactor,
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

// Tax preview endpoint handler
export async function calculateTaxPreview(req: any, res: any): Promise<void> {
  try {
    const {
      items,
      customer_id,
      packaging_charge,
      delivery_charge,
      service_charge,
      discount_type,
      discount_value,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Items are required' });
      return;
    }

    const db = getDatabase();

    // Get settings
    const settings: Record<string, string> = {};
    db.prepare('SELECT key, value FROM settings').all().forEach((row: any) => {
      settings[row.key] = row.value;
    });

    const tenantInfo: TenantInfo = {
      country: settings.country || 'IN',
      business_type: settings.business_type || 'restaurant',
      state_code: settings.state_code || '',
      taxes_enabled: settings.taxes_enabled === 'true',
    };
    const currency = settings.currency && /^[A-Z]{3}$/.test(settings.currency)
      ? settings.currency
      : getCountryByCode(tenantInfo.country)?.currency || 'INR';
    tenantInfo.currency = currency;
    const decimals = getCurrencyFractionDigits(currency);
    const minorFactor = getCurrencyMinorUnitFactor(currency);

    const customer = customer_id
      ? (db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id) as Customer | undefined)
      : null;

    const itemResults: any[] = [];
    const allBreakdowns: any[] = [];
    const allTaxSnapshots: (string | null)[] = [];
    let totalSubtotal = 0;
    let totalTax = 0;
    let totalExclusiveTax = 0;

    for (const itemData of items) {
      if (!itemData || typeof itemData !== 'object' || !itemData.product_id) {
        continue;
      }
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(itemData.product_id) as any;
      if (!product) {
        console.warn(`[TaxPreview] Product with ID ${itemData.product_id} not found in database.`);
        continue;
      }

      const unitPrice = parseFloat(product.price) || 0;
      const rawQty = Number(itemData.quantity);
      const quantity = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
      const rawDisc = Number(itemData.discount_amount);
      const itemDiscount = Number.isFinite(rawDisc) && rawDisc >= 0 ? rawDisc : 0;

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
        subtotal: round(subtotal, decimals),
        discount_amount: itemDiscount,
        tax_amount: taxResult.tax_amount,
        tax_breakdown: taxResult.tax_breakdown,
        tax_type: taxResult.tax_type,
        total: round(subtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount), decimals),
      });

      if (taxResult.tax_breakdown) {
        allBreakdowns.push(taxResult.tax_breakdown);
      }
      allTaxSnapshots.push(taxResult.tax_snapshot ? JSON.stringify(taxResult.tax_snapshot) : null);
      totalSubtotal += subtotal;
      totalTax += taxResult.tax_amount;
      if (taxResult.tax_type !== 'inclusive') {
        totalExclusiveTax += taxResult.tax_amount;
      }
    }

    const packaging = normalizeChargeAmount(packaging_charge, 'packaging');
    const delivery = normalizeChargeAmount(delivery_charge, 'delivery');
    const service = normalizeChargeAmount(service_charge, 'service_charge');

    let discountAmount = new Decimal(0);
    if (discount_type !== undefined || discount_value !== undefined) {
      if (!['percentage', 'amount'].includes(discount_type)) {
        res.status(400).json({ error: 'discount_type must be percentage or amount' });
        return;
      }
      const parsedDiscount = Number(discount_value);
      if (!Number.isFinite(parsedDiscount) || parsedDiscount < 0) {
        res.status(400).json({ error: 'discount_value must be a finite non-negative number' });
        return;
      }
      const subtotalDecimal = new Decimal(totalSubtotal);
      if (discount_type === 'percentage') {
        if (parsedDiscount > 100) {
          res.status(400).json({ error: 'discount_value must not exceed 100 percent' });
          return;
        }
        discountAmount = subtotalDecimal.mul(parsedDiscount).div(100);
      } else {
        discountAmount = Decimal.min(new Decimal(parsedDiscount), subtotalDecimal);
      }
      discountAmount = discountAmount.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    }

    const subtotalDecimal = new Decimal(totalSubtotal);
    const discountedSubtotal = Decimal.max(0, subtotalDecimal.minus(discountAmount));
    const taxRatio = discountAmount.gt(0) && subtotalDecimal.gt(0)
      ? discountedSubtotal.div(subtotalDecimal)
      : new Decimal(1);
    const discountedItemTax = new Decimal(totalTax)
      .mul(taxRatio)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
      .toNumber();
    const discountedExclusiveTax = new Decimal(totalExclusiveTax)
      .mul(taxRatio)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
      .toNumber();

    const chargeCategories = getConfiguredChargeTaxCategories(tenantInfo.country);
    const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, {
      packaging_charge: packaging,
      delivery_charge: delivery,
      service_charge: service,
      packaging_tax_category_id: chargeCategories.packaging?.categoryId || null,
      delivery_tax_category_id: chargeCategories.delivery?.categoryId || null,
      service_charge_tax_category_id: chargeCategories.service_charge?.categoryId || null,
    }, customer || null);
    const taxRollup = combineItemAndChargeTaxes({
      itemTaxAmount: discountedItemTax,
      itemExclusiveTaxAmount: discountedExclusiveTax,
      itemBreakdowns: allBreakdowns,
      itemSnapshots: allTaxSnapshots,
      itemTaxRatio: taxRatio.toNumber(),
      chargeTaxes,
      minorFactor,
    });
    const aggregatedBreakdown = aggregateTaxBreakdown(taxRollup.breakdowns, minorFactor);
    const exactTotal = discountedSubtotal
      .plus(taxRollup.exclusiveTaxAmount)
      .plus(packaging)
      .plus(delivery)
      .plus(service)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
      .toNumber();
    const pack = getActiveCountryPack(tenantInfo.country);
    const { total, adjustment: roundOff } = applyPayableRounding(exactTotal, pack, currency);

    res.json({
      items: itemResults,
      summary: {
        subtotal: round(totalSubtotal, decimals),
        discount_amount: discountAmount.toNumber(),
        discounted_subtotal: discountedSubtotal.toNumber(),
        tax_amount: round(taxRollup.taxAmount, decimals),
        tax_breakdown: aggregatedBreakdown,
        packaging_charge: packaging,
        delivery_charge: delivery,
        service_charge: service,
        round_off: roundOff,
        total,
      },
    });
  } catch (error: any) {
    console.error('[Tax] Preview error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
}
