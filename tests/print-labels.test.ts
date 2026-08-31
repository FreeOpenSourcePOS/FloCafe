/**
 * Print label localization tests (#440, epic #438).
 *
 * The backend thermal renderers resolve receipt/KOT/test-page labels through
 * the generated derived view (`main/print/print-labels.generated.ts`) backed
 * by canonical locale messages. This suite asserts:
 *
 *   1. printLabel selects en/fa/es/fr/pt tables and falls back to English for
 *      unknown languages (never raw keys).
 *   2. formatReceipt / formatKOT / buildTestPage honor the optional
 *      `language` parameter with English as the default.
 *   3. Payment methods localize through pos.method* keys; unknown methods
 *      keep the capitalize fallback.
 *   4. Regeneration is byte-identical (drift check also runs separately via
 *      `node scripts/generate-print-labels.cjs --check`, wired into
 *      `npm run i18n:check` and `test:print-labels`).
 *
 * Run: npm run test:print-labels
 */

import {
  formatReceipt,
  formatKOT,
  buildTestPage,
  escPosToText,
} from '../main/printers/thermal';
import {
  printLabel,
} from '../main/print/print-labels.generated';
import { renderCompactReceiptViaDocument } from '../main/printers/document-compact';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`   ✓ ${label}`);
    passed++;
  } else {
    console.log(`   ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
  }
}

function buildOrder(): any {
  return {
    order_number: 'ORD-LABELS-001',
    created_at: '2026-08-21 18:42:00',
    table: { name: '7' },
    items: [{
      product_name: 'Espresso',
      quantity: 1,
      unit_price: 250,
      total: 250,
      addons: [],
      special_instructions: '',
    }],
  };
}

function buildBill(): any {
  return {
    bill_number: 'INV-LABELS-001',
    subtotal: 250,
    discount_amount: 0,
    tax_amount: 0,
    service_charge: 0,
    delivery_charge: 0,
    total: 250,
    payment_details: [{ method: 'cash', amount: 250 }],
  };
}

function buildBusiness(extra: Record<string, unknown> = {}): any {
  return {
    name: 'Flo Label Cafe',
    address: '',
    phone: '',
    taxRegistrationNumber: '',
    currency_symbol: '$',
    country: 'US',
    customer_name: '',
    customer_phone: '',
    points_earned: 0,
    points_redeemed: 0,
    points_balance: null,
    trim_decimals: false,
    show_name: true,
    show_address: true,
    show_phone: true,
    show_tax_id: false,
    show_tax_breakdown: false,
    show_table_number: true,
    show_customer_name: true,
    show_customer_phone: true,
    footer_note: '',
    ...extra,
  };
}

function run(): void {
  console.log('\n✅ Test 1: printLabel language selection and fallback');
  assert('en resolves grand total to TOTAL', printLabel('en', 'print.grandTotal') === 'TOTAL');
  assert('fa resolves grand total to Persian', printLabel('fa', 'print.grandTotal') === 'جمع کل');
  assert('es resolves grand total', typeof printLabel('es', 'print.grandTotal') === 'string' && printLabel('es', 'print.grandTotal').length > 0);
  assert('fr resolves grand total to French', printLabel('fr', 'print.grandTotal') === 'TOTAL');
  assert('pt resolves grand total', typeof printLabel('pt', 'print.grandTotal') === 'string' && printLabel('pt', 'print.grandTotal').length > 0);
  assert('unknown language falls back to English', printLabel('de', 'print.grandTotal') === 'TOTAL');
  assert('empty language falls back to English', printLabel('', 'receipt.billNumber') === 'Bill #');
  assert('borrowed key resolves from its own namespace', printLabel('en', 'pos.subtotal') === 'Subtotal');

  console.log('\n✅ Test 2: classic receipt honors language');
  {
    const text = escPosToText(formatReceipt(buildOrder(), buildBill(), buildBusiness(), 'classic', 48));
    assert('default language keeps English labels', text.includes('Invoice #:') && text.includes('TOTAL') && text.includes('Subtotal'));
    // Persian script requires a printer profile with arabicShaping (#437);
    // label selection itself is independent of that capability.
    const faText = escPosToText(formatReceipt(buildOrder(), buildBill(), buildBusiness(), 'classic', 48, false, false, undefined, [], true, 'fa'));
    assert('fa classic renders Persian invoice title label', faText.includes('شماره صورتحساب:'));
    assert('fa classic renders Persian grand total', faText.includes('جمع کل'));
    assert('fa classic renders Persian subtotal (borrowed pos.subtotal)', faText.includes('جمع جزء'));
    assert('fa classic localizes cash payment method', faText.includes('نقدی'));
    assert('fa classic translates table prefix', faText.includes('میز:'));
    assert('unknown language keeps English output', escPosToText(formatReceipt(buildOrder(), buildBill(), buildBusiness(), 'classic', 48, false, false, undefined, [], false, 'de')).includes('Invoice #:'));
  }

  console.log('\n✅ Test 3: compact receipt honors language');
  {
    const text = escPosToText(formatReceipt(buildOrder(), buildBill(), buildBusiness(), 'compact', 48));
    assert('default language keeps Bill # label', text.includes('Bill #:'));
    const esText = escPosToText(formatReceipt(buildOrder(), buildBill(), buildBusiness(), 'compact', 48, false, false, undefined, [], false, 'es'));
    assert('es compact localizes bill number label', esText.includes('Comprobante #'));
    assert('es compact localizes date label', esText.includes('Fecha:'));
    const frResult = renderCompactReceiptViaDocument(buildOrder(), buildBill(), buildBusiness(), {
      columns: 48,
      language: 'fr',
      isReprint: false,
      useUnicode: false,
      arabicShaping: false,
      cutMode: 'full',
    });
    const frLines = frResult.lines.join('\n');
    assert('fr compact localizes bill number label', frLines.includes('N° de facture:'));
    assert('fr compact localizes item label', frLines.includes('Article'));
  }

  console.log('\n✅ Test 4: KOT honors language');
  {
    const order = { ...buildOrder(), table: { name: '3' } };
    const text = escPosToText(formatKOT(order, order.items, 'Grill', 48));
    assert('default KOT banner stays English', text.includes('KITCHEN ORDER TICKET'));
    const faText = escPosToText(formatKOT(order, order.items, 'Grill', 48, false, 'full', 'en-US', undefined, [], true, 'fa'));
    assert('fa KOT banner translated', faText.includes('برگ سفارش آشپزخانه'));
    assert('fa KOT station label translated', faText.includes('ایستگاه:'));
    assert('fa KOT time label translated', faText.includes('ساعت:'));
  }

  console.log('\n✅ Test 5: test page honors language');
  {
    const buf80 = buildTestPage('80mm');
    const text80 = buf80.toString('utf8');
    assert('en test page title unchanged', text80.includes('Flo Printer Test'));
    assert('en test page reports columns', text80.includes('Columns: 48'));
    const esText = buildTestPage('80mm', 'full', 'es').toString('utf8');
    assert('es test page title translated', esText.includes('Prueba de impresora Flo'));
    assert('es test page columns label translated', esText.includes('Columnas: 48'));
    assert('technical ruler literal stays verbatim', /[1234567890]/.test(esText));
  }

  console.log('\n✅ Test 6: payment method resolution');
  {
    const bill = { ...buildBill(), payment_details: [{ method: 'card', amount: 250 }] };
    const faText = escPosToText(formatReceipt(buildOrder(), bill, buildBusiness(), 'compact', 48, false, false, undefined, [], true, 'fa'));
    assert('card localizes in fa', faText.includes('کارت'));
    const voucherBill = { ...buildBill(), payment_details: [{ method: 'voucher', amount: 250 }] };
    const text = escPosToText(formatReceipt(buildOrder(), voucherBill, buildBusiness(), 'compact', 48));
    assert('unknown method keeps capitalize fallback', text.includes('Voucher'));
  }

  console.log('\n✅ Test 7: drift check is line-ending deterministic');
  {
    // Windows runners with git's default core.autocrlf rewrite the committed
    // LF file to CRLF on disk; the drift compare must not read that as drift
    // (regression for the build-windows-x64 matrix failure on ef92eeb).
    const { normalizeEol, regenerate } = require('../scripts/generate-print-labels.cjs');
    assert('CRLF normalizes to LF', normalizeEol('a\r\nb\rc\n') === 'a\nb\nc\n');
    const committed = require('fs').readFileSync(require('path').join(__dirname, '..', 'main/print/print-labels.generated.ts'), 'utf8');
    const crlfCommitted = normalizeEol(committed).replace(/\n/g, '\r\n');
    assert('CRLF-checked-out file matches regenerated content', normalizeEol(crlfCommitted) === regenerate());
  }

  console.log('\n' + '='.repeat(56));
  console.log(`Print label tests: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  run();
}
