/**
 * print-document.ts
 *
 * Frontend bridge between the raw Bill/Order rows and the shared,
 * renderer-independent PrintDocument model (#444, epic #438).
 *
 * This is the ONLY step in the frontend print paths allowed to touch raw
 * bill/order fields. It normalizes them into the authoritative `PrintData`
 * snapshot (printed truth, no recomputation beyond the legacy addon-line
 * extension documented below) and builds the `PrintContext` (resolved
 * languages from the kernel policy, registry-derived base direction, locale
 * formatting prefs, and a pure label resolver backed by the shared locale
 * loader cache). Renderers (receipt-encoder, web-print) then consume only
 * document blocks + context — no bill field reads, no label literals.
 */

import {
  buildBillDocument,
  buildKotDocument,
  isKotItemPending,
  type LabelResolver,
  type KotDocument,
  type KotPrintData,
  type PrintContext,
  type PrintData,
  type PrintDocument,
} from '@print/document';
import { defaultPrintLanguagePolicy, resolveReceiptLanguages } from '@print/policy';
import type { PrintLanguageCode, ReceiptLanguagePolicy, ResolvedPrintLanguages } from '@print/types';
import { createTranslator } from 'use-intl/core';
import { getCachedMessages, loadLocaleMessages } from '@/lib/i18n/loader';
import { LANGUAGES, getLanguageDirection, type Language } from '@/lib/i18n/languages';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getCountryByCode } from '@countries';
import { resolveTaxComponents } from './tax-components';
import type { Bill, Order, OrderItem } from '@/lib/types';

/**
 * Business/contact facts + receipt show-flags for one print run. Mirrors the
 * flags the print dialogs have always passed alongside the bill; builders
 * apply them so renderers receive final content only.
 */
export interface BillBusinessOptions {
  businessName?: string;
  address?: string;
  phone?: string;
  footerNote?: string;
  instagramHandle?: string;
  taxRegistrationNumber?: string;
  /** Tax-id line requested by the surface (`includeTaxId`). */
  includeTaxId?: boolean;
  /** Pre-resolved country-profile tax-id label (GSTIN, کد اقتصادی, …). */
  taxIdLabel?: string;
  showTaxBreakdown?: boolean;
  showBusinessName?: boolean;
  showCustomerName?: boolean;
  showCustomerPhone?: boolean;
  showTableNumber?: boolean;
  isReprint?: boolean;
}

/** Resolve the active UI language, falling back to `en` outside the client store. */
export function resolveActiveUiLanguage(language?: Language): Language {
  if (language) return language;
  try {
    return usePosSettingsStore.getState().language;
  } catch {
    return 'en';
  }
}

/**
 * Ordered receipt languages for this client: kernel policy resolution over
 * the tenant-synced `billLanguagePolicy` (#441) with the UI language as the
 * `inherit` fallback.
 */
export function resolveBillPrintLanguages(uiLanguage?: Language): ResolvedPrintLanguages {
  let policy: ReceiptLanguagePolicy = defaultPrintLanguagePolicy();
  try {
    const stored = usePosSettingsStore.getState().billLanguagePolicy;
    if (stored) policy = stored;
  } catch {
    // Outside the client store (tests/SSR): inherit → English.
  }
  return resolveReceiptLanguages(policy, resolveActiveUiLanguage(uiLanguage));
}

/** Synchronous per-language translator backed by the shared loader cache. */
function translatorFor(language: Language | string): ((key: string) => string) | null {
  const lang = (Object.keys(LANGUAGES) as Language[]).includes(language as Language)
    ? (language as Language)
    : null;
  if (!lang) return null;
  const locale = LANGUAGES[lang]?.locale ?? 'en';
  const messages = getCachedMessages(lang) ?? getCachedMessages('en') ?? null;
  if (!messages) return null;
  // `createTranslator` resolves dotted keys against the whole message tree;
  // the cached messages are untyped, so the translator accepts any key here.
  return createTranslator({ locale, messages }) as unknown as (key: string) => string;
}

/**
 * Pure label-catalog lookup for PrintContext: concepts are the stable i18n
 * keys the generated backend catalog (#440) is derived from, resolved here
 * through the same shared messages with English fallback so a receipt never
 * renders raw keys.
 */
export const printLabelResolver: LabelResolver = (conceptId: string, language: string) => {
  const primary = translatorFor(language);
  if (primary) {
    const resolved = primary(conceptId);
    if (resolved !== conceptId) return resolved;
  }
  const fallback = translatorFor('en');
  return fallback ? fallback(conceptId) : conceptId;
};

/**
 * Ensure every requested receipt language's messages are loaded in memory
 * before a synchronous document build (#377). Locale loads are allowed to
 * fail (offline-first: printing must never block on a message bundle), but
 * the failed language codes are RETURNED so callers can surface a warning
 * through the established print-warning path instead of silently falling
 * back to English (Greptile P1, PR #474).
 */
export async function ensurePrintLanguagesLoaded(languages: ResolvedPrintLanguages): Promise<PrintLanguageCode[]> {
  const outcomes = await Promise.allSettled(
    languages.map((language) => loadLocaleMessages(language as Language)),
  );
  return languages.filter((_, index) => outcomes[index].status === 'rejected');
}

/** Base document direction for the primary language, from the central registry. */
function baseDirectionFor(languages: ResolvedPrintLanguages): ReturnType<typeof getLanguageDirection> {
  const primary = languages[0] as Language;
  try {
    return getLanguageDirection(primary);
  } catch {
    return 'ltr';
  }
}

function parsePaymentDetails(raw: Bill['payment_details']): Array<{ method: string; amount: number }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => ({
    method: String(entry?.method ?? ''),
    amount: Number(entry?.amount) || 0,
  }));
}

/**
 * Normalize a Bill (+ nested Order) into authoritative PrintData. The ONLY
 * place frontend print paths read raw rows. Tax components come from the
 * persisted snapshots/breakdowns via the shared reconciler — no tax math is
 * recomputed here.
 *
 * Addon lines: the legacy WebUSB classic layout prints an addon's extended
 * amount (`price × addonQty × itemQty`) as printed truth, so that value is
 * materialized here — renderers never repeat the multiplication.
 */
export function buildBillPrintData(bill: Bill, opts: BillBusinessOptions = {}): PrintData {
  const order = bill.order;
  const items = order?.items ?? [];

  const showTaxId = opts.includeTaxId === true && !!opts.taxRegistrationNumber;

  return {
    isReprint: opts.isReprint === true,
    order: {
      orderNumber: String(order?.order_number ?? ''),
      createdAt: String(order?.created_at ?? ''),
      tableName: String(order?.table?.name ?? ''),
      onlinePlatform: String(order?.online_platform ?? ''),
      externalOrderId: String(order?.external_order_id ?? ''),
      items: items.map((item) => ({
        productName: String(item?.product_name ?? ''),
        quantity: Number(item?.quantity) || 0,
        unitPrice: Number(item?.unit_price) || 0,
        total: Number(item?.total) || 0,
        addons: (Array.isArray(item?.addons) ? item.addons : []).map((addon) => {
          const addonQty = (addon !== null && typeof addon === 'object' && 'quantity' in addon
            && typeof addon.quantity === 'number' && addon.quantity) || 1;
          return {
            name: String(addon?.name ?? ''),
            price: (Number(addon?.price) || 0) * addonQty * (Number(item?.quantity) || 0),
            quantity: addonQty,
          };
        }),
        specialInstructions: String(item?.special_instructions ?? ''),
      })),
    },
    bill: {
      billNumber: String(bill?.bill_number ?? ''),
      subtotal: Number(bill?.subtotal) || 0,
      discountAmount: Number(bill?.discount_amount) || 0,
      taxAmount: Number(bill?.tax_amount) || 0,
      total: Number(bill?.total) || 0,
      serviceCharge: Number(bill?.service_charge) || 0,
      deliveryCharge: Number(bill?.delivery_charge) || 0,
      packagingCharge: Number(bill?.packaging_charge) || 0,
      taxComponents: resolveTaxComponents(bill),
      payments: parsePaymentDetails(bill?.payment_details),
      pointsEarned: Number(bill?.points_earned) || 0,
      pointsRedeemed: Number(bill?.points_redeemed) || 0,
      pointsBalance: Object.prototype.hasOwnProperty.call(bill || {}, 'points_balance')
        ? Number(bill?.points_balance) || 0
        : null,
    },
    business: {
      name: String(opts.businessName ?? ''),
      address: String(opts.address ?? ''),
      phone: String(opts.phone ?? ''),
      taxRegistrationNumber: String(opts.taxRegistrationNumber ?? ''),
      taxIdLabel: String(opts.taxIdLabel ?? ''),
      instagramHandle: String(opts.instagramHandle ?? ''),
      footerNote: String(opts.footerNote ?? ''),
      customerName: String(order?.customer?.name ?? ''),
      customerPhone: String(order?.customer?.phone ?? ''),
      showName: opts.showBusinessName !== false,
      showAddress: !!opts.address,
      showPhone: !!opts.phone,
      showTaxId: showTaxId ? 'force' : 'never',
      showTaxBreakdown: opts.showTaxBreakdown === true,
      showTableNumber: opts.showTableNumber !== false,
      showCustomerName: opts.showCustomerName !== false,
      showCustomerPhone: opts.showCustomerPhone !== false,
    },
  };
}

/**
 * Build the PrintContext for a frontend bill document: paper columns,
 * resolved languages, registry-derived direction, and locale/currency
 * presentation prefs from the existing regionalization helpers.
 */
/** Tenant fields the frontend print context needs for presentation prefs. */
export interface FrontendTenantPrefs {
  currency?: string | null;
  country?: string | null;
  timezone?: string | null;
}

export function buildBillPrintContext(opts: {
  /** Receipt language list (already resolved from settings/policy). */
  languages: ResolvedPrintLanguages;
  /** Tenant slice used for locale/currency presentation prefs. */
  tenant: FrontendTenantPrefs;
  columns?: number;
  trimDecimals?: boolean;
}): PrintContext {
  const country = getCountryByCode(opts.tenant.country ?? '');
  return {
    columns: opts.columns ?? 42,
    languages: opts.languages,
    baseDirection: baseDirectionFor(opts.languages),
    locale: LANGUAGES[opts.languages[0] as Language]?.locale ?? country?.locale ?? 'en-US',
    currencySymbol: String(opts.tenant.currency ?? ''),
    trimDecimals: opts.trimDecimals === true,
    ...(opts.tenant.timezone ? { timezone: String(opts.tenant.timezone) } : {}),
    resolveLabel: printLabelResolver,
  };
}

/** Data → document: the single entry point every frontend renderer calls. */
export function buildFrontendBillDocument(
  bill: Bill,
  tenant: Parameters<typeof buildBillPrintContext>[0]['tenant'],
  opts: BillBusinessOptions & { columns?: number; trimDecimals?: boolean; languages?: ResolvedPrintLanguages } = {},
): PrintDocument {
  const languages = opts.languages ?? resolveBillPrintLanguages();
  const printData = buildBillPrintData(bill, opts);
  const printContext = buildBillPrintContext({
    languages,
    tenant,
    ...(opts.columns !== undefined ? { columns: opts.columns } : {}),
    ...(opts.trimDecimals !== undefined ? { trimDecimals: opts.trimDecimals } : {}),
  });
  return buildBillDocument(printData, printContext);
}

export function buildFrontendKotDocument(
  order: Order,
  opts: {
    stationName: string;
    items?: readonly OrderItem[];
    columns: number;
    language: string;
    timezone?: string;
  },
): KotDocument {
  const languages = [opts.language] as ResolvedPrintLanguages;
  const items = opts.items ?? order.items ?? [];
  const printData: KotPrintData = {
    stationName: String(opts.stationName ?? ''),
    order: {
      orderNumber: String(order.order_number ?? ''),
      createdAt: String(order.created_at ?? ''),
      tableName: String(order.table?.name ?? ''),
      orderType: String(order.type ?? '').trim(),
      customerName: String(order.customer?.name ?? '').trim(),
    },
    items: items.filter((item) => isKotItemPending(item.status)).map((item) => ({
      productName: String(item.product_name ?? ''),
      quantity: Number(item.quantity) || 0,
      addons: (Array.isArray(item.addons) ? item.addons : []).map((addon) => ({
        name: String(addon?.name ?? ''),
        ...(typeof addon?.quantity === 'number' && Number.isFinite(addon.quantity) && addon.quantity > 0
          ? { quantity: addon.quantity }
          : {}),
      })),
      specialInstructions: String(item.special_instructions ?? ''),
    })),
  };
  const printContext: PrintContext = {
    columns: opts.columns,
    languages,
    baseDirection: baseDirectionFor(languages),
    locale: LANGUAGES[opts.language as Language]?.locale ?? 'en-US',
    currencySymbol: '',
    trimDecimals: false,
    ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
    resolveLabel: printLabelResolver,
  };
  return buildKotDocument(printData, printContext);
}
