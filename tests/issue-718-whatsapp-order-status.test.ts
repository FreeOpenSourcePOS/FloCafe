/**
 * Regression coverage for the order-level WhatsApp receipt status projection
 * used by the Orders page.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-718-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, seedCustomer,
  api, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');

function insertBill(db: any, orderId: number, billNumber: string, paymentStatus: 'paid' | 'unpaid', splitGroupId?: string, customerId: string | null = 'issue-718-customer') {
  const result = db.prepare(`
    INSERT INTO bills (
      bill_number, order_id, customer_id, subtotal, total, paid_amount, balance,
      payment_status, split_group_id, split_label, created_at, updated_at
    ) VALUES (?, ?, ?, 100, 100, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    billNumber,
    orderId,
    customerId,
    paymentStatus === 'paid' ? 100 : 0,
    paymentStatus === 'paid' ? 0 : 100,
    paymentStatus,
    splitGroupId || null,
    splitGroupId ? billNumber : null,
    now(),
    now(),
  );
  return Number(result.lastInsertRowid);
}

function insertWhatsAppRow(db: any, billId: number, status: string, kind = 'bill_receipt', direction = 'outbound') {
  db.prepare(`
    INSERT INTO whatsapp_messages (bill_id, phone_e164, direction, kind, status, body, queued_at)
    VALUES (?, '+15555550100', ?, ?, ?, 'Receipt', ?)
  `).run(billId, direction, kind, status, now());
}

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'issue-718-category', 'Issue 718');
  seedProduct(db, 'issue-718-product', 'issue-718-category', 'Receipt Test Item', 100);
  seedCustomer(db, 'issue-718-customer', 'Receipt Customer', '+15555550100');
  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    const createOrder = async (suffix: string, customerId: string | null = 'issue-718-customer') => {
      const response = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          customer_id: customerId,
          special_instructions: `issue-718-${suffix}`,
          items: [{ product_id: 'issue-718-product', quantity: 1 }],
        },
        headers: authHeader,
      });
      assertEqual(response.status, 201, `${suffix}: order created`);
      return response.data.order.id as number;
    };

    const statusCases = [
      ['sent', 'sent'],
      ['delivered', 'sent'],
      ['read', 'sent'],
      ['queued', 'pending'],
      ['typing', 'pending'],
    ] as const;
    for (const [suffix, status] of statusCases) {
      const orderId = await createOrder(suffix);
      const billId = insertBill(db, orderId, `ISSUE-718-${suffix}`, 'paid');
      insertWhatsAppRow(db, billId, status);
      const response = await api(baseUrl, `/api/orders/${orderId}`, { headers: authHeader });
      assertEqual(response.data.order.whatsapp_receipt_status, status, `${suffix}: receipt status is projected`);
    }

    const failedRetryOrderId = await createOrder('failed-retry');
    const failedRetryBillId = insertBill(db, failedRetryOrderId, 'ISSUE-718-FAILED-RETRY', 'paid');
    insertWhatsAppRow(db, failedRetryBillId, 'sent');
    insertWhatsAppRow(db, failedRetryBillId, 'failed');
    const failedRetry = await api(baseUrl, `/api/orders/${failedRetryOrderId}`, { headers: authHeader });
    assertEqual(failedRetry.data.order.whatsapp_receipt_status, 'failed', 'failed retry supersedes prior success');

    const splitOrderId = await createOrder('split-bill');
    const splitGroupId = 'issue-718-split-group';
    const siblingBillId = insertBill(db, splitOrderId, 'ISSUE-718-SIBLING', 'paid', splitGroupId);
    const selectedBillId = insertBill(db, splitOrderId, 'ISSUE-718-SELECTED', 'paid', splitGroupId);
    insertWhatsAppRow(db, siblingBillId, 'read');
    insertWhatsAppRow(db, selectedBillId, 'queued');
    const splitResponse = await api(baseUrl, `/api/orders/${splitOrderId}`, { headers: authHeader });
    assertEqual(splitResponse.data.order.bill.id, siblingBillId, 'split order keeps the existing first paid bill');
    assertEqual(splitResponse.data.order.whatsapp_receipt_status, 'partial', 'split order summarizes paid bill statuses');

    const splitMissingOrderId = await createOrder('split-missing-row');
    const splitSentBillId = insertBill(db, splitMissingOrderId, 'ISSUE-718-SENT-SIBLING', 'paid', 'issue-718-split-missing');
    insertBill(db, splitMissingOrderId, 'ISSUE-718-NO-ROW-SIBLING', 'paid', 'issue-718-split-missing');
    insertWhatsAppRow(db, splitSentBillId, 'sent');
    const splitMissingResponse = await api(baseUrl, `/api/orders/${splitMissingOrderId}`, { headers: authHeader });
    assertEqual(splitMissingResponse.data.order.whatsapp_receipt_status, 'partial', 'a paid split bill without a row prevents a sent summary');

    const missingOrderId = await createOrder('missing-row');
    const missingBillId = insertBill(db, missingOrderId, 'ISSUE-718-MISSING', 'paid');
    insertWhatsAppRow(db, missingBillId, 'sent', 'manual_reply');
    insertWhatsAppRow(db, missingBillId, 'read', 'bill_receipt', 'inbound');
    const missingResponse = await api(baseUrl, `/api/orders/${missingOrderId}`, { headers: authHeader });
    assertEqual(missingResponse.data.order.whatsapp_receipt_status, null, 'non-receipt rows do not count as a recorded send');

    const noPhoneOrderId = await createOrder('no-phone', null);
    const noPhoneBillId = insertBill(db, noPhoneOrderId, 'ISSUE-718-NO-PHONE', 'paid', undefined, null);
    const noPhoneResponse = await api(baseUrl, `/api/orders/${noPhoneOrderId}`, { headers: authHeader });
    assertEqual(noPhoneResponse.data.order.customer, null, 'orders without a phone remain readable');
    assertEqual(noPhoneResponse.data.order.bill.id, noPhoneBillId, 'orders without a phone still include the bill');
    assertEqual(noPhoneResponse.data.order.whatsapp_receipt_status, null, 'orders without a phone show no recorded send');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
    Module._load = originalLoad;
  }

  const results = getResults();
  if (results.failed > 0) process.exit(1);
}

main().catch((error: any) => {
  console.error(error);
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
