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
const { whatsappRoutes } = require('../main/routes/whatsapp');
const { isSafeWhatsAppShareUrl } = require('../main/security/url-allowlist');
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
    expectedCash: reportBase.expectedCash + reportBase.openingFloat,
    countedCash: reportBase.expectedCash + reportBase.openingFloat + cashVariance,
    cashVariance,
  };
}

function getLocalizedLabels(localeFile: string): any {
  const messages = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../frontend/src/lib/i18n/messages', localeFile),
    'utf8',
  ));
  const dashboard = messages.dashboard;
  const settings = messages.settings;
  return {
    xReport: dashboard.xReport,
    zReport: dashboard.zReport,
    date: dashboard.businessDateLabel,
    closedBy: dashboard.ticketSectionOperator,
    grossSales: dashboard.grossCollections,
    refunds: dashboard.refunds,
    netCollections: dashboard.netCollections,
    billCount: (count: number) => dashboard.billsCount.replace('{count}', String(count)),
    openingFloat: dashboard.openingFloat,
    expectedCash: dashboard.expectedCash,
    countedCash: dashboard.countedCash,
    variance: dashboard.variance,
    notes: dashboard.closureNotes,
    none: messages.print.zReport.none,
    varianceExact: dashboard.varianceExact,
    varianceShort: dashboard.varianceShort,
    varianceOver: dashboard.varianceOver,
    salesSummary: dashboard.salesSummary,
    paymentBreakdown: dashboard.paymentBreakdown,
    drawerReconciliation: dashboard.drawerReconciliation,
    paymentMethod: (method: string) => {
      switch (method.toLowerCase()) {
        case 'cash': return settings.paymentMethodCash;
        case 'card': return settings.paymentMethodCard;
        case 'upi': return settings.paymentMethodUpi;
        default: return method;
      }
    },
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
    assert.match(xMessage, /Opening Float: \$100\.00/);
    assert.match(xMessage, /Expected Cash: \$530\.00/);
    assert.match(xMessage, /DRAWER RECONCILIATION/);

    const exactMessage = formatCashCloseWhatsAppMessage(zReport(0), tenant, 'en-US');
    assert.match(exactMessage, /Z-Report #7 - Cafe North/);
    assert.match(exactMessage, /Closed by:\* Alex/);
    assert.match(exactMessage, /Opening Float: \$100\.00/);
    assert.match(exactMessage, /Expected Cash: \$530\.00/);
    assert.match(exactMessage, /Variance: \$0\.00 \(✅ Exact\)/);
    assert.match(exactMessage, /Notes:\* Drawer counted twice/);

    const shortageMessage = formatCashCloseWhatsAppMessage(zReport(-25), tenant, 'en-US');
    assert.match(shortageMessage, /Variance: -\$25\.00 \(⚠️ Short\)/);
    const overageMessage = formatCashCloseWhatsAppMessage(zReport(5), tenant, 'en-US');
    assert.match(overageMessage, /Variance: \$5\.00 \(⚠️ Over\)/);

    const frenchMessage = formatCashCloseWhatsAppMessage(reportBase, { ...tenant, currency: 'CAD' }, 'fr-FR');
    const frenchAmount = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'CAD' }).format(1234.5);
    assert.ok(frenchMessage.includes(frenchAmount), 'formats tenant currency using the selected locale');

    const messageDir = path.join(__dirname, '../frontend/src/lib/i18n/messages');
    const localeFiles = fs.readdirSync(messageDir).filter((file) => file.endsWith('.json'));
    assert.equal(localeFiles.length, 24, 'the full-report localization test covers all supported locales');
    for (const localeFile of localeFiles) {
      const labels = getLocalizedLabels(localeFile);
      const localizedX = formatCashCloseWhatsAppMessage(reportBase, tenant, 'en-US', labels);
      const localizedZ = formatCashCloseWhatsAppMessage(zReport(0), tenant, 'en-US', labels);
      const noNotesZ = formatCashCloseWhatsAppMessage({ ...zReport(0), notes: null }, tenant, 'en-US', labels);
      const shortZ = formatCashCloseWhatsAppMessage(zReport(-25), tenant, 'en-US', labels);
      const overZ = formatCashCloseWhatsAppMessage(zReport(5), tenant, 'en-US', labels);

      assert.ok(localizedX.includes(`📊 *${labels.xReport} - Cafe North*`), `${localeFile}: X report title is localized`);
      assert.ok(localizedZ.includes(`📊 *${labels.zReport} #7 - Cafe North*`), `${localeFile}: Z report title is localized`);
      assert.ok(localizedZ.includes(`📅 *${labels.date}:*`), `${localeFile}: business date label is localized`);
      assert.ok(localizedZ.includes(`👤 *${labels.closedBy}:* Alex`), `${localeFile}: closed-by label is localized`);
      assert.ok(localizedZ.includes(`• ${labels.grossSales}:`), `${localeFile}: gross sales label is localized`);
      assert.ok(localizedZ.includes(`• ${labels.refunds}:`), `${localeFile}: refunds label is localized`);
      assert.ok(localizedZ.includes(`• ${labels.netCollections}:`), `${localeFile}: net collections label is localized`);
      assert.ok(localizedZ.includes(`• ${labels.billCount(reportBase.billCount)}`), `${localeFile}: bill count is localized`);
      assert.ok(localizedX.includes(`• ${labels.expectedCash}:`), `${localeFile}: X report expected cash is localized`);
      assert.ok(localizedZ.includes(`• ${labels.expectedCash}:`), `${localeFile}: expected cash label is localized`);
      assert.ok(localizedX.includes(`• ${labels.openingFloat}:`), `${localeFile}: X report opening float is localized`);
      assert.ok(localizedZ.includes(`• ${labels.openingFloat}:`), `${localeFile}: Z report opening float is localized`);
      assert.ok(localizedZ.includes(`• ${labels.countedCash}:`), `${localeFile}: counted cash label is localized`);
      assert.ok(localizedZ.includes(`• ${labels.variance}:`), `${localeFile}: variance label is localized`);
      assert.ok(localizedZ.includes(`📝 *${labels.notes}:* Drawer counted twice`), `${localeFile}: notes label is localized`);
      assert.ok(noNotesZ.includes(`📝 *${labels.notes}:* ${labels.none}`), `${localeFile}: empty notes are localized`);
      assert.ok(localizedZ.includes(`• ${labels.paymentMethod('Cash')}:`), `${localeFile}: cash method label is localized`);
      assert.ok(localizedZ.includes(`• ${labels.paymentMethod('Card')}:`), `${localeFile}: card method label is localized`);
      assert.ok(localizedZ.includes(`✅ ${labels.varianceExact}`), `${localeFile}: exact variance is localized`);
      assert.ok(shortZ.includes(`⚠️ ${labels.varianceShort}`), `${localeFile}: shortage is localized`);
      assert.ok(overZ.includes(`⚠️ ${labels.varianceOver}`), `${localeFile}: overage is localized`);
    }

    const customPaymentMessage = formatCashCloseWhatsAppMessage({
      ...reportBase,
      paymentMethods: [{ method: 'Loyalty Wallet', count: 1, total: 100 }],
    }, tenant, 'en-US', getLocalizedLabels('fr.json'));
    assert.match(customPaymentMessage, /Loyalty Wallet:/, 'custom payment method names remain unchanged');

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

    const manager = testSetup.seedManagerUser(db);
    const historyRows = [
      { kind: 'manual_reply', body: 'Z-Report: $420.00 (manual message)', queuedAt: '2026-10-01T09:00:00.000Z' },
      { kind: 'manual_reply', body: 'Ordinary WhatsApp reply', queuedAt: '2026-10-01T08:00:00.000Z' },
      { kind: 'z_report', body: 'Z-Report: $500.00 (stored report)', queuedAt: '2026-10-01T12:00:00.000Z' },
      { kind: 'z_report', body: 'Z-Report: $600.00 (stored report)', queuedAt: '2026-10-01T13:00:00.000Z' },
    ];
    const insertHistory = db.prepare(`
      INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body, queued_at, created_by_user_id)
      VALUES ('+14165551234', 'outbound', ?, 'sent', ?, ?, ?)
    `);
    for (const row of historyRows) insertHistory.run(row.kind, row.body, row.queuedAt, owner.userId);

    const whatsappApp = testSetup.createApp({ '/api/whatsapp': whatsappRoutes });
    const cashierHistory = await request(whatsappApp).get('/api/whatsapp/messages?direction=outbound&limit=10')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.equal(cashierHistory.status, 200);
    assert.deepEqual(cashierHistory.body.messages.map((message: any) => message.kind), ['manual_reply', 'manual_reply']);
    assert.ok(cashierHistory.body.messages.some((message: any) => message.body === 'Z-Report: $420.00 (manual message)'),
      'cashiers retain access to ordinary messages even when their text resembles a report');

    const cashierHistoryPage = await request(whatsappApp).get('/api/whatsapp/messages?direction=outbound&limit=1')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.equal(cashierHistoryPage.body.messages[0]?.body, 'Z-Report: $420.00 (manual message)',
      'report filtering happens before the SQL limit and pagination');
    const cashierHistoryNextPage = await request(whatsappApp).get('/api/whatsapp/messages?direction=outbound&limit=1&offset=1')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.equal(cashierHistoryNextPage.body.messages[0]?.body, 'Ordinary WhatsApp reply');

    const cashierExplicitReportKind = await request(whatsappApp).get('/api/whatsapp/messages?direction=outbound&kind=z_report')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.ok(cashierExplicitReportKind.body.messages.every((message: any) => message.kind !== 'z_report'),
      'requesting report-kind history does not bypass the report permission filter');

    const managerHistory = await request(whatsappApp).get('/api/whatsapp/messages?direction=outbound&limit=10')
      .set('Authorization', `Bearer ${manager.token}`);
    assert.equal(managerHistory.status, 200);
    assert.equal(managerHistory.body.messages.filter((message: any) => message.kind === 'z_report').length, 2,
      'managers with reports.view can read stored report messages');
    const ownerHistory = await request(whatsappApp).get('/api/whatsapp/messages?direction=outbound&limit=10')
      .set('Authorization', `Bearer ${owner.token}`);
    assert.equal(ownerHistory.body.messages.filter((message: any) => message.kind === 'z_report').length, 2,
      'owners with reports.view can read stored report messages');

    db.prepare(`
      INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES (?, 'reports.view', 'allow', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(cashierId, owner.userId);
    const permittedCashierHistory = await request(whatsappApp).get('/api/whatsapp/messages?direction=outbound&limit=10')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.equal(permittedCashierHistory.body.messages.filter((message: any) => message.kind === 'z_report').length, 2,
      'cashiers explicitly granted reports.view can read stored report messages');

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

    const longPaymentMethods = Array.from({ length: 48 }, (_, index) => {
      const prefix = `Tender ${String(index).padStart(2, '0')} `;
      return { method: prefix + 'M'.repeat(60 - prefix.length), count: index + 1, total: index + 1 };
    });
    const oversizedReport = { ...zReport(0), notes: 'N'.repeat(500), paymentMethods: longPaymentMethods };
    const oversizedMessage = formatCashCloseWhatsAppMessage(oversizedReport, tenant, 'en-US');
    assert.ok(oversizedMessage.length > 4096, 'accepted notes and payment method names can produce a long report');
    clientApiCalls.length = 0;
    const oversizedPopup = popupWindow();
    assert.equal(await shareCashCloseViaWhatsApp(oversizedReport, tenant, '+14165551234', {}, closeId, 'en-US'), 'opened');
    assert.equal(clientApiCalls.length, 0, 'over-limit reports skip the route that rejects them');
    assert.ok(oversizedPopup.location.href.length > 4096, 'the manual WhatsApp URL can carry the long report');
    assert.equal(isSafeWhatsAppShareUrl(oversizedPopup.location.href), true, 'Electron accepts the generated manual-share URL');
    assert.equal(new URL(oversizedPopup.location.href).searchParams.get('text'), oversizedMessage,
      'the manual share preserves the complete report without truncating financial details');

    const xPopup = popupWindow();
    assert.equal(await shareCashCloseViaWhatsApp(reportBase, tenant, '+14165551234', {}, undefined, 'en-US'), 'opened');
    assert.match(xPopup.location.href, /wa\.me\/14165551234/);
    assert.equal(clientApiCalls.length, 0, 'X reports use the direct share fallback without a cash-close ID');
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
