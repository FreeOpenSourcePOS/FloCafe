interface TenantInfo {
  country: string;
  business_type: string;
  state_code: string;
}

interface Product {
  tax_type: string;
  tax_rate: number;
}

interface Customer {
  gstin?: string;
  customer_state_code?: string;
}

interface TaxResult {
  tax_amount: number;
  tax_breakdown: TaxBreakdown[];
  tax_type: string;
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

const COUNTRY_TAX_NAMES: Record<string, string> = Object.fromEntries(
  COUNTRIES.map((c) => [c.code, c.taxName ?? 'Tax'])
);

function round(value: number, decimals: number = 2): number {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

export function calculateItemTax(
  tenant: TenantInfo,
  product: Product,
  taxableAmount: number,
  customer: Customer | null
): TaxResult {
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
  const title = (country && COUNTRY_TAX_NAMES[country]) || 'Tax';

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
          subtotal += (addon.price || 0) * quantity;
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
    res.status(500).json({ error: error.message });
  }
}