import Decimal from 'decimal.js';

interface TenantInfo {
  country: string;
  business_type: string;
  state_code: string;
}

interface Product {
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

interface TaxBreakdown {
  title: string;
  rate: number;
  amount: number;
}

const INDIA_FIXED_RATES: Record<string, number> = {
  restaurant: 5.0,
  salon: 5.0,
};

const THAILAND_VAT_RATE = 7.0;

import { COUNTRIES } from '../countries';
import { TaxEngine } from './tax-engine';
import type { CountryPack } from '../tax-packs/types';
import indiaPackData from '../tax-packs/in.json';
import thailandPackData from '../tax-packs/th.json';
import genericPackData from '../tax-packs/generic.json';

const INDIA_PACK = indiaPackData as CountryPack;
const THAILAND_PACK = thailandPackData as CountryPack;
const GENERIC_PACK = genericPackData as CountryPack;

function round(value: number, decimals: number = 2): number {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

// Same country -> bundled-pack selection used by calculateItemTax below and
// by the GET /api/tax/categories endpoint (routes/index.ts) — kept as one
// function so the two never drift apart on which pack is "active".
export function getActiveCountryPack(country: string): CountryPack {
  return country === 'IN' ? INDIA_PACK : country === 'TH' ? THAILAND_PACK : GENERIC_PACK;
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
  if (taxCategoryId) {
    const pack = getActiveCountryPack(tenant.country);
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
          productCategoryId: taxCategoryId,
          taxBehavior: product.tax_behavior
            || (product.tax_type === 'inclusive'
              ? 'inclusive'
              : product.tax_type === 'exclusive'
                ? 'exclusive'
                : 'country_default'),
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
        new Error(`Tax calculation failed: no tax rules apply to category ${taxCategoryId} for business type ${tenant.business_type}`),
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
      tax_snapshot: calculation.snapshot,
    };
  }

  if (product.tax_type === 'none') {
    return { tax_amount: 0, tax_breakdown: [], tax_type: 'none' };
  }

  const isRegistered = true; // In self-hosted, we assume tax settings are configured

  if (!isRegistered) {
    return { tax_amount: 0, tax_breakdown: [], tax_type: product.tax_type };
  }

  switch (tenant.country) {
    case 'IN':
      return calculateIndiaTax(tenant, product, taxableAmount, customer);
    case 'TH':
      return calculateThailandTax(product, taxableAmount);
    default:
      return calculateDefaultTax(product, taxableAmount, tenant.country);
  }
}

function calculateIndiaTax(
  tenant: TenantInfo,
  product: Product,
  taxableAmount: number,
  customer: Customer | null
): TaxResult {
  let rate: number;

  if (INDIA_FIXED_RATES[tenant.business_type]) {
    rate = INDIA_FIXED_RATES[tenant.business_type];
  } else {
    rate = product.tax_rate || 0;
  }

  if (rate <= 0) {
    return { tax_amount: 0, tax_breakdown: [], tax_type: product.tax_type };
  }

  const taxAmount = computeTaxAmount(product.tax_type, taxableAmount, rate);

  // Inter-state: IGST
  if (customer?.gstin && customer?.customer_state_code && tenant.state_code) {
    if (customer.customer_state_code !== tenant.state_code) {
      return {
        tax_amount: round(taxAmount, 2),
        tax_breakdown: [{ title: 'IGST', rate, amount: round(taxAmount, 2) }],
        tax_type: product.tax_type,
      };
    }
  }

  // Intra-state: CGST + SGST
  const halfRate = round(rate / 2, 2);
  const halfAmount = round(taxAmount / 2, 2);
  const otherHalf = round(taxAmount - halfAmount, 2);

  return {
    tax_amount: round(taxAmount, 2),
    tax_breakdown: [
      { title: 'CGST', rate: halfRate, amount: halfAmount },
      { title: 'SGST', rate: halfRate, amount: otherHalf },
    ],
    tax_type: product.tax_type,
  };
}

function calculateThailandTax(product: Product, taxableAmount: number): TaxResult {
  const rate = THAILAND_VAT_RATE;
  const taxAmount = computeTaxAmount(product.tax_type, taxableAmount, rate);

  return {
    tax_amount: round(taxAmount, 2),
    tax_breakdown: [{ title: 'VAT', rate, amount: round(taxAmount, 2) }],
    tax_type: product.tax_type,
  };
}

function calculateDefaultTax(product: Product, taxableAmount: number, country?: string): TaxResult {
  const rate = product.tax_rate || 0;

  if (rate <= 0) {
    return { tax_amount: 0, tax_breakdown: [], tax_type: product.tax_type };
  }

  const taxAmount = computeTaxAmount(product.tax_type, taxableAmount, rate);
  const title = (country && COUNTRIES.find((c) => c.code === country)?.taxName) || 'Tax';

  return {
    tax_amount: round(taxAmount, 2),
    tax_breakdown: [{ title, rate, amount: round(taxAmount, 2) }],
    tax_type: product.tax_type,
  };
}

function computeTaxAmount(taxType: string, amount: number, rate: number): number {
  if (taxType === 'inclusive') {
    return amount - (amount / (1 + rate / 100));
  }
  return amount * rate / 100;
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
// (order_items.tax_snapshot, only present for tax_category_id-driven items —
// see calculateItemTax above) into the order/bill-level tax_snapshot column.
// Items still on the legacy path have no snapshot and are simply omitted,
// same as aggregateTaxBreakdown already omits non-array breakdowns — a
// mixed order is not "wrong," it just doesn't have a snapshot for the part
// that was never migrated to a category.
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

export function calculateRoundOff(total: number): number {
  const rounded = Math.round(total);
  return round(rounded - total, 2);
}

// Tax preview endpoint handler
export async function calculateTaxPreview(req: any, res: any): Promise<void> {
  try {
    const { items, customer_id, packaging_charge } = req.body;

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

    const aggregatedBreakdown = aggregateTaxBreakdown(allBreakdowns);
    const packaging = packaging_charge || 0;
    const preRoundTotal = totalSubtotal + totalTax + packaging;
    const roundOff = calculateRoundOff(preRoundTotal);

    res.json({
      items: itemResults,
      summary: {
        subtotal: round(totalSubtotal, 2),
        tax_amount: round(totalTax, 2),
        tax_breakdown: aggregatedBreakdown,
        packaging_charge: packaging,
        round_off: roundOff,
        total: round(preRoundTotal + roundOff, 2),
      },
    });
  } catch (error: any) {
    console.error('[Tax] Preview error:', error);
    res.status(500).json({ error: "Internal server error" });
  }
}
