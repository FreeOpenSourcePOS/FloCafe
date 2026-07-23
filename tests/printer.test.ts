/**
 * FloDesktop Printer Tests
 *
 * Usage:
 *   npm run test:printer            # format tests only (no hardware)
 *   npm run test:printer -- --live  # also sends a real test page to the detected default printer
 *   FLO_PRINT_TO="Printer Name" npm run test:printer -- --live   # send to a specific printer
 */

import {
  formatReceipt,
  formatKOT,
  buildEscPos,
  buildTestPage,
  detectConnectedPrinters,
  printViaUSB,
  printViaNetwork,
} from '../main/printers/thermal';
import { matchSupportedPrinterProfile } from '../main/printers/profiles';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

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

function bytesContain(buf: Buffer, needle: number[]): boolean {
  outer: for (let i = 0; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function visiblePreview(buf: Buffer, cols: number): string {
  const out: string[] = [];
  let line: number[] = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === ESC && (buf[i + 1] === 0x21 || buf[i + 1] === 0x61 || buf[i + 1] === 0x45 || buf[i + 1] === 0x64 || buf[i + 1] === 0x40)) {
      i += buf[i + 1] === 0x40 ? 2 : 3;
      continue;
    }
    if (b === GS && buf[i + 1] === 0x56) {
      i += 3;
      continue;
    }
    if (b === LF) {
      out.push(Buffer.from(line).toString('utf8'));
      line = [];
      i++;
      continue;
    }
    line.push(b);
    i++;
  }
  if (line.length) out.push(Buffer.from(line).toString('utf8'));
  const divider = '─'.repeat(Math.max(cols, 20));
  return divider + '\n' + out.join('\n') + '\n' + divider;
}

const fixtureOrder = {
  order_number: 'ORD-20260421-0001',
  created_at: new Date('2026-04-21T10:30:00Z').toISOString(),
  table: { name: 'T3' },
  items: [
    {
      product_name: 'Cheeseburger',
      quantity: 2,
      unit_price: 250,
      total: 540,
      tax_rate: 5,
      tax_amount: 25,
      addons: [
        { name: 'Extra Cheese', price: 20 },
        { name: 'Bacon', price: 20 },
      ],
      special_instructions: 'No onions',
    },
    {
      product_name: 'Fresh Lime Soda',
      quantity: 1,
      unit_price: 70,
      total: 70,
      tax_rate: 0,
      tax_amount: 0,
      addons: [],
    },
    {
      product_name: 'Very Long Product Name That Should Get Truncated By Formatter',
      quantity: 3,
      unit_price: 100,
      total: 315,
      tax_type: 'gst_5',
      tax_amount: 15,
      addons: [],
    },
  ],
};

const fixtureBill = {
  bill_number: 'INV-20260421-0001',
  subtotal: 925,
  tax_amount: 40,
  discount_amount: 15,
  total: 950,
  tax_breakdown: JSON.stringify([
    { name: 'CGST', rate: 2.5, amount: 20 },
    { name: 'SGST', rate: 2.5, amount: 20 },
  ]),
  payment_details: JSON.stringify([
    { method: 'Cash', amount: 500 },
    { method: 'UPI', amount: 450 },
  ]),
};

const fixtureBusiness = {
  name: 'Flo Test Cafe',
  address: '42 MG Road, Bengaluru 560001',
  phone: '+91 98765 43210',
  gstin: '29AAAAA0000A1Z5',
};

console.log('🧪 FloDesktop Printer Tests');
console.log('='.repeat(60));

console.log('\n✅ Test 1: buildEscPos emits correct control bytes');
{
  const buf = buildEscPos([
    '{INIT}',
    '{CENTER}{BOLD}HEADER{/BOLD}{/CENTER}',
    'plain line',
    '{CUT}',
  ]);

  assert('emits ESC @ (init)', bytesContain(buf, [ESC, 0x40]));
  assert('emits ESC a 1 (center)', bytesContain(buf, [ESC, 0x61, 0x01]));
  assert('emits ESC a 0 (left)', bytesContain(buf, [ESC, 0x61, 0x00]));
  assert('emits ESC E 1 (bold on)', bytesContain(buf, [ESC, 0x45, 0x01]));
  assert('emits GS V 0 (full cut)', bytesContain(buf, [GS, 0x56, 0x00]));
  assert('emits LF after text lines', bytesContain(buf, [LF]));
  assert('contains visible "HEADER" text', buf.toString('utf8').includes('HEADER'));
  assert('contains visible "plain line" text', buf.toString('utf8').includes('plain line'));
  assert('no stray {TOKEN} markers remain', !/\{[A-Z_/]+\}/.test(buf.toString('utf8')));
}

console.log('\n✅ Test 2: Compact receipt (80mm, 48 cols)');
{
  const buf = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'compact', 48, true);
  const text = buf.toString('utf8');

  assert('renders business name', text.includes('Flo Test Cafe'));
  assert('renders bill number', text.includes('INV-20260421-0001'));
  assert('renders Cheeseburger row', text.includes('Cheeseburger'));
  assert('renders addon "Extra Cheese"', text.includes('Extra Cheese'));
  assert('renders addon "Bacon"', text.includes('Bacon'));
  assert('renders special instruction', text.includes('No onions'));
  assert('renders subtotal ₹925.00', text.includes('₹925.00'));
  // Currency slot is always padded to 2 columns, so a 1-char unicode symbol
  // gets a leading space — the minus sign sits outside that slot.
  assert('renders discount line with negative sign', text.includes('- ₹15.00'));
  assert('renders tax total ₹40.00', text.includes('₹40.00'));
  assert('renders TOTAL with grand amount', text.includes('TOTAL') && text.includes('₹950.00'));
  assert('renders Cash payment', text.includes('Cash') && text.includes('₹500.00'));
  assert('renders UPI payment', text.includes('UPI') && text.includes('₹450.00'));
  assert('renders GSTIN', text.includes('29AAAAA0000A1Z5'));
  assert('long product name is truncated to fit', !text.includes('Truncated By Formatter'));
  assert('ends with cut byte sequence', bytesContain(buf, [GS, 0x56, 0x00]));

  const rowLines = visiblePreview(buf, 48).split('\n');
  const cheeseLine = rowLines.find((l) => l.startsWith('Cheeseburger') && l.includes('₹540'));
  assert('item row columns are aligned (no smashed qty)', !!cheeseLine && !/Cheeseburger\d/.test(cheeseLine), cheeseLine);
  assert('item row right-edge total lines up at col 48', !!cheeseLine && cheeseLine.length <= 48);

  console.log('\n   — Rendered compact (80mm) —');
  console.log(visiblePreview(buf, 48));
}

console.log('\n✅ Test 3: Compact receipt on 58mm paper (42 cols)');
{
  const buf = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'compact', 42, true);
  const text = buf.toString('utf8');

  assert('still renders business name', text.includes('Flo Test Cafe'));
  assert('still renders TOTAL', text.includes('TOTAL'));

  const textLines = visiblePreview(buf, 42).split('\n').slice(1, -1);
  const overLong = textLines.filter((l) => l.length > 42);
  assert('no content line exceeds 42 cols', overLong.length === 0, overLong.length ? `${overLong.length} lines too long` : undefined);

  console.log('\n   — Rendered compact (58mm) —');
  console.log(visiblePreview(buf, 42));
}

console.log('\n✅ Test 4: Classic receipt template');
{
  const buf = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'classic', 48, true);
  const text = buf.toString('utf8');

  assert('renders business name', text.includes('Flo Test Cafe'));
  assert('renders item and total', text.includes('Cheeseburger') && text.includes('₹950.00'));
  assert('ends with cut', bytesContain(buf, [GS, 0x56, 0x00]));

  console.log('\n   — Rendered classic —');
  console.log(visiblePreview(buf, 48));
}

console.log('\n✅ Test 5: Detailed GST invoice template');
{
  const buf = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'Detailed (GST)', 48, true);
  const text = buf.toString('utf8');

  assert('renders TAX INVOICE header', text.includes('TAX INVOICE'));
  assert('renders business name in uppercase', text.includes('FLO TEST CAFE'));
  assert('renders CGST line', text.includes('CGST'));
  assert('renders SGST line', text.includes('SGST'));
  assert('renders GRAND TOTAL', text.includes('GRAND TOTAL'));
  assert('renders GSTIN', text.includes('29AAAAA0000A1Z5'));

  console.log('\n   — Rendered detailed —');
  console.log(visiblePreview(buf, 48));
}

console.log('\n✅ Test 5b: Template labels normalize to backend templates');
{
  const classic = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'Classic', 48, true).toString('utf8');
  const compact = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'Compact', 48, true).toString('utf8');
  const detailed = formatReceipt(fixtureOrder, fixtureBill, fixtureBusiness, 'Detailed (GST)', 48, true).toString('utf8');

  assert('Classic label renders classic template', classic.includes('Invoice #:'));
  assert('Compact label renders compact template', compact.includes('Bill #:'));
  assert('Detailed (GST) label renders detailed template', detailed.includes('TAX INVOICE'));
}

console.log('\n✅ Test 6: KOT (Kitchen Order Ticket)');
{
  const buf = formatKOT(fixtureOrder, fixtureOrder.items, 'Main Kitchen', 48);
  const text = buf.toString('utf8');

  assert('renders KOT header', text.includes('KITCHEN ORDER TICKET'));
  assert('renders station name', text.includes('Main Kitchen'));
  assert('renders order number', text.includes('ORD-20260421-0001'));
  assert('renders table number', text.includes('T3'));
  assert('renders each item with qty prefix', text.includes('2x  Cheeseburger'));
  assert('renders addon "Extra Cheese"', text.includes('+ Extra Cheese'));
  assert('renders addon "Bacon"', text.includes('+ Bacon'));
  assert('renders special instructions with ** markers', text.includes('** No onions **'));
  assert('sets DOUBLE_HEIGHT mode for items', bytesContain(buf, [ESC, 0x21, 0x18]));
  assert('does NOT render prices (KOT has no money)', !text.includes('₹'));
  assert('ends with cut', bytesContain(buf, [GS, 0x56, 0x00]));

  console.log('\n   — Rendered KOT —');
  console.log(visiblePreview(buf, 48));
}

console.log('\n✅ Test 7: Test page builder');
{
  const buf80 = buildTestPage('80mm');
  const buf58 = buildTestPage('58mm');
  const xprinter = buildTestPage('80mm', 'partial');
  assert('80mm test page renders title', buf80.toString('utf8').includes('Flo Printer Test'));
  assert('58mm test page renders title', buf58.toString('utf8').includes('Flo Printer Test'));
  assert('80mm test page reports correct paper width', buf80.toString('utf8').includes('80mm'));
  assert('58mm test page reports correct paper width', buf58.toString('utf8').includes('58mm'));
  assert('test page has cut byte', bytesContain(buf80, [GS, 0x56, 0x00]));
  assert('partial cut profile emits GS V B 0', bytesContain(xprinter, [GS, 0x56, 0x42, 0x00]));
}

console.log('\n✅ Test 8: Edge cases');
{
  const emptyOrder = {
    order_number: 'ORD-EMPTY',
    created_at: new Date().toISOString(),
    items: [],
  };
  const emptyBill = {
    bill_number: 'INV-EMPTY',
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
  };
  const buf = formatReceipt(emptyOrder, emptyBill, fixtureBusiness, 'compact', 48, true);
  assert('handles empty item list without throwing', buf.length > 0);
  assert('renders zero total', buf.toString('utf8').includes('₹0.00'));

  const noDiscountBill = { ...fixtureBill, discount_amount: 0 };
  const buf2 = formatReceipt(fixtureOrder, noDiscountBill, fixtureBusiness, 'compact', 48, true);
  assert('omits discount line when discount_amount is 0', !buf2.toString('utf8').includes('Discount'));

  const malformedBill = { ...fixtureBill, payment_details: '{bad json' };
  const buf3 = formatReceipt(fixtureOrder, malformedBill, fixtureBusiness, 'compact', 48, true);
  assert('malformed payment_details does not crash formatter', buf3.length > 0);
}

console.log('\n✅ Test 9: Supported printer profile matching');
{
  const xprinter = matchSupportedPrinterProfile('Counter XP-V320M', 'Xprinter', 'XP-V320M');
  const genericXprinter = matchSupportedPrinterProfile('Xprinter Unknown Model', 'Xprinter', 'Thermal Printer');
  assert('matches Xprinter XP-V320M profile', xprinter?.id === 'xprinter-xp-v320m-v330m');
  assert('does not match unknown Xprinter to XP-V320M profile', genericXprinter === null);
}

console.log('\n✅ Test 10: Detect connected printers (hardware discovery)');
(async () => {
  try {
    const printers = await detectConnectedPrinters();
    console.log(`   Found ${printers.length} printer(s):`);
    for (const p of printers) {
      console.log(
        `     • ${p.name}  [${p.make} ${p.model}, ${p.connectionType}, ${p.status}${p.isDefault ? ', DEFAULT' : ''}]`,
      );
    }
    assert('detectConnectedPrinters returns an array', Array.isArray(printers));
    if (printers.length === 0) {
      console.log('   ℹ Skipping hardware assertion (no printer drivers installed on this host)');
      assert('no printers found (skipped, not a failure)', true);
    } else {
      assert('host has at least one printer installed', printers.length > 0);
    }

    const live = process.argv.includes('--live') || process.env.FLO_LIVE_PRINT === '1';
    if (live) {
      const target =
        process.env.FLO_PRINT_TO ||
        printers.find((p) => p.isDefault)?.name ||
        printers[0]?.name;

      if (!target) {
        console.log('\n   ⚠ --live requested but no printer to target.');
      } else {
        const targetInfo = printers.find((p) => p.name === target);
        console.log(`\n🖨  Sending test page to: ${target}  (${targetInfo?.connectionType || 'usb'})`);
        const testBuf = buildTestPage('80mm');

        let ok = false;
        if (targetInfo?.connectionType === 'network' && /\d+\.\d+\.\d+\.\d+/.test(targetInfo.deviceUri)) {
          const ipMatch = targetInfo.deviceUri.match(/(\d+\.\d+\.\d+\.\d+)(?::(\d+))?/);
          const ip = ipMatch?.[1];
          const port = ipMatch?.[2] ? parseInt(ipMatch[2], 10) : 9100;
          if (ip) ok = await printViaNetwork(ip, port, testBuf);
        } else {
          ok = await printViaUSB(testBuf, target);
        }
        assert(`live test page printed on ${target}`, ok, 'check printer is online, has paper, and driver is installed');
      }
    } else {
      console.log('\n   (skipping live print — pass --live or set FLO_LIVE_PRINT=1 to actually print)');
    }
  } catch (err: any) {
    console.log(`   ✗ printer detection threw: ${err.message}`);
    failed++;
    failures.push(`printer detection: ${err.message}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`🏁 ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
})();
