import Decimal from 'decimal.js';
import { getDatabase, getSettingValue } from '../db';
import { resolveOrderItemVariant, variantUnitPrice } from './product-variants';
import { getBundledCountryPack } from '../tax-packs/bundled';
import {
  getCountryByCode,
  getCurrencyFractionDigits,
  getCurrencyMinorUnitFactor,
  resolveTenantCurrency,
  type TaxIdFormat,
} from '../countries';
import {
  buildAppliedCharges,
  ChargeValidationError,
  VALID_CHARGE_ORDER_TYPES,
  type AppliedCharge,
} from './charges';

const TaxDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function computeDiscountTaxRatio(
  discountedSubtotal: Decimal.Value,
  subtotal: Decimal.Value,
): Decimal {
  const base = new TaxDecimal(subtotal);
  if (!base.isFinite() || base.lte(0)) return new TaxDecimal(1);
  const discounted = Decimal.max(0, Decimal.min(new TaxDecimal(discountedSubtotal), base));
  return new TaxDecimal(discounted.toString()).div(base);
}

export interface TenantInfo {
  country: string;
  business_type: string;
  state_code: string;
  currency?: string;
  // Passed explicitly by caller to allow isolated unit testing without a database.
  taxes_enabled: boolean;
}

export interface Product {
  id?: string | number;
  name?: string;
  price?: string | number;
  tax_type: string;
  tax_rate: number;
  tax_category?: string;
  tax_category_id?: string;
  tax_behavior?: 'country_default' | 'inclusive' | 'exclusive' | 'exempt';
}

export interface Customer {
  taxRegistrationNumber?: string;
  customer_state_code?: string;
}

export interface TaxResult {
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

import {
  TaxEngine,
  applyPayableRounding,
  canonical,
  roundPlaces,
  type TaxEngineLine,
} from './tax-engine';
import type { CountryPack, RoundingMethod, TaxRule } from '../tax-packs/types';

function round(value: number, decimals: number = 2): number {
  if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) return 0;
  return Number(Math.round(Number(value + 'e' + decimals)) + 'e-' + decimals);
}

// Shared helper to retrieve the active country pack for tax calculation and categories API.
export function getActiveCountryPack(country: string): CountryPack {
  try {
    const db = getDatabase();
    const row = db
      .prepare(`
      SELECT version.pack_json
      FROM country_packs AS pack
      JOIN country_pack_versions AS version ON version.id = pack.active_version_id
      WHERE pack.country IN (?, '*') AND pack.status = 'active'
      ORDER BY CASE WHEN pack.country = ? THEN 0 ELSE 1 END, pack.updated_at DESC
      LIMIT 1
    `)
      .get(country, country) as { pack_json: string } | undefined;
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
  return (
    getActiveCountryPack(country).registrationNumberFormat ||
    getCountryByCode(country)?.taxIdFormat ||
    null
  );
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
  return pack.categories.some((category) =>
    category.ruleIds.some((ruleId) => {
      const rule = pack.rules.find((candidate) => candidate.id === ruleId);
      return Boolean(
        rule &&
        (!rule.conditions?.businessTypes || rule.conditions.businessTypes.includes(businessType)),
      );
    }),
  );
}

export function getActiveTaxOverride(
  entityType: string,
  entityId: string | number,
  packId: string,
): { id: string; categoryId: string } | null {
  try {
    const db = getDatabase();
    const row = db
      .prepare(`
      SELECT override.id, override.value_json
      FROM tax_overrides AS override
      JOIN country_packs AS pack ON pack.active_version_id = override.pack_version_id
      WHERE pack.id = ?
        AND override.entity_type = ?
        AND override.entity_id = ?
        AND override.field_name = 'tax_category_id'
      ORDER BY override.updated_at DESC
      LIMIT 1
    `)
      .get(packId, entityType, String(entityId)) as { id: string; value_json: string } | undefined;
    if (row) {
      const value = JSON.parse(row.value_json);
      const categoryId = typeof value === 'string' ? value : value?.categoryId;
      if (typeof categoryId === 'string' && categoryId) {
        return { id: row.id, categoryId };
      }
    }
  } catch {
    // An unavailable override table is possible only before migrations or
    // in isolated unit tests; normal checkout databases always have it.
  }
  return null;
}

const CHARGE_KINDS: ChargeTaxKind[] = ['packaging', 'delivery', 'service_charge'];

export function getConfiguredChargeTaxCategories(
  country: string,
): Partial<Record<ChargeTaxKind, ChargeTaxCategorySelection>> {
  if (getSettingValue('taxes_enabled') !== 'true') return {};
  const pack = getActiveCountryPack(country);
  try {
    const rows = getDatabase()
      .prepare(`
      SELECT override.id, override.entity_type, override.value_json
      FROM tax_overrides AS override
      JOIN country_packs AS country_pack
        ON country_pack.active_version_id = override.pack_version_id
      WHERE country_pack.id = ?
        AND override.entity_type IN ('packaging', 'delivery', 'service_charge')
        AND override.entity_id IS NULL
        AND override.field_name = 'tax_category_id'
      ORDER BY override.updated_at DESC
    `)
      .all(pack.id) as Array<{ id: string; entity_type: ChargeTaxKind; value_json: string }>;
    const configured: Partial<Record<ChargeTaxKind, ChargeTaxCategorySelection>> = {};
    for (const row of rows) {
      if (configured[row.entity_type]) continue;
      try {
        const value = JSON.parse(row.value_json);
        const categoryId = typeof value === 'string' ? value : value?.categoryId;
        if (typeof categoryId === 'string' && categoryId) {
          configured[row.entity_type] = { categoryId, overrideId: row.id };
        }
      } catch {}
    }
    return configured;
  } catch {
    return {};
  }
}

export function normalizeChargeAmount(value: unknown, kind: ChargeTaxKind): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw Object.assign(new Error(`${kind} charge must be a non-negative finite amount`), {
      statusCode: 400,
    });
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
    throw Object.assign(new Error(error.message || `${kind} charge is invalid`), {
      statusCode: 400,
    });
  }
}

function chargeAmount(context: ChargeTaxContext, kind: ChargeTaxKind): Decimal {
  const amountKey: keyof ChargeTaxContext =
    kind === 'service_charge' ? 'service_charge' : `${kind}_charge`;
  return new Decimal(normalizeChargeAmount(context[amountKey], kind));
}

function chargeCategoryId(context: ChargeTaxContext, kind: ChargeTaxKind): string | null {
  const value = context[`${kind}_tax_category_id` as keyof ChargeTaxContext];
  return typeof value === 'string' && value ? value : null;
}

export interface DocumentTaxCalculationInput {
  items?: Array<{ lineId?: string; product: Product; taxableAmount: number }>;
  chargeContext?: ChargeTaxContext | null;
  customer?: Customer | null;
}

export interface DocumentTaxResult {
  itemResults: TaxResult[];
  chargeTaxes: ChargeTaxSummary;
}

/**
 * Evaluates document-scoped taxes across all items and configured charges in a
 * single TaxEngine.calculate invocation, preserving document remainder allocation.
 */
export function calculateDocumentTaxes(
  tenant: TenantInfo,
  input: DocumentTaxCalculationInput,
): DocumentTaxResult {
  const items = input.items || [];
  const customer = input.customer || null;
  const chargeContext = input.chargeContext || null;

  const itemResults: TaxResult[] = items.map(() => ({
    tax_amount: 0,
    tax_breakdown: [],
    tax_type: 'none',
    tax_snapshot: null,
  }));

  const chargeTaxes: ChargeTaxSummary = {
    taxAmount: 0,
    exclusiveTaxAmount: 0,
    breakdowns: [],
    snapshotJson: [],
  };

  if (!tenant.taxes_enabled || (items.length === 0 && !chargeContext)) {
    return { itemResults, chargeTaxes };
  }

  const pack = getActiveCountryPack(tenant.country);

  const itemEntries: Array<{
    itemIndex: number;
    merchantOverride: { id: string; categoryId: string } | null;
    engineLine: TaxEngineLine;
  }> = [];

  for (let idx = 0; idx < items.length; idx++) {
    const entry = items[idx];
    const taxCategoryId = entry.product.tax_category_id ?? entry.product.tax_category ?? null;
    const merchantOverride =
      entry.product.id !== undefined && entry.product.id !== null && pack
        ? getActiveTaxOverride('product', entry.product.id, pack.id)
        : null;

    if (!taxCategoryId && !merchantOverride) {
      continue;
    }

    if (!pack) {
      throw Object.assign(
        new Error(`Tax calculation failed: no active tax pack for country ${tenant.country}`),
        { statusCode: 400 },
      );
    }

    if ((entry.taxableAmount ?? 0) < 0) {
      continue;
    }

    const lineId =
      entry.lineId ||
      (items.length === 1 && !chargeContext
        ? 'legacy-item-adapter'
        : `line-${String(idx + 1).padStart(4, '0')}`);
    itemEntries.push({
      itemIndex: idx,
      merchantOverride,
      engineLine: {
        lineId,
        kind: 'product',
        quantity: '1',
        unitPrice: String(entry.taxableAmount),
        merchantCategoryId: merchantOverride?.categoryId,
        productCategoryId: taxCategoryId || undefined,
        taxBehavior: entry.product.tax_behavior || 'country_default',
      },
    });
  }

  const activeCharges: Array<{ kind: ChargeTaxKind; amount: Decimal; categoryId: string }> = [];
  if (chargeContext) {
    for (const kind of CHARGE_KINDS) {
      const amount = chargeAmount(chargeContext, kind);
      const categoryId = chargeCategoryId(chargeContext, kind);
      if (!amount.isZero() && !amount.isNegative() && categoryId) {
        activeCharges.push({ kind, amount, categoryId });
      }
    }
  }

  if (activeCharges.length > 0 && !pack) {
    throw Object.assign(
      new Error(`Tax calculation failed: no active tax pack for country ${tenant.country}`),
      { statusCode: 400 },
    );
  }

  const allEngineLines: TaxEngineLine[] = [
    ...itemEntries.map((e) => e.engineLine),
    ...activeCharges.map((charge) => ({
      lineId: `charge:${charge.kind}`,
      kind: charge.kind,
      quantity: '1',
      unitPrice: charge.amount.toString(),
      merchantCategoryId: charge.categoryId,
      taxBehavior: 'country_default' as const,
    })),
  ];

  if (allEngineLines.length === 0) {
    return { itemResults, chargeTaxes };
  }

  let calculation;
  try {
    calculation = TaxEngine.calculate({
      pack: pack!,
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
      lines: allEngineLines,
    });
  } catch (engineError: any) {
    throw Object.assign(new Error(`Tax calculation failed: ${engineError.message}`), {
      statusCode: 400,
    });
  }

  for (let k = 0; k < itemEntries.length; k++) {
    const line = calculation.lines[k];
    const entry = itemEntries[k];
    if (line.taxBehavior !== 'exempt' && line.components.length === 0) {
      throw Object.assign(
        new Error(
          `Tax calculation failed: no tax rules apply to category ${line.categoryId} for business type ${tenant.business_type}`,
        ),
        { statusCode: 400 },
      );
    }
    itemResults[entry.itemIndex] = {
      tax_amount: Number(line.taxAmount),
      tax_breakdown: line.components.map((component) => ({
        title: component.label,
        rate: Number(component.rate || 0),
        amount: Number(component.amount),
      })),
      tax_type: line.taxBehavior === 'exempt' ? 'none' : line.taxBehavior,
      tax_snapshot: {
        ...calculation.snapshot,
        country: tenant.country,
        currency: tenant.currency,
        payableRounding: pack!.payableRounding,
        lines: [line],
        merchantOverridesApplied: entry.merchantOverride
          ? [
              {
                overrideId: entry.merchantOverride.id,
                entityType: 'product',
                entityId: String(items[entry.itemIndex].product.id),
                fieldName: 'tax_category_id',
                categoryId: entry.merchantOverride.categoryId,
              },
            ]
          : [],
      },
    };
  }

  let chargeTaxAmount = new Decimal(0);
  let chargeExclusiveTaxAmount = new Decimal(0);
  const chargeBreakdowns: TaxBreakdown[][] = [];
  const chargeSnapshotJson: string[] = [];

  for (let idx = 0; idx < activeCharges.length; idx++) {
    const k = itemEntries.length + idx;
    const line = calculation.lines[k];
    const charge = activeCharges[idx];
    if (line.taxBehavior !== 'exempt' && line.components.length === 0) {
      throw Object.assign(
        new Error(
          `Tax calculation failed: no tax rules apply to ${charge.kind} category ${line.categoryId}`,
        ),
        { statusCode: 400 },
      );
    }
    const lineTax = new Decimal(line.taxAmount);
    chargeTaxAmount = chargeTaxAmount.plus(lineTax);
    if (line.taxBehavior !== 'inclusive')
      chargeExclusiveTaxAmount = chargeExclusiveTaxAmount.plus(lineTax);
    chargeBreakdowns.push(
      line.components.map((component) => ({
        title: component.label,
        rate: Number(component.rate || 0),
        amount: Number(component.amount),
      })),
    );
    chargeSnapshotJson.push(
      JSON.stringify({
        ...calculation.snapshot,
        lines: [line],
        chargeKind: charge.kind,
        configuredCategoryId: charge.categoryId,
      }),
    );
  }

  chargeTaxes.taxAmount = chargeTaxAmount.toNumber();
  chargeTaxes.exclusiveTaxAmount = chargeExclusiveTaxAmount.toNumber();
  chargeTaxes.breakdowns = chargeBreakdowns;
  chargeTaxes.snapshotJson = chargeSnapshotJson;

  return { itemResults, chargeTaxes };
}

/** Evaluates taxes across multiple items, returning item tax results. */
export function calculateDocumentItemTaxes(
  tenant: TenantInfo,
  items: Array<{ lineId?: string; product: Product; taxableAmount: number }>,
  customer: Customer | null = null,
  chargeContext?: ChargeTaxContext | null,
): TaxResult[] {
  return calculateDocumentTaxes(tenant, { items, chargeContext, customer }).itemResults;
}

/** Single-item adapter for legacy callers evaluating an isolated item. */
export function calculateItemTax(
  tenant: TenantInfo,
  product: Product,
  taxableAmount: number,
  customer: Customer | null,
): TaxResult {
  return calculateDocumentItemTaxes(
    tenant,
    [{ lineId: 'legacy-item-adapter', product, taxableAmount }],
    customer,
  )[0];
}

/** Adapter evaluating configured charges in isolation when no items are present. */
export function calculateConfiguredChargeTaxes(
  tenant: TenantInfo,
  context: ChargeTaxContext,
  customer: Customer | null = null,
): ChargeTaxSummary {
  return calculateDocumentTaxes(tenant, { items: [], chargeContext: context, customer })
    .chargeTaxes;
}

export function aggregateTaxBreakdown(
  itemBreakdowns: TaxBreakdown[][],
  minorFactor = 100,
): TaxBreakdown[] {
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
export function aggregateTaxSnapshots(
  itemSnapshotsJson: (string | null | undefined)[],
): string | null {
  const snapshots = itemSnapshotsJson
    .map((raw) => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
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
    return JSON.stringify(
      breakdown.map((component: any) => ({
        ...component,
        amount: new Decimal(component.amount || 0).negated().toNumber(),
      })),
    );
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
  const cloned = breakdowns.map((breakdown) =>
    Array.isArray(breakdown) ? breakdown.map((component) => ({ ...component })) : breakdown,
  );
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
    const remainderOrder =
      direction >= 0
        ? right.remainder.comparedTo(left.remainder)
        : left.remainder.comparedTo(right.remainder);
    if (remainderOrder !== 0) return remainderOrder;
    const titleOrder = String(left.component.title || '').localeCompare(
      String(right.component.title || ''),
    );
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
  if (scale.eq(1)) {
    return snapshots.map((snapshot) => JSON.stringify(snapshot));
  }
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
    const targetTaxAmount = entries
      .reduce((sum, entry) => sum.plus(new Decimal(entry.component.amount || 0)), new Decimal(0))
      .mul(scale)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    const roundedTotal = entries.reduce((sum, entry) => sum.plus(entry.rounded), new Decimal(0));
    const centsDelta = targetTaxAmount
      .minus(roundedTotal)
      .mul(minorFactor)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber();
    const direction = Math.sign(centsDelta);
    const ordered = [...entries].sort((left, right) => {
      const remainderOrder =
        direction >= 0
          ? right.remainder.comparedTo(left.remainder)
          : left.remainder.comparedTo(right.remainder);
      if (remainderOrder !== 0) return remainderOrder;
      const ruleOrder = String(left.component.ruleId || '').localeCompare(
        String(right.component.ruleId || ''),
      );
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
        return new Decimal(value)
          .mul(scale)
          .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
          .toFixed(decimals);
      };
      line.grossAmount = scaleValue(line.grossAmount);
      line.taxableBase = scaleValue(line.taxableBase);
      if (Array.isArray(line.components)) {
        line.taxAmount = line.components
          .reduce((sum: Decimal, component: any) => sum.plus(component.amount || 0), new Decimal(0))
          .toFixed(decimals);
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
  const nonEmptyBreakdowns = [...scaledBreakdowns, ...args.chargeTaxes.breakdowns].filter(
    (breakdown) => Array.isArray(breakdown) && breakdown.length > 0,
  );
  return {
    taxAmount: new Decimal(args.itemTaxAmount).plus(args.chargeTaxes.taxAmount).toNumber(),
    exclusiveTaxAmount: new Decimal(args.itemExclusiveTaxAmount)
      .plus(args.chargeTaxes.exclusiveTaxAmount)
      .toNumber(),
    breakdowns: nonEmptyBreakdowns,
    snapshotJson: aggregateTaxSnapshots([...scaledSnapshots, ...args.chargeTaxes.snapshotJson]),
  };
}

interface SnapshotComponent {
  ruleId: string;
  amount: string;
  roundingRemainder?: string;
  rate?: string;
  amountPer?: string;
  label?: string;
}

interface SnapshotLine {
  lineId: string;
  grossAmount?: string;
  taxAmount?: string;
  taxableBase?: string;
  components: SnapshotComponent[];
  categoryId?: string;
  taxBehavior?: string;
}

interface SnapshotData {
  packId?: string;
  packVersion?: string;
  currency?: string;
  taxRounding?: {
    scope: string;
    method: RoundingMethod;
    decimalPlaces: number;
    remainderAllocation?: string;
  };
  lines?: SnapshotLine[];
}

export interface DocumentTaxAllocationItemInput {
  snapshot: string | Record<string, unknown> | null | undefined;
  lineIdOverride?: string;
}

export interface DocumentTaxAllocationItemOutput {
  handled: boolean;
  taxAmount: number;
  breakdown: TaxBreakdown[];
  snapshotJson: string | null;
}

/** Scales raw item tax components before document-scope remainder allocation across items and charges. */
export function allocateDocumentTaxRounding(args: {
  items: DocumentTaxAllocationItemInput[];
  chargeTaxes: ChargeTaxSummary;
  currency: string;
  minorFactor?: number;
  itemTaxRatio?: Decimal;
}): {
  itemOutputs: DocumentTaxAllocationItemOutput[];
  chargeTaxes: ChargeTaxSummary;
} {
  const ratio = args.itemTaxRatio ?? new Decimal(1);
  const isScaled = !ratio.eq(1);
  const resolvePlaces = (currencyCode?: string) => {
    const code = args.currency || currencyCode || '';
    if (code) return getCurrencyFractionDigits(code);
    if (args.minorFactor && args.minorFactor > 0) return Math.round(Math.log10(args.minorFactor));
    return getCurrencyFractionDigits('');
  };
  const itemOutputs: DocumentTaxAllocationItemOutput[] = args.items.map(() => ({
    handled: false,
    taxAmount: 0,
    breakdown: [],
    snapshotJson: null,
  }));
  const nextChargeTaxes: ChargeTaxSummary = {
    taxAmount: args.chargeTaxes.taxAmount,
    exclusiveTaxAmount: args.chargeTaxes.exclusiveTaxAmount,
    breakdowns: [...args.chargeTaxes.breakdowns],
    snapshotJson: [...args.chargeTaxes.snapshotJson],
  };

  interface GroupComponentEntry {
    comp: SnapshotComponent;
    raw: Decimal;
    rounded: Decimal;
    remainder: Decimal;
    line: SnapshotLine;
    orderIdx: number;
  }

  interface DocumentGroup {
    taxRounding: NonNullable<SnapshotData['taxRounding']>;
    currency?: string;
    components: GroupComponentEntry[];
    affectedItemIndices: Set<number>;
    affectedChargeIndices: Set<number>;
  }

  const groups = new Map<string, DocumentGroup>();
  const itemSnapshots = new Map<number, SnapshotData>();
  const chargeSnapshots = new Map<number, SnapshotData>();
  let orderCounter = 0;

  args.items.forEach((itemInput, idx) => {
    if (!itemInput.snapshot) return;
    let snap: SnapshotData | null = null;
    try {
      snap =
        typeof itemInput.snapshot === 'string'
          ? JSON.parse(itemInput.snapshot)
          : JSON.parse(JSON.stringify(itemInput.snapshot));
    } catch {
      return;
    }
    if (
      snap?.taxRounding?.scope !== 'document' ||
      !Array.isArray(snap.lines) ||
      snap.lines.length === 0
    ) {
      return;
    }

    itemSnapshots.set(idx, snap);
    const line = snap.lines[0];
    if (itemInput.lineIdOverride) {
      line.lineId = itemInput.lineIdOverride;
    }
    if (isScaled) {
      const places = resolvePlaces(snap.currency);
      const scaleLineAmount = (val: unknown) =>
        typeof val === 'string' || typeof val === 'number'
          ? new TaxDecimal(val)
              .mul(new TaxDecimal(ratio))
              .toSignificantDigits(20, Decimal.ROUND_HALF_UP)
              .toDecimalPlaces(places, Decimal.ROUND_HALF_UP)
              .toFixed(places)
          : val;
      line.grossAmount = scaleLineAmount(line.grossAmount) as string | undefined;
      line.taxableBase = scaleLineAmount(line.taxableBase) as string | undefined;
    }

    const taxRoundingKey = JSON.stringify(snap.taxRounding);
    const groupKey = `${snap.packId}\0${taxRoundingKey}`;

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        taxRounding: snap.taxRounding,
        currency: snap.currency,
        components: [],
        affectedItemIndices: new Set(),
        affectedChargeIndices: new Set(),
      };
      groups.set(groupKey, group);
    }

    group.affectedItemIndices.add(idx);
    for (const comp of line.components || []) {
      const unscaledRaw = new TaxDecimal(comp.amount).plus(comp.roundingRemainder || '0');
      const raw = isScaled
        ? new Decimal(
            unscaledRaw
              .mul(new TaxDecimal(ratio))
              .toSignificantDigits(20, Decimal.ROUND_HALF_UP)
              .toString(),
          )
        : new Decimal(unscaledRaw.toString());
      group.components.push({
        comp,
        raw,
        rounded: new Decimal(0),
        remainder: new Decimal(0),
        line,
        orderIdx: orderCounter++,
      });
    }
  });

  if (nextChargeTaxes.snapshotJson.length > 0) {
    nextChargeTaxes.snapshotJson.forEach((snapJson, cIdx) => {
      let snap: SnapshotData | null = null;
      try {
        snap = JSON.parse(snapJson);
      } catch {
        return;
      }
      if (
        snap?.taxRounding?.scope !== 'document' ||
        !Array.isArray(snap.lines) ||
        snap.lines.length === 0
      ) {
        return;
      }

      chargeSnapshots.set(cIdx, snap);
      const line = snap.lines[0];
      const taxRoundingKey = JSON.stringify(snap.taxRounding);
      const groupKey = `${snap.packId}\0${taxRoundingKey}`;

      let group = groups.get(groupKey);
      if (!group) {
        group = {
          taxRounding: snap.taxRounding,
          currency: snap.currency,
          components: [],
          affectedItemIndices: new Set(),
          affectedChargeIndices: new Set(),
        };
        groups.set(groupKey, group);
      }

      group.affectedChargeIndices.add(cIdx);
      for (const comp of line.components || []) {
        const raw = new Decimal(comp.amount).plus(comp.roundingRemainder || '0');
        group.components.push({
          comp,
          raw,
          rounded: new Decimal(0),
          remainder: new Decimal(0),
          line,
          orderIdx: orderCounter++,
        });
      }
    });
  }

  for (const group of groups.values()) {
    const places = resolvePlaces(group.currency);
    const quantum = new Decimal(10).pow(-places);
    const sumRaw = group.components.reduce((sum, c) => sum.plus(c.raw), new Decimal(0));
    const target = roundPlaces(sumRaw, places, group.taxRounding.method);

    for (const entry of group.components) {
      entry.rounded = entry.raw.toDecimalPlaces(places, Decimal.ROUND_FLOOR);
      entry.remainder = entry.raw.minus(entry.rounded);
    }

    const sumRounded = group.components.reduce((sum, c) => sum.plus(c.rounded), new Decimal(0));
    let units = target.minus(sumRounded).div(quantum).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

    const ordered = [...group.components].sort((left, right) => {
      const remainderOrder = right.remainder.comparedTo(left.remainder);
      if (remainderOrder !== 0) return remainderOrder;
      const ruleOrder = (left.comp.ruleId || '').localeCompare(right.comp.ruleId || '');
      if (ruleOrder !== 0) return ruleOrder;
      const lineOrder = (left.line.lineId || '').localeCompare(right.line.lineId || '');
      if (lineOrder !== 0) return lineOrder;
      return left.orderIdx - right.orderIdx;
    });

    let uIndex = 0;
    while (units.gt(0) && ordered.length > 0) {
      const entry = ordered[uIndex % ordered.length];
      entry.rounded = entry.rounded.plus(quantum);
      units = units.minus('1');
      uIndex += 1;
    }

    for (const entry of group.components) {
      entry.comp.amount = entry.rounded.toFixed(places);
      entry.comp.roundingRemainder = canonical(entry.raw.minus(entry.rounded));
    }

    for (const itemIdx of group.affectedItemIndices) {
      const snap = itemSnapshots.get(itemIdx);
      if (!snap || !Array.isArray(snap.lines) || snap.lines.length === 0) continue;
      const line = snap.lines[0];
      const lineTax = (line.components || []).reduce(
        (sum: Decimal, c) => sum.plus(new Decimal(c.amount)),
        new Decimal(0),
      );
      line.taxAmount = lineTax.toFixed(places);
      itemOutputs[itemIdx] = {
        handled: true,
        taxAmount: lineTax.toNumber(),
        breakdown: (line.components || []).map((c) => ({
          title: c.label || '',
          rate: Number(c.rate || 0),
          amount: Number(c.amount),
        })),
        snapshotJson: JSON.stringify(snap),
      };
    }

    for (const cIdx of group.affectedChargeIndices) {
      const snap = chargeSnapshots.get(cIdx);
      if (!snap || !Array.isArray(snap.lines) || snap.lines.length === 0) continue;
      const line = snap.lines[0];
      const lineTax = (line.components || []).reduce(
        (sum: Decimal, c) => sum.plus(new Decimal(c.amount)),
        new Decimal(0),
      );
      line.taxAmount = lineTax.toFixed(places);
      nextChargeTaxes.snapshotJson[cIdx] = JSON.stringify(snap);
      nextChargeTaxes.breakdowns[cIdx] = (line.components || []).map((c) => ({
        title: c.label || '',
        rate: Number(c.rate || 0),
        amount: Number(c.amount),
      }));
    }
  }

  if (chargeSnapshots.size > 0 && nextChargeTaxes.snapshotJson.length > 0) {
    let chargeTaxAmount = new Decimal(0);
    let chargeExclusiveTaxAmount = new Decimal(0);
    for (const snapStr of nextChargeTaxes.snapshotJson) {
      try {
        const cSnap = JSON.parse(snapStr);
        for (const cLine of cSnap.lines || []) {
          const lTax = new Decimal(cLine.taxAmount || '0');
          chargeTaxAmount = chargeTaxAmount.plus(lTax);
          if (cLine.taxBehavior !== 'inclusive') {
            chargeExclusiveTaxAmount = chargeExclusiveTaxAmount.plus(lTax);
          }
        }
      } catch {}
    }
    nextChargeTaxes.taxAmount = chargeTaxAmount.toNumber();
    nextChargeTaxes.exclusiveTaxAmount = chargeExclusiveTaxAmount.toNumber();
  }

  return { itemOutputs, chargeTaxes: nextChargeTaxes };
}

export interface DiscountedTaxItemInput {
  taxAmount: number;
  taxType: string | null;
  breakdown: TaxBreakdown[] | null;
  snapshot: string | Record<string, unknown> | null;
  lineIdOverride?: string;
}

/** Rolls up item and charge taxes, scaling document-scoped raw item components before rounding. */
export function rollupOrderTaxes(args: {
  items: DiscountedTaxItemInput[];
  chargeTaxes: ChargeTaxSummary;
  currency: string;
  decimals: number;
  minorFactor: number;
  itemTaxRatio: Decimal;
  taxesEnabled: boolean;
}): {
  itemTaxAmount: number;
  itemExclusiveTaxAmount: number;
  taxRollup: TaxRollup;
} {
  const { items, chargeTaxes, currency, decimals, minorFactor, itemTaxRatio, taxesEnabled } = args;
  const toSnapshotString = (snap: string | Record<string, unknown> | null) =>
    typeof snap === 'string' ? snap : snap ? JSON.stringify(snap) : null;

  if (itemTaxRatio.eq(1)) {
    let totalTax = new Decimal(0);
    let exclusiveTax = new Decimal(0);
    const breakdowns: TaxBreakdown[][] = [];
    const snapshots: (string | null)[] = [];

    for (const item of items) {
      const itemTax = new Decimal(item.taxAmount || 0);
      totalTax = totalTax.plus(itemTax);
      if (item.taxType !== 'inclusive') {
        exclusiveTax = exclusiveTax.plus(itemTax);
      }
      if (item.breakdown && item.breakdown.length > 0) {
        breakdowns.push(item.breakdown);
      }
      snapshots.push(toSnapshotString(item.snapshot));
    }

    const itemTaxAmount = totalTax.toNumber();
    const itemExclusiveTaxAmount = exclusiveTax.toNumber();
    return {
      itemTaxAmount,
      itemExclusiveTaxAmount,
      taxRollup: combineItemAndChargeTaxes({
        itemTaxAmount,
        itemExclusiveTaxAmount,
        itemBreakdowns: breakdowns,
        itemSnapshots: snapshots,
        itemTaxRatio: 1,
        chargeTaxes,
        minorFactor,
      }),
    };
  }

  const discountedAlloc = taxesEnabled
    ? allocateDocumentTaxRounding({
        items: items.map((it) => ({
          snapshot: it.snapshot,
          lineIdOverride: it.lineIdOverride,
        })),
        chargeTaxes,
        currency,
        itemTaxRatio,
      })
    : null;
  const rollupChargeTaxes = discountedAlloc ? discountedAlloc.chargeTaxes : chargeTaxes;

  let docTotalTax = new Decimal(0);
  let docExclusiveTax = new Decimal(0);
  let nonDocTotalTax = new Decimal(0);
  let nonDocExclusiveTax = new Decimal(0);
  const nonDocBreakdowns: TaxBreakdown[][] = [];
  const nonDocSnapshots: (string | null)[] = [];
  const nonDocBreakdownSlots: number[] = [];
  const nonDocSnapshotSlots: number[] = [];
  const combinedBreakdowns: TaxBreakdown[][] = [];
  const combinedSnapshots: (string | null)[] = [];

  items.forEach((item, idx) => {
    const out = discountedAlloc?.itemOutputs[idx];
    if (out?.handled) {
      const itemTax = new Decimal(out.taxAmount);
      docTotalTax = docTotalTax.plus(itemTax);
      if (item.taxType !== 'inclusive') {
        docExclusiveTax = docExclusiveTax.plus(itemTax);
      }
      if (out.breakdown.length > 0) {
        combinedBreakdowns.push(out.breakdown);
      }
      combinedSnapshots.push(out.snapshotJson);
    } else {
      const itemTax = new Decimal(item.taxAmount || 0);
      nonDocTotalTax = nonDocTotalTax.plus(itemTax);
      if (item.taxType !== 'inclusive') {
        nonDocExclusiveTax = nonDocExclusiveTax.plus(itemTax);
      }
      if (item.breakdown && item.breakdown.length > 0) {
        nonDocBreakdownSlots.push(combinedBreakdowns.length);
        combinedBreakdowns.push([]);
        nonDocBreakdowns.push(item.breakdown);
      }
      nonDocSnapshotSlots.push(combinedSnapshots.length);
      combinedSnapshots.push(null);
      nonDocSnapshots.push(toSnapshotString(item.snapshot));
    }
  });

  const ratioNum = itemTaxRatio.toNumber();
  const scaledNonDocTax = nonDocTotalTax
    .mul(itemTaxRatio)
    .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  const scaledNonDocExclusiveTax = nonDocExclusiveTax
    .mul(itemTaxRatio)
    .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);

  if (nonDocBreakdownSlots.length > 0) {
    const scaledBreakdowns = scaleTaxBreakdowns(
      nonDocBreakdowns,
      ratioNum,
      scaledNonDocTax.toNumber(),
      minorFactor,
    );
    nonDocBreakdownSlots.forEach((slotIdx, i) => {
      combinedBreakdowns[slotIdx] = scaledBreakdowns[i] || [];
    });
  }
  if (nonDocSnapshotSlots.length > 0) {
    const scaledSnapshots = scaleTaxSnapshots(nonDocSnapshots, ratioNum, minorFactor);
    let snapCursor = 0;
    nonDocSnapshotSlots.forEach((slotIdx, i) => {
      combinedSnapshots[slotIdx] = nonDocSnapshots[i]
        ? (scaledSnapshots[snapCursor++] ?? null)
        : null;
    });
  }

  const itemTaxAmount = docTotalTax.plus(scaledNonDocTax).toNumber();
  const itemExclusiveTaxAmount = docExclusiveTax.plus(scaledNonDocExclusiveTax).toNumber();
  return {
    itemTaxAmount,
    itemExclusiveTaxAmount,
    taxRollup: combineItemAndChargeTaxes({
      itemTaxAmount,
      itemExclusiveTaxAmount,
      itemBreakdowns: combinedBreakdowns,
      itemSnapshots: combinedSnapshots,
      itemTaxRatio: 1,
      chargeTaxes: rollupChargeTaxes,
      minorFactor,
    }),
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
      online_platform,
      order_type,
      waived_charge_ids,
      opted_in_charge_ids,
    } = req.body;

    const hasOrderChargeContext =
      order_type !== undefined ||
      waived_charge_ids !== undefined ||
      opted_in_charge_ids !== undefined;
    if (hasOrderChargeContext && !VALID_CHARGE_ORDER_TYPES.includes(order_type)) {
      res
        .status(400)
        .json({ error: `order_type must be one of ${VALID_CHARGE_ORDER_TYPES.join(', ')}` });
      return;
    }
    if (
      [waived_charge_ids, opted_in_charge_ids].some(
        (list) =>
          list !== undefined &&
          list !== null &&
          (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')),
      )
    ) {
      res
        .status(400)
        .json({ error: 'waived_charge_ids and opted_in_charge_ids must be arrays of charge ids' });
      return;
    }

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Items are required' });
      return;
    }

    const db = getDatabase();

    // Get settings
    const settings: Record<string, string> = {};
    db.prepare('SELECT key, value FROM settings')
      .all()
      .forEach((row: any) => {
        settings[row.key] = row.value;
      });

    const tenantInfo: TenantInfo = {
      country: settings.country || '',
      business_type: settings.business_type || 'restaurant',
      state_code: settings.state_code || '',
      taxes_enabled: settings.taxes_enabled === 'true',
    };
    const currency = resolveTenantCurrency(settings.currency, tenantInfo.country);
    tenantInfo.currency = currency;
    const decimals = getCurrencyFractionDigits(currency);
    const minorFactor = getCurrencyMinorUnitFactor(currency);

    const customer = customer_id
      ? (db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id) as
          | Customer
          | undefined)
      : null;
    // Same pricing rule as order placement, including the online platform price.
    const isOnlineOrder = typeof online_platform === 'string' && online_platform.trim().length > 0;

    const itemResults: any[] = [];
    let totalSubtotalDec = new Decimal(0);

    const resolvedItems: Array<{
      product: Product;
      variant: any;
      unitPrice: number;
      quantity: number;
      itemDiscount: number;
      subtotal: number;
    }> = [];

    for (const itemData of items) {
      if (!itemData || typeof itemData !== 'object' || !itemData.product_id) {
        continue;
      }
      const product = db
        .prepare('SELECT * FROM products WHERE id = ?')
        .get(itemData.product_id) as any;
      if (!product) {
        console.warn(`[TaxPreview] Product with ID ${itemData.product_id} not found in database.`);
        continue;
      }

      // The cashier is quoted from the same catalog lookup the order is priced
      // from, so a variant basket cannot be quoted at the parent price.
      const variant = resolveOrderItemVariant(db, product, itemData, isOnlineOrder);
      const menuUnitPrice = variant
        ? variantUnitPrice(variant, isOnlineOrder)
        : parseFloat(product.price) || 0;
      // A cart line the owner has overridden is quoted at its override price.
      const overridePrice = Number(itemData.price_override?.price);
      const unitPrice =
        itemData.price_override && Number.isFinite(overridePrice) && overridePrice >= 0
          ? overridePrice
          : menuUnitPrice;
      const rawQty = Number(itemData.quantity);
      const quantity = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
      const rawDisc = Number(itemData.discount_amount);
      const itemDiscount = Number.isFinite(rawDisc) && rawDisc >= 0 ? rawDisc : 0;

      let subtotalDec = new Decimal(unitPrice).mul(quantity);
      if (itemData.addons) {
        for (const addon of itemData.addons) {
          subtotalDec = subtotalDec.plus(
            new Decimal(addon.price || 0).mul(addon.quantity || 1).mul(quantity),
          );
        }
      }
      subtotalDec = Decimal.max(0, subtotalDec.minus(itemDiscount));
      const subtotal = subtotalDec.toNumber();

      resolvedItems.push({
        product,
        variant,
        unitPrice,
        quantity,
        itemDiscount,
        subtotal,
      });
      totalSubtotalDec = totalSubtotalDec.plus(subtotalDec);
    }
    const totalSubtotal = totalSubtotalDec.toNumber();

    let packaging = normalizeChargeAmount(packaging_charge, 'packaging');
    const delivery = normalizeChargeAmount(delivery_charge, 'delivery');
    let service = normalizeChargeAmount(service_charge, 'service_charge');

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
      const subtotalDecimal = totalSubtotalDec;
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

    let appliedCharges: AppliedCharge[] | undefined;
    let otherCharges = new Decimal(0);
    if (hasOrderChargeContext) {
      const resolvedCharges = buildAppliedCharges({
        currency,
        orderType: order_type,
        subtotal: totalSubtotal,
        discountAmount: discountAmount.toNumber(),
        waivedIds: waived_charge_ids ?? [],
        optedInIds: opted_in_charge_ids ?? [],
      });
      if (resolvedCharges.ownsPackagingChargeColumn)
        packaging = resolvedCharges.columns.packaging_charge;
      if (resolvedCharges.ownsServiceChargeColumn) service = resolvedCharges.columns.service_charge;
      appliedCharges = resolvedCharges.charges;
      if (resolvedCharges.configured)
        otherCharges = new Decimal(resolvedCharges.columns.other_charges);
    }

    const chargeCategories = getConfiguredChargeTaxCategories(tenantInfo.country);
    const chargeContext: ChargeTaxContext = {
      packaging_charge: packaging,
      delivery_charge: delivery,
      service_charge: service,
      packaging_tax_category_id: chargeCategories.packaging?.categoryId || null,
      delivery_tax_category_id: chargeCategories.delivery?.categoryId || null,
      service_charge_tax_category_id: chargeCategories.service_charge?.categoryId || null,
    };

    const { itemResults: documentTaxResults, chargeTaxes } = calculateDocumentTaxes(tenantInfo, {
      items: resolvedItems.map((item, idx) => ({
        lineId: `line-${String(idx + 1).padStart(4, '0')}`,
        product: item.product,
        taxableAmount: item.subtotal,
      })),
      chargeContext,
      customer: customer || null,
    });

    for (let i = 0; i < resolvedItems.length; i++) {
      const item = resolvedItems[i];
      const taxResult = documentTaxResults[i];

      itemResults.push({
        product_id: item.product.id,
        product_name: item.product.name,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        subtotal: round(item.subtotal, decimals),
        discount_amount: item.itemDiscount,
        tax_amount: taxResult.tax_amount,
        tax_breakdown: taxResult.tax_breakdown,
        tax_type: taxResult.tax_type,
        total: round(
          item.subtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount),
          decimals,
        ),
      });
    }

    const subtotalDecimal = totalSubtotalDec;
    const discountedSubtotal = Decimal.max(0, subtotalDecimal.minus(discountAmount));
    const taxRatio =
      discountAmount.gt(0) && subtotalDecimal.gt(0)
        ? computeDiscountTaxRatio(discountedSubtotal, subtotalDecimal)
        : new Decimal(1);

    const { taxRollup } = rollupOrderTaxes({
      items: documentTaxResults.map((taxResult, idx) => ({
        taxAmount: taxResult.tax_amount,
        taxType: taxResult.tax_type,
        breakdown: taxResult.tax_breakdown || null,
        snapshot: taxResult.tax_snapshot || null,
        lineIdOverride: `line-${String(idx + 1).padStart(4, '0')}`,
      })),
      chargeTaxes,
      currency,
      decimals,
      minorFactor,
      itemTaxRatio: taxRatio,
      taxesEnabled: tenantInfo.taxes_enabled,
    });
    const aggregatedBreakdown = aggregateTaxBreakdown(taxRollup.breakdowns, minorFactor);
    const exactTotal = discountedSubtotal
      .plus(taxRollup.exclusiveTaxAmount)
      .plus(packaging)
      .plus(delivery)
      .plus(service)
      .plus(otherCharges)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
      .toNumber();
    const pack = getActiveCountryPack(tenantInfo.country);
    const { total, adjustment: roundOff } = applyPayableRounding(exactTotal, pack, currency);
    if (!Number.isSafeInteger(Math.round(total * minorFactor))) {
      throw new ChargeValidationError('Order total exceeds the supported currency precision');
    }

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
        ...(appliedCharges ? { charges_breakdown: appliedCharges } : {}),
      },
    });
  } catch (error: any) {
    console.error('[Tax] Preview error:', error);
    res
      .status(error.statusCode || 500)
      .json({ error: error.statusCode ? error.message : 'Internal server error' });
  }
}
