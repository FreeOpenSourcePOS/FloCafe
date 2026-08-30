/**
 * Cross-renderer receipt parity & regression contract (#439, epic #438).
 *
 * Treats receipt SEMANTIC content — items, totals, discounts, payments,
 * reprint banners, headers — as a contract shared by every print renderer,
 * independent of bytes or cosmetic formatting:
 *
 *   1. Backend ESC/POS   main/printers/thermal.ts  (classic + compact)
 *   2. Frontend ESC/POS  frontend receipt-encoder  (classic + compact, WebUSB)
 *   3. Browser HTML      frontend web-print        (system print dialog)
 *
 * Assertions are semantic (content present / explicit warning recorded),
 * never byte-level snapshots. Amounts are matched after stripping grouping
 * separators so en-IN ("5,00,000") and en-US ("500,000") styles both pass.
 *
 * LEGACY BEHAVIOR MARKERS: assertions describing today's "skip unsupported
 * scripts + emit warning" contract are explicitly marked LEGACY. The
 * multilingual print epic will deliberately replace silent skipping with an
 * explicit capability model; when that happens these marked assertions must
 * be updated intentionally — they are NOT permanent architecture.
 *
 * Issue: https://github.com/FreeOpenSourcePOS/FloCafe/issues/439
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  formatReceipt,
  formatKOT,
  escPosToText,
  buildEscPos,
} from '../main/printers/thermal';
import { renderClassicReceiptViaDocument } from '../main/printers/document-classic';
import {
  formatClassicReceiptLegacy,
  formatCompactReceiptLegacy,
  formatKOTLegacy,
} from './helpers/legacy-thermal-oracle';
import { printLabel } from '../main/print/print-labels.generated';
import {
  buildBillPrintContext,
  buildBillPrintData,
  renderBillDocumentToClassicLines,
} from '../main/printers/document-classic';
import {
  applyMerchantTemplate,
  buildBillDocument,
  resolveKotLanguage,
  resolveReceiptLanguages,
  validateMerchantTemplate,
} from '../shared/print';

// ---------------------------------------------------------------------------
// Frontend module loading (same technique as tests/printer.test.ts: the
// production path aliases cannot be applied by plain ts-node, so requests
// are remapped for the duration of each require).
// ---------------------------------------------------------------------------

function loadFrontendPrintModules(): {
  receiptEncoder: typeof import('../frontend/src/lib/printer/receipt-encoder');
  webPrint: typeof import('../frontend/src/lib/printer/web-print');
  warnings: typeof import('../frontend/src/lib/printer/warnings');
} {
  const path = require('path') as typeof import('path');
  const moduleApi = require('module') as {
    _resolveFilename: (...args: any[]) => string;
  };
  const originalResolveFilename = moduleApi._resolveFilename;
  moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    let resolvedRequest = request;
    if (request === '@countries') {
      resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
    } else if (request.startsWith('@/')) {
      resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
    } else if (request.startsWith('@print/')) {
      resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };
  try {
    return {
      receiptEncoder: require('../frontend/src/lib/printer/receipt-encoder'),
      webPrint: require('../frontend/src/lib/printer/web-print'),
      warnings: require('../frontend/src/lib/printer/warnings'),
    };
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures (exported so later print-architecture issues reuse them)
// ---------------------------------------------------------------------------

const PERSIAN_ITEM = 'چای زعفرانی مخصوص';
const LATIN_ITEM = 'Espresso Doppio';
/** Stem that survives fixed-width truncation at the narrowest tested width. */
const LONG_NAME_STEM = 'Extra Long';
const LONG_ITEM = 'Extra Long Caramelized Vanilla Bean Creme Frappuccino With Extra Whipped Cream And Caramel Drizzle';

export function buildParityFixtures() {
  const order: any = {
    order_number: 'ORD-PARITY-001',
    created_at: '2026-08-21 18:42:00',
    table_id: 4,
    table: { name: '4' },
    customer: { name: 'Asha Kumar', phone: '+91 98765 43210' },
    items: [
      {
        product_name: LATIN_ITEM,
        quantity: 2,
        unit_price: 250,
        total: 500,
        tax_amount: 0,
        addons: [{ name: 'Oat milk', price: 40 }],
        special_instructions: 'Less sugar',
      },
      {
        product_name: PERSIAN_ITEM,
        quantity: 1,
        unit_price: 300,
        total: 300,
        tax_amount: 0,
        addons: [],
        special_instructions: '',
      },
      {
        product_name: LONG_ITEM,
        quantity: 1,
        unit_price: 420,
        total: 420,
        tax_amount: 0,
        addons: [{ name: 'No-price extra shot', price: 0 }],
        special_instructions: '',
      },
    ],
  };

  const bill: any = {
    bill_number: 'INV-PARITY-001',
    subtotal: 1220,
    discount_amount: 120,
    tax_amount: 0,
    service_charge: 0,
    delivery_charge: 0,
    total: 1100,
    payment_details: [
      { method: 'cash', amount: 600 },
      { method: 'card', amount: 500 },
    ],
  };
  // Frontend renderers navigate bill.order for items/table/customer.
  bill.order = order;

  const business: any = {
    name: 'Flo Parity Cafe',
    address: '12 Marina Boulevard',
    phone: '9876543210',
    taxRegistrationNumber: 'GSTIN123456',
    currency_symbol: '₹',
    country: 'IN',
    customer_name: '',
    customer_phone: '',
    points_earned: 0,
    points_redeemed: 0,
    points_balance: null,
    trim_decimals: false,
    show_name: true,
    show_address: true,
    show_phone: true,
    show_tax_id: true,
    show_tax_breakdown: false,
    show_table_number: true,
    show_customer_name: true,
    show_customer_phone: true,
    footer_note: '',
  };

  const tenant = {
    business_name: 'Flo Parity Cafe',
    currency: 'INR',
    country: 'IN',
    timezone: 'Asia/Kolkata',
    currency_display: 'symbol',
    number_digits: 'latn',
    calendar: 'gregory',
  } as const;

  return { order, bill, business, tenant };
}

type Warnings = import('../frontend/src/lib/printer/warnings').PrintWarning[];

/** Digit-normalizing content probe: immune to grouping/locale separator styles. */
function digitsOf(text: string): string {
  return text.replace(/[^\d]/g, '');
}

/**
 * Split rendered output into logical rows so amount assertions can be scoped
 * to the row carrying their label. ESC/POS text is newline-separated; the
 * browser HTML path is split into <tr> rows with tags stripped.
 */
function contentRows(text: string): string[] {
  const raw = /<tr[\s>]/i.test(text)
    ? (text.match(/<tr[\s\S]*?<\/tr>/gi) ?? [])
    : text.split(/\r?\n/);
  return raw.map((row) => row.replace(/<[^>]+>/g, ' '));
}

/** First row whose label matches `pattern` (optionally excluding `except`). */
function labeledRow(rows: string[], pattern: RegExp, except?: RegExp): string | undefined {
  return rows.find((row) => pattern.test(row) && !(except && except.test(row)));
}

/** Amount digits must appear inside the specific labeled row, not anywhere. */
function rowAmountPresent(rows: string[], pattern: RegExp, amount: number, except?: RegExp): boolean {
  const row = labeledRow(rows, pattern, except);
  return row != null && digitsOf(row).includes(String(amount));
}

function expectContent(
  label: string,
  text: string,
  expectations: {
    items: string[];
    absentItems?: string[];
    /** Required where the renderer prints a subtotal line (compact WebUSB intentionally omits it). */
    subtotal?: number;
    discount?: number;
    total: number;
    payments?: string[];
    reprint?: boolean;
    reprintStyle?: 'ascii' | 'html';
    businessName: string;
    truncationMarker?: boolean;
  },
  warn: (ok: boolean, msg: string) => void
): void {
  const normalized = text.replace(/[,\s]/g, '');
  for (const item of expectations.items) {
    warn(normalized.includes(item.replace(/[,\s]/g, '')), `${label}: item "${item.slice(0, 24)}${item.length > 24 ? '…' : ''}" present`);
  }
  for (const absent of expectations.absentItems ?? []) {
    warn(!text.includes(absent), `${label}: known-absent item correctly not rendered verbatim`);
  }
  // Amount assertions are field-scoped: each expected amount must appear on
  // the row carrying its own label (Subtotal / Discount / TOTAL), so stray
  // digits elsewhere (item rows, payments, phone numbers) cannot satisfy them.
  const rows = contentRows(text);
  if (expectations.subtotal != null) {
    warn(rowAmountPresent(rows, /sub\s*total/i, expectations.subtotal), `${label}: subtotal ${expectations.subtotal} on Subtotal row`);
  }
  if (expectations.discount != null) {
    warn(rowAmountPresent(rows, /discount/i, expectations.discount), `${label}: discount ${expectations.discount} on Discount row`);
  }
  warn(rowAmountPresent(rows, /total/i, expectations.total, /sub\s*total/i), `${label}: total ${expectations.total} on TOTAL row`);
  for (const p of expectations.payments ?? []) {
    warn(text.includes(p), `${label}: payment "${p}"`);
  }
  if (expectations.reprint != null && expectations.reprint) {
    const banner = expectations.reprintStyle === 'html'
      ? text.includes('class="reprint-banner"')
      : /\*{2}\s*REPRINT/i.test(text);
    warn(banner, `${label}: reprint banner=${expectations.reprint}`);
  }
  warn(text.includes(expectations.businessName), `${label}: business header`);
  if (expectations.truncationMarker) {
    warn(text.includes(LONG_NAME_STEM) && text.includes('..'), `${label}: long item truncated with marker`);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function warn(ok: boolean, msg: string): void {
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

function run(): void {
  const { order, bill, business, tenant } = buildParityFixtures();
  const fe = loadFrontendPrintModules();

  const baseExpect = {
    items: [LATIN_ITEM, LONG_NAME_STEM],
    discount: 120,
    total: 1100,
    payments: ['Cash', 'Card'],
    businessName: 'Flo Parity Cafe',
    truncationMarker: true,
  };

  // ------------------------------------------------------------------
  // 1. Backend ESC/POS — classic + compact at 32/42/48 columns
  // ------------------------------------------------------------------
  for (const template of ['classic', 'compact'] as const) {
    for (const cols of [32, 42, 48]) {
      section(`Backend ${template} @ ${cols} cols`);
      const warnings: Warnings = [];
      const text = escPosToText(
        formatReceipt(order, bill, business, template, cols, false, false, undefined, warnings)
      );
      // LEGACY: Persian-script line is skipped by the unsupported-character
      // guard (see #437/#355 history). This documents current behavior; do
      // not treat it as the future architecture contract.
      const withSubtotal = template === 'classic' ? { subtotal: 1220 } : {};
      expectContent(`${template}/${cols}`, text, { ...baseExpect, ...withSubtotal, absentItems: [PERSIAN_ITEM] }, warn);
      warn(warnings.some((w) => (w.message ?? w.text ?? '').includes('Persian/Arabic')),
        `${template}/${cols}: skip produced explicit Persian/Arabic warning`);

      section(`Backend ${template} @ ${cols} cols — reprint`);
      const reText = escPosToText(
        formatReceipt(order, bill, business, template, cols, false, true, undefined, [])
      );
      expectContent(`${template}/${cols}/reprint`, reText, { ...baseExpect, ...withSubtotal, absentItems: [PERSIAN_ITEM], reprint: true }, warn);
    }
  }

  // ------------------------------------------------------------------
  // 2. Frontend WebUSB ESC/POS — classic + compact at 58mm(42c)/80mm(48c)
  // ------------------------------------------------------------------
  for (const variant of ['classic', 'compact'] as const) {
    for (const paperWidth of [58, 80] as const) {
      section(`WebUSB ${variant} @ ${paperWidth}mm`);
      const warnings: Warnings = [];
      const bytes = variant === 'classic'
        ? fe.receiptEncoder.buildClassicReceiptBytes(bill as any, tenant as any, { paperWidth }, warnings as any)
        : fe.receiptEncoder.buildCompactReceiptBytes(bill as any, tenant as any, { paperWidth }, warnings as any);
      const text = new TextDecoder().decode(bytes);
      // LEGACY: same skip-with-warning contract as backend (safePrinterText).
      const feSubtotal = variant === 'classic' ? { subtotal: 1220 } : {};
      // LEGACY: the WebUSB 4-column layout truncates over-long item names with
      // a '…' ellipsis, which is itself non-ASCII — so the unsupported-char
      // guard drops the ENTIRE row (with a warning). The desktop path
      // truncates with '..' and keeps the line. This asymmetry is today's
      // documented behavior, not the target architecture.
      expectContent(`webusb/${variant}/${paperWidth}`, text, {
        ...baseExpect,
        ...feSubtotal,
        items: [LATIN_ITEM],
        absentItems: [PERSIAN_ITEM, LONG_NAME_STEM],
        truncationMarker: false,
      }, warn);
      warn(warnings.some((w) => (w.message ?? '').includes('Persian/Arabic')),
        `webusb/${variant}/${paperWidth}: skip produced explicit Persian/Arabic warning`);
      warn(warnings.some((w) => (w.message ?? '').includes('unsupported characters') && (w.text ?? '').includes('Extra Long')),
        `webusb/${variant}/${paperWidth}: long-name row skipped with explicit unsupported-chars warning`);
    }
  }

  section('WebUSB reprint banner');
  {
    const bytes = fe.receiptEncoder.buildClassicReceiptBytes(
      bill as any,
      tenant as any,
      { paperWidth: 80, isReprint: true },
      []
    );
    expectContent('webusb/classic/reprint', new TextDecoder().decode(bytes), {
      ...baseExpect,
      subtotal: 1220,
      items: [LATIN_ITEM],
      absentItems: [PERSIAN_ITEM, LONG_NAME_STEM],
      truncationMarker: false,
      reprint: true,
    }, warn);
  }

  // ------------------------------------------------------------------
  // 3. Browser HTML — full Unicode path (Persian MUST be present here)
  // ------------------------------------------------------------------
  for (const paperSize of ['thermal58', 'thermal80'] as const) {
    section(`Browser HTML @ ${paperSize}`);
    const html = fe.webPrint.generateBillHtml(bill as any, tenant as any, {
      paperSize,
      address: business.address,
      phone: business.phone,
      businessName: business.name,
      taxRegistrationNumber: business.taxRegistrationNumber,
      includeTaxId: true,
      showBusinessName: true,
      showCustomerName: true,
      showCustomerPhone: true,
      showTableNumber: true,
    });
    expectContent(`html/${paperSize}`, html, { ...baseExpect, subtotal: 1220, truncationMarker: false, items: [LATIN_ITEM, LONG_ITEM, PERSIAN_ITEM] }, warn);
    warn(html.includes('<table'), `html/${paperSize}: structured markup present`);
  }

  section('Browser HTML reprint banner');
  {
    const html = fe.webPrint.generateBillHtml(bill as any, tenant as any, {
      paperSize: 'thermal80',
      businessName: business.name,
      isReprint: true,
    });
    expectContent('html/reprint', html, { ...baseExpect, subtotal: 1220, truncationMarker: false, items: [LATIN_ITEM, LONG_ITEM, PERSIAN_ITEM], reprint: true, reprintStyle: 'html' }, warn);
  }

  section('Browser HTML uses semantic catalog labels and fallback');
  {
    const html = fe.webPrint.generateBillHtml(bill as any, tenant as any, {
      paperSize: 'thermal80',
      businessName: business.name,
      address: business.address,
      phone: business.phone,
      showCustomerName: true,
      showCustomerPhone: true,
      showTableNumber: true,
    });
    for (const [concept, expected] of [
      ['receipt.billNumber', 'Bill #'],
      ['receipt.date', 'Date'],
      ['pos.tableLabel', 'Table'],
      ['pos.customer', 'Customer'],
      ['print.numberShort', 'Customer No'],
      ['receipt.item', 'Item'],
      ['receipt.qty', 'Qty'],
      ['receipt.rate', 'Rate'],
      ['receipt.amount', 'Amount'],
      ['pos.subtotal', 'Subtotal'],
      ['pos.discount', 'Discount'],
      ['receipt.grandTotal', 'Grand Total'],
      ['receipt.payments', 'Payments'],
      ['pos.methodCash', 'Cash'],
      ['pos.methodCard', 'Card'],
      ['receipt.thankYou', 'Thank you for your visit!'],
    ] as const) {
      warn(html.includes(expected), `browser semantic label ${concept} renders as ${expected}`);
    }
    const fallback = fe.webPrint.generateBillHtml(bill as any, tenant as any, {
      languages: ['unknown-language'] as any,
    });
    warn(fallback.includes('<strong>Grand Total</strong>') && !fallback.includes('receipt.grandTotal'),
      'browser unknown language uses English catalog fallback without leaking a key');
  }

  // ------------------------------------------------------------------
  // 4. PrintDocument pipeline vs LEGACY ORACLE (#443): every migrated
  //    backend surface (classic, compact, KOT) must reproduce its frozen
  //    pre-migration output BYTE FOR BYTE at every tested width, including
  //    Persian-item skip rules and reprint banners.
  // ------------------------------------------------------------------
  const kotOrder = {
    order_number: order.order_number,
    created_at: order.created_at,
    table: { name: '4' },
  };

  section('PrintDocument vs legacy classic');
  for (const cols of [32, 42, 48]) {
    for (const isReprint of [false, true] as const) {
      const label = `document/${cols}${isReprint ? '/reprint' : ''}`;
      section(label);
      const legacyWarnings: Warnings = [];
      const legacyText = escPosToText(
        formatClassicReceiptLegacy(order, bill, business, cols, false, isReprint, 'full', legacyWarnings, false, 'en'),
      );
      const docResult = renderClassicReceiptViaDocument(order, bill, business, {
        columns: cols,
        language: 'en',
        isReprint,
        useUnicode: false,
        arabicShaping: false,
        cutMode: 'full' as const,
      });
      const docText = escPosToText(docResult.data);
      warn(legacyText === docText, `${label}: identical output to legacy classic`);
      const withSubtotal = { subtotal: 1220 };
      expectContent(label, docText, {
        ...baseExpect,
        ...withSubtotal,
        absentItems: [PERSIAN_ITEM],
        ...(isReprint ? { reprint: true } : {}),
      }, warn);
      warn(docResult.document.version === 1 && docResult.document.blocks.length > 0, `${label}: PrintDocument v1 with blocks`);
      if (!isReprint) {
        warn(docResult.warnings.some((w) => (w.message ?? w.text ?? '').includes('Persian/Arabic')),
          `${label}: skip produced explicit Persian/Arabic warning`);
      }
    }
  }

  section('PrintDocument vs legacy compact');
  for (const cols of [32, 42, 48]) {
    for (const isReprint of [false, true] as const) {
      const label = `compact-document/${cols}${isReprint ? '/reprint' : ''}`;
      section(label);
      const legacyWarnings: Warnings = [];
      const legacyBuf = formatCompactReceiptLegacy(order, bill, business, cols, false, isReprint, 'full', legacyWarnings, false, 'en');
      // Production entry point: formatReceipt('compact') is document-driven
      // since #443, so this compares the migrated pipeline against the oracle.
      const migratedBuf = formatReceipt(order, bill, business, 'compact', cols, false, isReprint, 'full', [], false, 'en');
      warn(legacyBuf.equals(migratedBuf), `${label}: byte-identical output to legacy compact`);
      expectContent(label, escPosToText(migratedBuf), {
        ...baseExpect,
        absentItems: [PERSIAN_ITEM],
        ...(isReprint ? { reprint: true } : {}),
      }, warn);
    }
  }

  section('PrintDocument vs legacy KOT');
  for (const cols of [32, 42, 48]) {
    const label = `kot-document/${cols}`;
    section(label);
    const legacyWarnings: Warnings = [];
    const legacyBuf = formatKOTLegacy(kotOrder, order.items, 'Main Kitchen', cols, false, 'full', 'en-US', { timeZone: 'Asia/Kolkata' }, legacyWarnings, false, 'en');
    const migratedBuf = formatKOT(kotOrder, order.items, 'Main Kitchen', cols, false, 'full', 'en-US', { timeZone: 'Asia/Kolkata' }, [], false, 'en');
    warn(legacyBuf.equals(migratedBuf), `${label}: byte-identical output to legacy KOT`);
    const kotText = escPosToText(migratedBuf);
    warn(kotText.includes('Main Kitchen'), `${label}: station block rendered`);
    warn(kotText.includes('2x  Espresso Doppio'), `${label}: item rows with quantity prefix`);
    warn(kotText.includes('+ Oat milk'), `${label}: addon lines rendered`);
    warn(kotText.includes('** Less sugar **'), `${label}: instruction lines rendered`);
    if (cols >= 42) warn(!kotText.includes(PERSIAN_ITEM), `${label}: unsupported-script item skipped with warning only`);
  }

  // ------------------------------------------------------------------
  // 5. Receipt/KOT language routing (#443): fa/es/fr tenants get localized
  //    labels end-to-end through the resolved policy; the KOT kitchen
  //    policy resolves independently of the receipt language.
  // ------------------------------------------------------------------
  section('Localized receipt labels end-to-end');
  for (const language of ['fa', 'es', 'fr'] as const) {
    for (const template of ['classic', 'compact'] as const) {
      const label = `${template}/${language}`;
      const warnings: Warnings = [];
      // Shaping-capable profile: localized label text may actually print.
      const text = escPosToText(
        formatReceipt(order, bill, business, template, 42, false, false, 'full', warnings, true, language),
      );
      const totalLabel = printLabel(language, 'print.grandTotal');
      warn(text.includes(totalLabel), `${label}: grand-total label localized (${totalLabel})`);
      const subtotalLabel = printLabel(language, 'pos.subtotal');
      warn(text.includes(subtotalLabel), `${label}: subtotal label localized (${subtotalLabel})`);
    }
  }

  section('KOT language policy independence');
  {
    // Store language fa + inherit KOT policy → kitchen tickets follow the store.
    const inherited = resolveKotLanguage({ primary: { mode: 'inherit' }, additional: [] as const }, 'fa');
    warn(inherited === 'fa', 'KOT inherit policy follows the store language');
    // Fixed kitchen policy overrides the store language independently.
    const fixedEn = resolveKotLanguage({ primary: { mode: 'fixed', language: 'en' }, additional: [] as const }, 'fa');
    warn(fixedEn === 'en', 'KOT fixed policy overrides the store language');
    // Receipt policy with an additional language resolves primary first.
    const receiptLangs = resolveReceiptLanguages(
      { primary: { mode: 'inherit' }, additional: ['es'] as const },
      'fa',
    );
    warn(receiptLangs[0] === 'fa' && receiptLangs[1] === 'es', 'receipt policy resolves primary + additional');
    // A fixed-en KOT ticket stays English even for a fa store (#443).
    const kotTextEn = escPosToText(formatKOT(kotOrder, order.items, 'Main Kitchen', 42, false, 'full', 'en-US', undefined, [], false, fixedEn));
    warn(kotTextEn.includes('Time:'), 'fixed-en KOT ticket renders English time label');
  }

  // ------------------------------------------------------------------
  // 6. Merchant-template mode (#447): a semantic merchant template is
  //    applied at the PrintDocument layer, so the same template must
  //    render byte-identically through every document-driven renderer.
  //    The golden fixture (all blocks visible, canonical order) must be
  //    an identity transform on the rendered bytes.
  // ------------------------------------------------------------------
  section('Merchant-template mode (golden fixture = identity)');
  {
    const fixturePath = path.join(__dirname, 'fixtures/merchant-templates/golden-receipt-v1.json');
    const validation = validateMerchantTemplate(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
    if (!validation.ok) {
      warn(false, `golden merchant fixture validates: ${validation.errors.join('; ')}`);
    } else {
      for (const cols of [32, 42, 48]) {
        const printData = buildBillPrintData(order, bill, business, false);
        const printContext = buildBillPrintContext({ columns: cols, language: 'en', business });
        const baseDocument = buildBillDocument(printData, printContext);
        const merchantDocument = applyMerchantTemplate(baseDocument, validation.payload);
        warn(
          JSON.stringify(merchantDocument.blocks) === JSON.stringify(baseDocument.blocks),
          `merchant/${cols}: canonical all-blocks template is an identity on blocks`,
        );
        const classicOptions = {
          columns: cols,
          language: printContext.languages[0],
          locale: printContext.locale,
          ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
          currencySymbol: printContext.currencySymbol,
          trimDecimals: printContext.trimDecimals,
          useUnicode: false,
          arabicShaping: false,
          cutMode: 'full' as const,
        };
        const classicBytes = buildEscPos(
          renderBillDocumentToClassicLines(baseDocument, classicOptions),
          false, { cutMode: 'full' as const, arabicShaping: false, columns: cols }, [],
        );
        const merchantBytes = buildEscPos(
          renderBillDocumentToClassicLines(merchantDocument, classicOptions),
          false, { cutMode: 'full' as const, arabicShaping: false, columns: cols }, [],
        );
        warn(Buffer.compare(classicBytes, merchantBytes) === 0,
          `merchant/${cols}: identical bytes across renderers through the applied template`);
      }
    }
  }

  console.log('\n' + '='.repeat(56));
  console.log(`Parity contract: ${passed} assertions passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  run();
}
