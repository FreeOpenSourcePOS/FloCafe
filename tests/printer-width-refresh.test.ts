const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-width-refresh-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { initPrinter, prepareReceipt, escPosToText } = require('../main/printers/thermal');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function main() {
  initDatabase();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO printers (id, name, connection_type, paper_width, is_default, created_at, updated_at)
    VALUES ('receipt-printer', 'Receipt Printer', 'usb', 'cols-32', 1, ?, ?)
  `).run(now(), now());

  await initPrinter();
  db.prepare("UPDATE printers SET paper_width = 'cols-48', updated_at = ? WHERE id = 'receipt-printer'").run(now());

  const prepared = prepareReceipt(
    {
      order_number: 'ORD-WIDTH-1',
      created_at: '2026-08-11 12:00:00',
      items: [{ product_name: 'Cheese Burger', quantity: 1, total: 63, addons: [] }],
    },
    { bill_number: 'INV-WIDTH-1', subtotal: 60, tax_amount: 3, discount_amount: 0, total: 63 },
    { name: 'Width Test', currency_symbol: 'Rs', country: 'IN' },
    'classic',
  );

  assert(prepared.columns === 48, 'invoice preparation reads the updated printer width after startup');
  const preview = escPosToText(prepared.data);
  assert(preview.split('\n').some((line: string) => line === '-'.repeat(48)), 'invoice separators use the updated 48-column width');
  assert(!preview.split('\n').some((line: string) => line === '-'.repeat(32)), 'invoice does not retain the stale 32-column width');

  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: Error) => {
  console.error(error);
  try { closeDatabase(); } catch {}
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
