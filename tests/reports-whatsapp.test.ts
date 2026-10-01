import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('node:module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-whatsapp-'));
const clientApiCalls: Array<{ path: string; body: any }> = [];
let clientApiResponse: any = { success: true, messageId: 44 };
let sendResult: any = { ok: true, messageId: 71 };
let lastWhatsAppSend: any = null;
const clientApi = {
  post: async (url: string, body: any) => {
    clientApiCalls.push({ path: url, body });
    return { data: clientApiResponse };
  },
};
const fakeWhatsApp = {
  sendMessage: async (request: any) => {
    lastWhatsAppSend = request;
    return sendResult;
  },
};

Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  if (request === '../services/whatsapp' && parent?.filename?.endsWith('/main/routes/reports.ts')) {
    return fakeWhatsApp;
  }
  if (parent?.filename?.endsWith('/frontend/src/lib/whatsapp-share.ts')) {
    if (request === '@/lib/countries') {
      return {
        getCountryByCode: () => ({ locale: 'en-US' }),
        getCurrencyFractionDigits: (currency: string) => currency === 'JPY' ? 0 : 2,
      };
    }
    if (request === './api') return { __esModule: true, default: clientApi };
    if (request === './printer/format-date') return { formatDate: () => '' };
    if (request === 'react-hot-toast') return { __esModule: true, default: { success: () => {}, error: () => {} } };
  }
  return originalLoad.apply(this, arguments as any);
};

const request = require('supertest');
const jwt = require('jsonwebtoken');
const testSetup = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { reportRoutes } = require('../main/routes/reports');
const {
  formatCashCloseWhatsAppMessage,
  shareCashCloseViaWhatsApp,
} = require('../frontend/src/lib/whatsapp-share');

const tenant = {
  business_name: 'Cafe North',
  currency: 'USD',
  country: 'US',
  timezone: 'America/Toronto',
};
const reportBase = {
  businessDate: '2026-09-30',
  periodStart: '2026-09-30T04:00:00.000Z',
  periodEnd: '2026-10-01T04:00:00.000Z',
  grossSales: 1234.5,
  refunds: 12.5,
  netCollections: 1222,
  billCount: 18,
  expectedCash: 430,
  openingFloat: 100,
  payIn: 15,
  payOut: 2,
  safeDrops: 8,
  paymentMethods: [
    { method: 'Cash', count: 10, total: 430 },
    { method: 'Card', count: 8, total: 792 },
  ],
};

function zReport(cashVariance: number) {
  return {
    ...reportBase,
    zNumber: 7,
    closedAt: '2026-10-01T04:05:00.000Z',
    closedBy: 'Alex',
    notes: 'Drawer counted twice',
    countedCash: reportBase.expectedCash + cashVariance,
    cashVariance,
  };
}

function popupWindow() {
  const popup = {
    opener: {} as unknown,
    location: { href: '' },
    closed: false,
    close() { this.closed = true; },
  };
  (globalThis as any).window = { open: () => popup };
  return popup;
}

async function main(): Promise<void> {
  try {
    const xMessage = formatCashCloseWhatsAppMessage(reportBase, tenant, 'en-US');
    assert.match(xMessage, /X-Report - Cafe North/);
    assert.match(xMessage, /\$1,234\.50/);
    assert.match(xMessage, /SALES SUMMARY/);
    assert.match(xMessage, /Cash: \$430\.00 \(10\)/);
    assert.doesNotMatch(xMessage, /DRAWER RECONCILIATION/);

    const exactMessage = formatCashCloseWhatsAppMessage(zReport(0), tenant, 'en-US');
    assert.match(exactMessage, /Z-Report #7 - Cafe North/);
    assert.match(exactMessage, /Closed by:\* Alex/);
    assert.match(exactMessage, /Variance: \$0\.00 \(✅ Exact\)/);
    assert.match(exactMessage, /Notes:\* Drawer counted twice/);

    const shortageMessage = formatCashCloseWhatsAppMessage(zReport(-25), tenant, 'en-US');
    assert.match(shortageMessage, /Variance: -\$25\.00 \(⚠️ Short\)/);
    const overageMessage = formatCashCloseWhatsAppMessage(zReport(5), tenant, 'en-US');
    assert.match(overageMessage, /Variance: \$5\.00 \(⚠️ Over\)/);

    const frenchMessage = formatCashCloseWhatsAppMessage(reportBase, { ...tenant, currency: 'CAD' }, 'fr-FR');
    const frenchAmount = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'CAD' }).format(1234.5);
    assert.ok(frenchMessage.includes(frenchAmount), 'formats tenant currency using the selected locale');

    const owner = testSetup.seedOwnerUser(testSetup.initTestDb());
    const db = testSetup.getDatabase();
    const closeResult = db.prepare(`
      INSERT INTO cash_closures (
        scope, business_date, period_start, period_end, opening_float_cents,
        expected_cash_cents, counted_cash_cents, variance_cents, gross_collected_cents,
        refunded_cents, net_collected_cents, bill_count, refund_count, z_number, closed_by, notes
      ) VALUES ('day', ?, ?, ?, 0, 43000, 43000, 0, 123450, 1250, 122200, 18, 1, 7, ?, ?)
    `).run('2026-09-30', reportBase.periodStart, reportBase.periodEnd, owner.userId, 'Drawer counted twice');
    const closeId = Number(closeResult.lastInsertRowid);
    const app = testSetup.createApp({ '/api/reports': reportRoutes });
    const payload = { phone_e164: '+14165551234', body: exactMessage };

    const sent = await request(app).post(`/api/reports/cash-closes/${closeId}/whatsapp`)
      .set('Authorization', `Bearer ${owner.token}`).send(payload);
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body, { success: true, messageId: 71 });
    assert.equal(lastWhatsAppSend.kind, 'z_report');
    assert.equal(lastWhatsAppSend.userId, owner.userId);
    assert.equal(lastWhatsAppSend.phoneE164, payload.phone_e164);

    sendResult = { ok: false, reason: 'not_connected', error: 'not connected' };
    const fallback = await request(app).post(`/api/reports/cash-closes/${closeId}/whatsapp`)
      .set('Authorization', `Bearer ${owner.token}`).send(payload);
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.body, { fallback: true, reason: 'not_connected' });

    const invalidPhone = await request(app).post(`/api/reports/cash-closes/${closeId}/whatsapp`)
      .set('Authorization', `Bearer ${owner.token}`).send({ ...payload, phone_e164: 'not-a-phone' });
    assert.equal(invalidPhone.status, 400);
    assert.equal(invalidPhone.body.reason, 'invalid_phone');

    const missingClose = await request(app).post('/api/reports/cash-closes/999999/whatsapp')
      .set('Authorization', `Bearer ${owner.token}`).send(payload);
    assert.equal(missingClose.status, 404);

    const cashierId = 'cashier-whatsapp-test';
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, 'Cashier', ?, 'unused', 'cashier', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(cashierId, 'cashier-whatsapp-test@example.local');
    const cashierToken = jwt.sign({ userId: cashierId, role: 'cashier' }, getJWTSecret(), { expiresIn: '1h' });
    const forbidden = await request(app).post(`/api/reports/cash-closes/${closeId}/whatsapp`)
      .set('Authorization', `Bearer ${cashierToken}`).send(payload);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.permission, 'reports.view');

    clientApiCalls.length = 0;
    clientApiResponse = { success: true, messageId: 44 };
    const sentPopup = popupWindow();
    const sentPromise = shareCashCloseViaWhatsApp(zReport(0), tenant, '+14165551234', {}, closeId, 'en-US');
    assert.equal(clientApiCalls.length, 1, 'starts the API request from the user action');
    assert.equal((await sentPromise), 'sent');
    assert.equal(clientApiCalls[0].path, `/reports/cash-closes/${closeId}/whatsapp`);
    assert.equal(sentPopup.closed, true);

    clientApiResponse = { fallback: true, reason: 'not_connected' };
    const fallbackPopup = popupWindow();
    assert.equal(await shareCashCloseViaWhatsApp(zReport(0), tenant, '+14165551234', {}, closeId, 'en-US'), 'opened');
    assert.match(fallbackPopup.location.href, /^https:\/\/wa\.me\/14165551234\?text=/);

    const xPopup = popupWindow();
    assert.equal(await shareCashCloseViaWhatsApp(reportBase, tenant, '+14165551234', {}, undefined, 'en-US'), 'opened');
    assert.match(xPopup.location.href, /wa\.me\/14165551234/);
    assert.equal(clientApiCalls.length, 2, 'X reports use the direct share fallback without a cash-close ID');
    console.log('Cash-close WhatsApp formatting, fallback, dispatch, and permission tests passed.');
  } finally {
    testSetup.closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
