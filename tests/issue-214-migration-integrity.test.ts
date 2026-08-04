/** Issue #214 migration coverage for retry ownership and transaction references. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-214-migration-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');

function insertOrderAndBill(db: any, suffix: string, paymentDetails: string) {
  db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, NULL, 'takeaway', 'pending', 10, 10, ?, ?)
  `).run(`MIGRATION-214-${suffix}`, now(), now());
  const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`MIGRATION-214-${suffix}`) as any).id;
  db.prepare(`
    INSERT INTO bills (bill_number, order_id, total, balance, payment_status, payment_details, created_at, updated_at)
    VALUES (?, ?, 10, 10, 'unpaid', ?, ?, ?)
  `).run(`BILL-MIGRATION-214-${suffix}`, orderId, paymentDetails, now(), now());
  return (db.prepare('SELECT id, order_id FROM bills WHERE bill_number = ?').get(`BILL-MIGRATION-214-${suffix}`) as any);
}

function main() {
  console.log('Issue #214: migration retry/reference preservation');
  initDatabase();
  try {
    const db = getDatabase();
    const cardPayment = JSON.stringify([{ method: 'card', amount: 10, transaction_id: 'legacy-reference-214', timestamp: now() }]);
    const upiPayment = JSON.stringify([{ method: 'upi', amount: 10, transaction_id: 'legacy-reference-214', timestamp: now() }]);
    const duplicateCardPayment = JSON.stringify([{ method: 'card', amount: 10, transaction_id: 'legacy-reference-214', timestamp: now() }]);
    const firstBill = insertOrderAndBill(db, 'CARD', cardPayment);
    const secondBill = insertOrderAndBill(db, 'UPI', upiPayment);
    const duplicateBill = insertOrderAndBill(db, 'DUPLICATE-CARD', duplicateCardPayment);

    // Simulate the v51 global table after it collapsed the cross-method row.
    db.prepare('DELETE FROM payment_transaction_refs').run();
    db.prepare(`INSERT INTO payment_transaction_refs (method, transaction_id, bill_id, created_at)
      VALUES ('card', 'legacy-reference-214', ?, ?)`).run(firstBill.id, now());
    db.prepare(`INSERT INTO payment_idempotency
      (user_id, idempotency_key, bill_id, request_hash, response_json, created_at)
      VALUES ('legacy', 'legacy-migration-payment-key', ?, 'migration-hash', ?, ?)`).run(
      firstBill.id,
      JSON.stringify({ bill: { id: firstBill.id, payment_status: 'paid' } }),
      now(),
    );
    db.prepare(`INSERT INTO order_idempotency
      (user_id, idempotency_key, request_hash, response_json, created_at)
      VALUES ('legacy', 'legacy-migration-order-key', 'migration-order-hash', ?, ?)`).run(
      JSON.stringify({ order: { id: firstBill.order_id, user_id: null } }),
      now(),
    );

    db.pragma('user_version = 53');
    closeDatabase();
    initDatabase();
    const upgraded = getDatabase();

    const refs = upgraded.prepare(`
      SELECT method, transaction_id, bill_id
      FROM payment_transaction_refs
      WHERE transaction_id = 'legacy-reference-214'
      ORDER BY method
    `).all() as any[];
    if (refs.length !== 2 || refs[0].method !== 'card' || refs[1].method !== 'upi') {
      throw new Error('v54 did not restore both method-scoped transaction references');
    }
    const conflict = upgraded.prepare(`
      SELECT 1 FROM payment_transaction_ref_conflicts
      WHERE method = 'card' AND transaction_id = 'legacy-reference-214' AND bill_id = ?
    `).get(String(duplicateBill.id));
    if (!conflict) {
      const conflicts = upgraded.prepare('SELECT method, transaction_id, bill_id FROM payment_transaction_ref_conflicts').all();
      throw new Error(`v54 did not audit the duplicate same-method reference: ${JSON.stringify(conflicts)}`);
    }

    const legacyPayment = upgraded.prepare('SELECT user_id FROM payment_idempotency WHERE idempotency_key = ?').get('legacy-migration-payment-key') as any;
    const legacyOrder = upgraded.prepare('SELECT user_id FROM order_idempotency WHERE idempotency_key = ?').get('legacy-migration-order-key') as any;
    if (legacyPayment.user_id !== 'legacy' || legacyOrder.user_id !== 'legacy') {
      throw new Error('ownerless historical retry records were assigned to the wrong user');
    }
    console.log('  ✓ v54 restores cross-method references and audits same-method conflicts');
    console.log('  ✓ ownerless historical retries retain compatibility ownership');
    console.log('2/2 passed');
  } finally {
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

try {
  main();
} catch (error: any) {
  try { closeDatabase(); } catch {}
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exit(1);
}
