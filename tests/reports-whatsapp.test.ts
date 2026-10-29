import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.FLO_WHATSAPP_FAST_DELAY = '1';
const Module = require('node:module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-whatsapp-'));
const whatsappSharePath = path.resolve(__dirname, '../frontend/src/lib/whatsapp-share.ts');
const reportsRoutePath = path.resolve(__dirname, '../main/routes/reports.ts');
const clientApiCalls: Array<{ path: string; body: any }> = [];
let clientApiResponse: any = { success: true, messageId: 44 };
let clientApiError: any = null;
let sendResult: any = { ok: true, messageId: 71 };
let lastWhatsAppSend: any = null;
let useRealWhatsAppInReportsRoute = false;
let realWhatsAppRef: any = null;

const baileysEventHandlers = new Map<string, (value: any) => void>();
const sentSocketMessages: Array<{ jid: string; payload: any }> = [];
let socketSendShouldThrow = false;
let autoServerAck = true;
let socketMsgSeq = 0;
const fakeSocket: any = {
  ev: {
    on: (event: string, handler: (value: any) => void) => {
      baileysEventHandlers.set(event, handler);
    },
  },
  onWhatsApp: async (jid: string) => [{ exists: true, jid }],
  presenceSubscribe: async () => {},
  sendPresenceUpdate: async () => {},
  sendMessage: async (jid: string, payload: any) => {
    if (socketSendShouldThrow) {
      throw new Error('simulated_socket_failure');
    }
    const extId = `reports-wa-ext-${++socketMsgSeq}`;
    sentSocketMessages.push({ jid, payload });
    if (autoServerAck) {
      setImmediate(() => {
        baileysEventHandlers.get('messages.update')?.([
          { key: { id: extId }, update: { status: 2 } },
        ]);
      });
    }
    return { key: { id: extId } };
  },
  requestPairingCode: async () => '12345678',
  logout: async () => {},
  end: () => {},
};
const fakeBaileys = {
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1] }),
  useMultiFileAuthState: async () => ({
    state: {},
    saveCreds: async () => {},
  }),
  makeWASocket: () => fakeSocket,
  Browsers: { macOS: () => ({}) },
  proto: { Message: { create: () => ({}) } },
};

const clientApi = {
  post: async (url: string, body: any) => {
    clientApiCalls.push({ path: url, body });
    if (clientApiError) throw clientApiError;
    return { data: clientApiResponse };
  },
};
const fakeWhatsApp = {
  MAX_BODY_CHARS: 4096,
  sendMessage: async (request: any) => {
    lastWhatsAppSend = request;
    if (useRealWhatsAppInReportsRoute && realWhatsAppRef) {
      return realWhatsAppRef.sendMessage(request);
    }
    return sendResult;
  },
};

Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    };
  }
  if (request === '../baileys-loader.cjs') {
    return { loadBaileys: async () => fakeBaileys };
  }
  if (
    request === '../services/whatsapp' &&
    parent?.filename &&
    path.resolve(parent.filename) === reportsRoutePath
  ) {
    return fakeWhatsApp;
  }
  if (parent?.filename && path.resolve(parent.filename) === whatsappSharePath) {
    if (request === '@/lib/countries') {
      return {
        getCountryByCode: () => ({ locale: 'en-US' }),
        getCurrencyFractionDigits: (currency: string) => (currency === 'JPY' ? 0 : 2),
      };
    }
    if (request === './api') return { __esModule: true, default: clientApi };
    if (request === './printer/format-date') return { formatDate: () => '' };
    if (request === 'react-hot-toast')
      return { __esModule: true, default: { success: () => {}, error: () => {} } };
  }
  return originalLoad.apply(this, arguments as any);
};

const request = require('supertest');
const jwt = require('jsonwebtoken');
const testSetup = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const whatsappService = require('../main/services/whatsapp');
realWhatsAppRef = whatsappService;
const {
  buildDailySalesExportDataset,
  formatDailySalesWhatsAppMessage,
} = require('../main/services/daily-sales-export');
const { notifyOfflineModeEnabled } = require('../main/services/offline-mode');
const { reportRoutes } = require('../main/routes/reports');
const { whatsappRoutes } = require('../main/routes/whatsapp');
const { cashClosureRoutes } = require('../main/routes/cash-closures');
const { cashSessionRoutes } = require('../main/routes/cash-sessions');
const { isSafeWhatsAppShareUrl } = require('../main/security/url-allowlist');
const {
  formatCashCloseWhatsAppMessage,
  shareCashCloseViaWhatsApp,
  shareDailySalesViaWhatsApp,
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
  const messages = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../frontend/src/lib/i18n/messages', localeFile), 'utf8'),
  );
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
        case 'cash':
          return settings.paymentMethodCash;
        case 'card':
          return settings.paymentMethodCard;
        case 'upi':
          return settings.paymentMethodUpi;
        default:
          return method;
      }
    },
  };
}

function popupWindow() {
  const popup = {
    opener: {} as unknown,
    location: { href: '' },
    closed: false,
    close() {
      this.closed = true;
    },
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

    const frenchMessage = formatCashCloseWhatsAppMessage(
      reportBase,
      { ...tenant, currency: 'CAD' },
      'fr-FR',
    );
    const frenchAmount = new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'CAD',
    }).format(1234.5);
    assert.ok(
      frenchMessage.includes(frenchAmount),
      'formats tenant currency using the selected locale',
    );

    const messageDir = path.join(__dirname, '../frontend/src/lib/i18n/messages');
    const localeFiles = fs.readdirSync(messageDir).filter((file) => file.endsWith('.json'));
    assert.equal(
      localeFiles.length,
      24,
      'the full-report localization test covers all supported locales',
    );
    for (const localeFile of localeFiles) {
      const labels = getLocalizedLabels(localeFile);
      const localizedX = formatCashCloseWhatsAppMessage(reportBase, tenant, 'en-US', labels);
      const localizedZ = formatCashCloseWhatsAppMessage(zReport(0), tenant, 'en-US', labels);
      const noNotesZ = formatCashCloseWhatsAppMessage(
        { ...zReport(0), notes: null },
        tenant,
        'en-US',
        labels,
      );
      const shortZ = formatCashCloseWhatsAppMessage(zReport(-25), tenant, 'en-US', labels);
      const overZ = formatCashCloseWhatsAppMessage(zReport(5), tenant, 'en-US', labels);

      assert.ok(
        localizedX.includes(`📊 *${labels.xReport} - Cafe North*`),
        `${localeFile}: X report title is localized`,
      );
      assert.ok(
        localizedZ.includes(`📊 *${labels.zReport} #7 - Cafe North*`),
        `${localeFile}: Z report title is localized`,
      );
      assert.ok(
        localizedZ.includes(`📅 *${labels.date}:*`),
        `${localeFile}: business date label is localized`,
      );
      assert.ok(
        localizedZ.includes(`👤 *${labels.closedBy}:* Alex`),
        `${localeFile}: closed-by label is localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.grossSales}:`),
        `${localeFile}: gross sales label is localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.refunds}:`),
        `${localeFile}: refunds label is localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.netCollections}:`),
        `${localeFile}: net collections label is localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.billCount(reportBase.billCount)}`),
        `${localeFile}: bill count is localized`,
      );
      assert.ok(
        localizedX.includes(`• ${labels.expectedCash}:`),
        `${localeFile}: X report expected cash is localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.expectedCash}:`),
        `${localeFile}: expected cash label is localized`,
      );
      assert.ok(
        localizedX.includes(`• ${labels.openingFloat}:`),
        `${localeFile}: X report opening float is localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.openingFloat}:`),
        `${localeFile}: Z report opening float is localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.countedCash}:`),
        `${localeFile}: counted cash label is localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.variance}:`),
        `${localeFile}: variance label is localized`,
      );
      assert.ok(
        localizedZ.includes(`📝 *${labels.notes}:* Drawer counted twice`),
        `${localeFile}: notes label is localized`,
      );
      assert.ok(
        noNotesZ.includes(`📝 *${labels.notes}:* ${labels.none}`),
        `${localeFile}: empty notes are localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.paymentMethod('Cash')}:`),
        `${localeFile}: cash method label is localized`,
      );
      assert.ok(
        localizedZ.includes(`• ${labels.paymentMethod('Card')}:`),
        `${localeFile}: card method label is localized`,
      );
      assert.ok(
        localizedZ.includes(`✅ ${labels.varianceExact}`),
        `${localeFile}: exact variance is localized`,
      );
      assert.ok(
        shortZ.includes(`⚠️ ${labels.varianceShort}`),
        `${localeFile}: shortage is localized`,
      );
      assert.ok(overZ.includes(`⚠️ ${labels.varianceOver}`), `${localeFile}: overage is localized`);
    }

    const customPaymentMessage = formatCashCloseWhatsAppMessage(
      {
        ...reportBase,
        paymentMethods: [{ method: 'Loyalty Wallet', count: 1, total: 100 }],
      },
      tenant,
      'en-US',
      getLocalizedLabels('fr.json'),
    );
    assert.match(
      customPaymentMessage,
      /Loyalty Wallet:/,
      'custom payment method names remain unchanged',
    );

    const owner = testSetup.seedOwnerUser(testSetup.initTestDb());
    const db = testSetup.getDatabase();
    const closeResult = db
      .prepare(`
      INSERT INTO cash_closures (
        scope, business_date, period_start, period_end, opening_float_cents,
        expected_cash_cents, counted_cash_cents, variance_cents, gross_collected_cents,
        refunded_cents, net_collected_cents, bill_count, refund_count, z_number, closed_by, notes
      ) VALUES ('day', ?, ?, ?, 0, 43000, 43000, 0, 123450, 1250, 122200, 18, 1, 7, ?, ?)
    `)
      .run(
        '2026-09-30',
        reportBase.periodStart,
        reportBase.periodEnd,
        owner.userId,
        'Drawer counted twice',
      );
    const closeId = Number(closeResult.lastInsertRowid);
    const app = testSetup.createApp({ '/api/reports': reportRoutes });
    const payload = { phone_e164: '+14165551234', body: exactMessage };

    const sent = await request(app)
      .post(`/api/reports/cash-closes/${closeId}/whatsapp`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send(payload);
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body, { success: true, messageId: 71 });
    assert.equal(lastWhatsAppSend.kind, 'z_report');
    assert.equal(lastWhatsAppSend.userId, owner.userId);
    assert.equal(lastWhatsAppSend.phoneE164, payload.phone_e164);

    sendResult = { ok: false, reason: 'not_connected', error: 'not connected' };
    const fallback = await request(app)
      .post(`/api/reports/cash-closes/${closeId}/whatsapp`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send(payload);
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.body, { fallback: true, reason: 'not_connected' });

    const invalidPhone = await request(app)
      .post(`/api/reports/cash-closes/${closeId}/whatsapp`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ ...payload, phone_e164: 'not-a-phone' });
    assert.equal(invalidPhone.status, 400);
    assert.equal(invalidPhone.body.reason, 'invalid_phone');

    const missingClose = await request(app)
      .post('/api/reports/cash-closes/999999/whatsapp')
      .set('Authorization', `Bearer ${owner.token}`)
      .send(payload);
    assert.equal(missingClose.status, 404);

    const cashierId = 'cashier-whatsapp-test';
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, 'Cashier', ?, 'unused', 'cashier', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(cashierId, 'cashier-whatsapp-test@example.local');
    const cashierToken = jwt.sign({ userId: cashierId, role: 'cashier' }, getJWTSecret(), {
      expiresIn: '1h',
    });
    const forbidden = await request(app)
      .post(`/api/reports/cash-closes/${closeId}/whatsapp`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(payload);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.permission, 'reports.view');

    const manager = testSetup.seedManagerUser(db);
    const historyRows = [
      {
        kind: 'manual_reply',
        body: 'Z-Report: $420.00 (manual message)',
        queuedAt: '2026-10-01T09:00:00.000Z',
      },
      {
        kind: 'manual_reply',
        body: 'Ordinary WhatsApp reply',
        queuedAt: '2026-10-01T08:00:00.000Z',
      },
      {
        kind: 'z_report',
        body: 'Z-Report: $500.00 (stored report)',
        queuedAt: '2026-10-01T12:00:00.000Z',
      },
      {
        kind: 'z_report',
        body: 'Z-Report: $600.00 (stored report)',
        queuedAt: '2026-10-01T13:00:00.000Z',
      },
    ];
    const insertHistory = db.prepare(`
      INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body, queued_at, created_by_user_id)
      VALUES ('+14165551234', 'outbound', ?, 'sent', ?, ?, ?)
    `);
    for (const row of historyRows)
      insertHistory.run(row.kind, row.body, row.queuedAt, owner.userId);

    const whatsappApp = testSetup.createApp({ '/api/whatsapp': whatsappRoutes });
    const cashierHistory = await request(whatsappApp)
      .get('/api/whatsapp/messages?direction=outbound&limit=10')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.equal(cashierHistory.status, 200);
    assert.deepEqual(
      cashierHistory.body.messages.map((message: any) => message.kind),
      ['manual_reply', 'manual_reply'],
    );
    assert.ok(
      cashierHistory.body.messages.some(
        (message: any) => message.body === 'Z-Report: $420.00 (manual message)',
      ),
      'cashiers retain access to ordinary messages even when their text resembles a report',
    );

    const cashierHistoryPage = await request(whatsappApp)
      .get('/api/whatsapp/messages?direction=outbound&limit=1')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.equal(
      cashierHistoryPage.body.messages[0]?.body,
      'Z-Report: $420.00 (manual message)',
      'report filtering happens before the SQL limit and pagination',
    );
    const cashierHistoryNextPage = await request(whatsappApp)
      .get('/api/whatsapp/messages?direction=outbound&limit=1&offset=1')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.equal(cashierHistoryNextPage.body.messages[0]?.body, 'Ordinary WhatsApp reply');

    const cashierExplicitReportKind = await request(whatsappApp)
      .get('/api/whatsapp/messages?direction=outbound&kind=z_report')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.ok(
      cashierExplicitReportKind.body.messages.every((message: any) => message.kind !== 'z_report'),
      'requesting report-kind history does not bypass the report permission filter',
    );

    const managerHistory = await request(whatsappApp)
      .get('/api/whatsapp/messages?direction=outbound&limit=10')
      .set('Authorization', `Bearer ${manager.token}`);
    assert.equal(managerHistory.status, 200);
    assert.equal(
      managerHistory.body.messages.filter((message: any) => message.kind === 'z_report').length,
      2,
      'managers with reports.view can read stored report messages',
    );
    const ownerHistory = await request(whatsappApp)
      .get('/api/whatsapp/messages?direction=outbound&limit=10')
      .set('Authorization', `Bearer ${owner.token}`);
    assert.equal(
      ownerHistory.body.messages.filter((message: any) => message.kind === 'z_report').length,
      2,
      'owners with reports.view can read stored report messages',
    );

    db.prepare(`
      INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES (?, 'reports.view', 'allow', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(cashierId, owner.userId);
    const permittedCashierHistory = await request(whatsappApp)
      .get('/api/whatsapp/messages?direction=outbound&limit=10')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.equal(
      permittedCashierHistory.body.messages.filter((message: any) => message.kind === 'z_report')
        .length,
      2,
      'cashiers explicitly granted reports.view can read stored report messages',
    );

    clientApiCalls.length = 0;
    clientApiResponse = { success: true, messageId: 44 };
    const sentPopup = popupWindow();
    const sentPromise = shareCashCloseViaWhatsApp(
      zReport(0),
      tenant,
      '+14165551234',
      {},
      closeId,
      'en-US',
    );
    assert.equal(clientApiCalls.length, 1, 'starts the API request from the user action');
    assert.equal(await sentPromise, 'sent');
    assert.equal(clientApiCalls[0].path, `/reports/cash-closes/${closeId}/whatsapp`);
    assert.equal(sentPopup.closed, true);

    clientApiResponse = { fallback: true, reason: 'not_connected' };
    const fallbackPopup = popupWindow();
    assert.equal(
      await shareCashCloseViaWhatsApp(zReport(0), tenant, '+14165551234', {}, closeId, 'en-US'),
      'opened',
    );
    assert.match(fallbackPopup.location.href, /^https:\/\/wa\.me\/14165551234\?text=/);

    const longPaymentMethods = Array.from({ length: 48 }, (_, index) => {
      const prefix = `Tender ${String(index).padStart(2, '0')} `;
      return {
        method: prefix + 'M'.repeat(60 - prefix.length),
        count: index + 1,
        total: index + 1,
      };
    });
    const oversizedReport = {
      ...zReport(0),
      notes: 'N'.repeat(500),
      paymentMethods: longPaymentMethods,
    };
    const oversizedMessage = formatCashCloseWhatsAppMessage(oversizedReport, tenant, 'en-US');
    assert.ok(
      oversizedMessage.length > 4096,
      'accepted notes and payment method names can produce a long report',
    );
    clientApiCalls.length = 0;
    const oversizedPopup = popupWindow();
    assert.equal(
      await shareCashCloseViaWhatsApp(
        oversizedReport,
        tenant,
        '+14165551234',
        {},
        closeId,
        'en-US',
      ),
      'opened',
    );
    assert.equal(clientApiCalls.length, 0, 'over-limit reports skip the route that rejects them');
    assert.ok(
      oversizedPopup.location.href.length > 4096,
      'the manual WhatsApp URL can carry the long report',
    );
    assert.equal(
      isSafeWhatsAppShareUrl(oversizedPopup.location.href),
      true,
      'Electron accepts the generated manual-share URL',
    );
    assert.equal(
      new URL(oversizedPopup.location.href).searchParams.get('text'),
      oversizedMessage,
      'the manual share preserves the complete report without truncating financial details',
    );

    const xPopup = popupWindow();
    assert.equal(
      await shareCashCloseViaWhatsApp(reportBase, tenant, '+14165551234', {}, undefined, 'en-US'),
      'opened',
    );
    assert.match(xPopup.location.href, /wa\.me\/14165551234/);
    assert.equal(
      clientApiCalls.length,
      0,
      'X reports use the direct share fallback without a cash-close ID',
    );

    // ── Daily-sales WhatsApp formatting, truncation, localization, route, and client fallback ──
    const setSetting = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    setSetting.run('business_name', 'Cafe North');
    setSetting.run('country', 'US');
    setSetting.run('currency', 'USD');
    setSetting.run('timezone', 'America/Toronto');
    setSetting.run('business_day_start_time', '04:00');
    setSetting.run('language', 'en');
    setSetting.run('business_phone', '+14165550000');

    testSetup.seedCategory(db, 'cat-wa-sales', 'Drinks');
    for (let i = 1; i <= 6; i++) {
      testSetup.seedProduct(db, `prod-wa-${i}`, 'cat-wa-sales', `Item ${i}`, 10 * i);
    }

    const seedPaidOrder = (opts: {
      suffix: string;
      paidAtUtc: string;
      method: string;
      items: Array<{
        productId: string;
        name: string;
        qty: number;
        subtotal: number;
        discount?: number;
        tax?: number;
      }>;
      orderDiscount?: number;
      serviceCharge?: number;
      packagingCharge?: number;
      deliveryCharge?: number;
      refundCents?: number;
    }) => {
      const paidAtSql = new Date(opts.paidAtUtc)
        .toISOString()
        .replace('T', ' ')
        .replace(/\..*$/, '');
      const subtotal = opts.items.reduce((sum, item) => sum + item.subtotal, 0);
      const taxTotal = opts.items.reduce((sum, item) => sum + (item.tax ?? 0), 0);
      const orderDiscount = opts.orderDiscount ?? 0;
      const serviceCharge = opts.serviceCharge ?? 0;
      const packagingCharge = opts.packagingCharge ?? 0;
      const deliveryCharge = opts.deliveryCharge ?? 0;
      const total =
        subtotal - orderDiscount + taxTotal + serviceCharge + packagingCharge + deliveryCharge;
      const ordRes = db
        .prepare(`
        INSERT INTO orders (order_number, user_id, type, status, subtotal, discount_amount, tax_amount, total, created_at, updated_at, completed_at)
        VALUES (?, ?, 'takeaway', 'completed', ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          `ORD-WA-${opts.suffix}`,
          owner.userId,
          subtotal,
          orderDiscount,
          taxTotal,
          total,
          paidAtSql,
          paidAtSql,
          paidAtSql,
        );
      const orderId = Number(ordRes.lastInsertRowid);
      for (const item of opts.items) {
        db.prepare(`
          INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, discount_amount, subtotal, tax_amount, tax_breakdown, total, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        `).run(
          orderId,
          item.productId,
          item.name,
          item.qty,
          (item.subtotal + (item.discount ?? 0)) / item.qty,
          item.discount ?? 0,
          item.subtotal,
          item.tax ?? 0,
          item.tax ? JSON.stringify([{ title: 'HST', rate: 13, amount: item.tax }]) : '[]',
          item.subtotal + (item.tax ?? 0),
          paidAtSql,
          paidAtSql,
        );
      }
      const billRes = db
        .prepare(`
        INSERT INTO bills (
          bill_number, order_id, subtotal, discount_amount, tax_amount, tax_breakdown,
          service_charge, packaging_charge, delivery_charge, total, paid_amount, balance,
          payment_status, payment_details, paid_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)
      `)
        .run(
          `BILL-WA-${opts.suffix}`,
          orderId,
          subtotal,
          orderDiscount,
          taxTotal,
          taxTotal ? JSON.stringify([{ title: 'HST', rate: 13, amount: taxTotal }]) : '[]',
          serviceCharge,
          packagingCharge,
          deliveryCharge,
          total,
          total,
          JSON.stringify([{ method: opts.method, amount: total, timestamp: paidAtSql }]),
          paidAtSql,
          paidAtSql,
          paidAtSql,
        );
      const billId = Number(billRes.lastInsertRowid);
      if (opts.refundCents && opts.refundCents > 0) {
        db.prepare(`
          INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
          VALUES (?, NULL, ?, ?, 'partial refund', NULL, ?, ?, ?)
        `).run(billId, opts.refundCents, opts.method, owner.userId, owner.userId, paidAtSql);
      }
      return { orderId, billId };
    };

    // Business day 2026-10-05 in America/Toronto (EDT = UTC-4) with business_day_start_time = 04:00
    // spans 2026-10-05T08:00:00.000Z .. 2026-10-06T08:00:00.000Z.
    // A late-night sale at 2026-10-06T06:30:00.000Z (02:30 local) belongs to 2026-10-05, not 2026-10-06.
    seedPaidOrder({
      suffix: 'D1-A',
      paidAtUtc: '2026-10-05T15:00:00.000Z',
      method: 'cash',
      items: [
        { productId: 'prod-wa-1', name: 'Flat White', qty: 2, subtotal: 10, discount: 2, tax: 1.3 },
        { productId: 'prod-wa-2', name: 'Cortado', qty: 3, subtotal: 20, tax: 2.6 },
        { productId: 'prod-wa-3', name: 'Matcha Latte', qty: 4, subtotal: 30, tax: 3.9 },
      ],
      orderDiscount: 3,
      serviceCharge: 4,
      packagingCharge: 1.5,
      deliveryCharge: 2.5,
      refundCents: 500,
    });
    seedPaidOrder({
      suffix: 'D1-LATE',
      paidAtUtc: '2026-10-06T06:30:00.000Z', // 02:30 EDT -> still business date 2026-10-05
      method: 'card',
      items: [
        { productId: 'prod-wa-4', name: 'Cold Brew', qty: 5, subtotal: 40, tax: 5.2 },
        { productId: 'prod-wa-5', name: 'Cappuccino', qty: 6, subtotal: 50, tax: 6.5 },
        { productId: 'prod-wa-6', name: 'Americano', qty: 7, subtotal: 60, tax: 7.8 },
      ],
    });
    // Business day 2026-10-06 sale after 04:00 EDT cutoff:
    seedPaidOrder({
      suffix: 'D2-A',
      paidAtUtc: '2026-10-06T14:00:00.000Z',
      method: 'card',
      items: [{ productId: 'prod-wa-6', name: 'Americano', qty: 2, subtotal: 20, tax: 2.6 }],
    });

    const singleDayDataset = buildDailySalesExportDataset({ from: '2026-10-05', to: '2026-10-05' });
    assert.equal(
      singleDayDataset.summary.order_count,
      2,
      'late-night pre-cutoff order stays in 2026-10-05',
    );
    assert.equal(singleDayDataset.summary.gross_collected, 242.3);
    assert.equal(singleDayDataset.summary.refunds_issued, 5);
    assert.equal(singleDayDataset.summary.net_collected, 237.3);
    assert.equal(singleDayDataset.summary.tax_total, 27.3);
    assert.equal(singleDayDataset.summary.discount_total, 5); // 3 order + 2 item
    assert.equal(singleDayDataset.summary.service_charge_total, 4);
    assert.equal(singleDayDataset.summary.packaging_charge_total, 1.5);
    assert.equal(singleDayDataset.summary.delivery_charge_total, 2.5);

    const dailySalesTextEn = formatDailySalesWhatsAppMessage(singleDayDataset, { language: 'en' });
    assert.ok(dailySalesTextEn.length <= whatsappService.MAX_BODY_CHARS);
    assert.match(dailySalesTextEn, /Cafe North/);
    assert.match(dailySalesTextEn, /Daily Sales Report/);
    assert.match(dailySalesTextEn, /Business date: 2026-10-05 \(America\/Toronto\)/);
    assert.match(dailySalesTextEn, /\$242\.30/); // gross collected
    assert.match(dailySalesTextEn, /\$5\.00/); // refunds & discounts
    assert.match(dailySalesTextEn, /\$237\.30/); // net collected
    assert.match(dailySalesTextEn, /\$27\.30/); // tax
    assert.match(dailySalesTextEn, /\$4\.00/); // service charge
    assert.match(dailySalesTextEn, /\$1\.50/); // packaging
    assert.match(dailySalesTextEn, /\$2\.50/); // delivery
    assert.match(dailySalesTextEn, /Cash: \$67\.80/); // 72.80 - 5.00 refund
    assert.match(dailySalesTextEn, /Card: \$169\.50/);
    // Top 5 items by net_item_sales descending (60, 50, 40, 30, 20); Flat White (10) is #6 and omitted.
    assert.match(dailySalesTextEn, /1\. Americano \(7\) - \$60\.00/);
    assert.match(dailySalesTextEn, /5\. Cortado \(3\) - \$20\.00/);
    assert.ok(
      !dailySalesTextEn.includes('Flat White'),
      'only top 5 items by net item sales are included',
    );

    // Store-language localization across all 24 supported languages + regional currency formatting
    for (const localeFile of localeFiles) {
      const lang = localeFile.replace(/\.json$/, '');
      const msgJson = JSON.parse(fs.readFileSync(path.join(messageDir, localeFile), 'utf8'));
      const rendered = formatDailySalesWhatsAppMessage(singleDayDataset, { language: lang });
      assert.ok(
        rendered.includes(msgJson.dashboard.dailySalesWhatsAppTitle),
        `${lang}: daily sales WhatsApp summary uses store language title`,
      );
      assert.ok(
        rendered.includes(msgJson.dashboard.netCollections),
        `${lang}: daily sales WhatsApp summary uses store language netCollections label`,
      );
      assert.ok(
        rendered.length <= whatsappService.MAX_BODY_CHARS,
        `${lang}: stays within transport limit`,
      );
    }
    const frenchRangeDataset = buildDailySalesExportDataset({
      from: '2026-10-05',
      to: '2026-10-06',
    });
    const frenchDailySales = formatDailySalesWhatsAppMessage(frenchRangeDataset, {
      language: 'fr',
      locale: 'fr-CA',
    });
    assert.ok(frenchDailySales.includes('2026-10-05') && frenchDailySales.includes('2026-10-06'));
    const expectedFrNet = new Intl.NumberFormat('fr-CA', {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(frenchRangeDataset.summary.net_collected);
    assert.ok(
      frenchDailySales.includes(expectedFrNet),
      'formats daily-sales totals with regional locale conventions',
    );

    // Truncation discipline: shorten/drop optional item detail BEFORE ever omitting financial totals.
    const longItemsDataset = {
      ...singleDayDataset,
      items: Array.from({ length: 6 }, (_, idx) => ({
        product_id: `long-${idx}`,
        product_name:
          `Artisanal Single-Origin Pour-Over Reserve Lot #${idx + 1} ` + 'X'.repeat(900),
        product_sku: null,
        quantity: 10 - idx,
        gross_item_sales: (6 - idx) * 100,
        item_discounts: 0,
        net_item_sales: (6 - idx) * 100,
        tax_amount: 0,
        ingredient_cost: null,
        profit: null,
        margin_percent: null,
        cost_status: 'unknown' as const,
      })),
    };
    const truncatedAt4096 = formatDailySalesWhatsAppMessage(longItemsDataset, {
      language: 'en',
      maxChars: 4096,
    });
    assert.ok(truncatedAt4096.length <= 4096, 'long item names never push body past 4096 chars');
    assert.match(truncatedAt4096, /Gross Collections: \$242\.30/);
    assert.match(truncatedAt4096, /Refunds: \$5\.00/);
    assert.match(truncatedAt4096, /Net Collections: \$237\.30/);
    assert.match(truncatedAt4096, /Tax: \$27\.30/);
    assert.match(truncatedAt4096, /Discount: \$5\.00/);
    assert.match(truncatedAt4096, /Service Charge: \$4\.00/);
    assert.match(truncatedAt4096, /Packaging: \$1\.50/);
    assert.match(truncatedAt4096, /Delivery: \$2\.50/);

    const shortenedItemsTruncated = formatDailySalesWhatsAppMessage(longItemsDataset, {
      language: 'en',
      maxChars: 420,
    });
    assert.ok(
      shortenedItemsTruncated.length <= 420,
      'respects intermediate maxChars cap by shortening items',
    );
    assert.ok(
      shortenedItemsTruncated.includes('1. ') && !shortenedItemsTruncated.includes('5. '),
      'reduces item count before dropping all items',
    );
    assert.match(shortenedItemsTruncated, /Gross Collections: \$242\.30/);
    assert.match(shortenedItemsTruncated, /Net Collections: \$237\.30/);

    const tightTruncated = formatDailySalesWhatsAppMessage(longItemsDataset, {
      language: 'en',
      maxChars: 340,
    });
    assert.ok(tightTruncated.length <= 340, 'respects tight maxChars cap');
    assert.match(tightTruncated, /Gross Collections: \$242\.30/);
    assert.match(tightTruncated, /Refunds: \$5\.00/);
    assert.match(tightTruncated, /Net Collections: \$237\.30/);
    assert.match(tightTruncated, /Tax: \$27\.30/);
    assert.match(tightTruncated, /Discount: \$5\.00/);
    assert.match(tightTruncated, /Service Charge: \$4\.00/);
    assert.match(tightTruncated, /Packaging: \$1\.50/);
    assert.match(tightTruncated, /Delivery: \$2\.50/);
    assert.match(tightTruncated, /Card: \$169\.50/);
    assert.match(tightTruncated, /Cash: \$67\.80/);
    assert.ok(
      !tightTruncated.includes('Top Products'),
      'drops optional top-products section before omitting financial totals',
    );

    // Route tests for POST /api/reports/daily-sales/whatsapp:
    // 1. Permission checks (reports.view, reports.daily-sales.export, whatsapp.use)
    const managerForbiddenDaily = await request(app)
      .post('/api/reports/daily-sales/whatsapp')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ date: '2026-10-05', phone_e164: '+14165551234' });
    assert.equal(managerForbiddenDaily.status, 403);
    assert.equal(
      managerForbiddenDaily.body.permission,
      'reports.daily-sales.export',
      'manager with reports.view + whatsapp.use is still blocked without reports.daily-sales.export',
    );

    const noReportsCashierId = 'cashier-no-reports-daily';
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, 'No Reports Cashier', ?, 'unused', 'cashier', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(noReportsCashierId, 'cashier-no-reports-daily@example.local');
    const noReportsCashierToken = jwt.sign(
      { userId: noReportsCashierId, role: 'cashier' },
      getJWTSecret(),
      { expiresIn: '1h' },
    );
    const cashierForbiddenDaily = await request(app)
      .post('/api/reports/daily-sales/whatsapp')
      .set('Authorization', `Bearer ${noReportsCashierToken}`)
      .send({ date: '2026-10-05', phone_e164: '+14165551234' });
    assert.equal(cashierForbiddenDaily.status, 403);
    assert.equal(cashierForbiddenDaily.body.permission, 'reports.view');

    db.prepare(`
      INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES (?, 'whatsapp.use', 'deny', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(owner.userId, owner.userId);
    const ownerDeniedWhatsApp = await request(app)
      .post('/api/reports/daily-sales/whatsapp')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ date: '2026-10-05', phone_e164: '+14165551234' });
    assert.equal(ownerDeniedWhatsApp.status, 403);
    assert.equal(ownerDeniedWhatsApp.body.permission, 'whatsapp.use');
    db.prepare(
      `DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_id = 'whatsapp.use'`,
    ).run(owner.userId);

    // 2. Range validation: 93 business days allowed, 94 business days rejected
    sendResult = { ok: true, messageId: 88 };
    const max93RangeRes = await request(app)
      .post('/api/reports/daily-sales/whatsapp')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ from: '2026-07-06', to: '2026-10-06', phone_e164: '+14165551234' }); // 93 days inclusive
    assert.equal(max93RangeRes.status, 200, '93-business-date inclusive range succeeds');
    assert.equal(max93RangeRes.body.success, true);
    assert.equal(max93RangeRes.body.messageId, 88);
    assert.equal(lastWhatsAppSend.kind, 'daily_sales_report');

    const over93RangeRes = await request(app)
      .post('/api/reports/daily-sales/whatsapp')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ from: '2026-07-05', to: '2026-10-06', phone_e164: '+14165551234' }); // 94 days inclusive
    assert.equal(over93RangeRes.status, 400, '>93-business-date range is rejected');
    assert.equal(over93RangeRes.body.reason, 'invalid_range');

    // 3. Disconnected fallback vs confirmed transport send on client helper
    sendResult = { ok: false, reason: 'not_connected', error: 'WhatsApp not connected' };
    const dailyFallbackRes = await request(app)
      .post('/api/reports/daily-sales/whatsapp')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ date: '2026-10-05', phone_e164: '+14165551234' });
    assert.equal(dailyFallbackRes.status, 200);
    assert.equal(dailyFallbackRes.body.fallback, true);
    assert.equal(dailyFallbackRes.body.reason, 'not_connected');
    assert.match(dailyFallbackRes.body.body, /\$237\.30/);

    clientApiCalls.length = 0;
    clientApiError = null;
    clientApiResponse = { success: true, messageId: 91, body: dailyFallbackRes.body.body };
    const dailySentPopup = popupWindow();
    assert.equal(
      await shareDailySalesViaWhatsApp({ date: '2026-10-05' }, '+14165551234'),
      'sent',
      'confirmed transport send returns sent',
    );
    assert.equal(dailySentPopup.closed, true, 'confirmed transport send closes pre-opened popup');
    assert.equal(dailySentPopup.location.href, '');

    clientApiResponse = {
      fallback: true,
      reason: 'not_connected',
      body: dailyFallbackRes.body.body,
    };
    const dailyOpenPopup = popupWindow();
    assert.equal(
      await shareDailySalesViaWhatsApp({ from: '2026-10-05', to: '2026-10-06' }, '+14165551234'),
      'opened',
      'disconnected fallback opens manual share window and returns opened',
    );
    assert.equal(dailyOpenPopup.closed, false);
    assert.equal(isSafeWhatsAppShareUrl(dailyOpenPopup.location.href), true);
    assert.equal(
      new URL(dailyOpenPopup.location.href).searchParams.get('text'),
      dailyFallbackRes.body.body,
    );

    clientApiError = Object.assign(new Error('WhatsApp disabled'), {
      response: { status: 400, data: { error: 'WhatsApp is disabled', reason: 'feature_off' } },
    });
    const dailyErrPopup = popupWindow();
    await assert.rejects(
      () => shareDailySalesViaWhatsApp({ date: '2026-10-05' }, '+14165551234'),
      /WhatsApp disabled/,
    );
    assert.equal(
      dailyErrPopup.closed,
      true,
      'disabled/blocked error closes popup without opening wa.me',
    );
    assert.equal(dailyErrPopup.location.href, '');
    clientApiError = null;

    // ── Report message kinds (z_report & daily_sales_report) history & retry access control ──
    const failedZInsert = db
      .prepare(`
      INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body, error, queued_at, failed_at, created_by_user_id)
      VALUES ('+14165551234', 'outbound', 'z_report', 'failed', 'Failed Z report', 'not_connected', '2026-10-05T18:00:00.000Z', '2026-10-05T18:00:01.000Z', 'rule:z_report_day_close')
    `)
      .run();
    const failedZMsgId = Number(failedZInsert.lastInsertRowid);
    const failedDailyInsert = db
      .prepare(`
      INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body, error, queued_at, failed_at, created_by_user_id)
      VALUES ('+14165551234', 'outbound', 'daily_sales_report', 'failed', 'Failed daily sales report', 'not_connected', '2026-10-05T19:00:00.000Z', '2026-10-05T19:00:01.000Z', ?)
    `)
      .run(owner.userId);
    const failedDailyMsgId = Number(failedDailyInsert.lastInsertRowid);

    const noReportsHistory = await request(whatsappApp)
      .get('/api/whatsapp/messages?direction=outbound&limit=50')
      .set('Authorization', `Bearer ${noReportsCashierToken}`);
    assert.equal(noReportsHistory.status, 200);
    assert.ok(
      noReportsHistory.body.messages.every(
        (m: any) => m.kind !== 'z_report' && m.kind !== 'daily_sales_report',
      ),
      'both z_report and daily_sales_report are hidden from users without reports.view',
    );
    const noReportsExplicitDailyKind = await request(whatsappApp)
      .get('/api/whatsapp/messages?direction=outbound&kind=daily_sales_report')
      .set('Authorization', `Bearer ${noReportsCashierToken}`);
    assert.equal(noReportsExplicitDailyKind.body.messages.length, 0);

    const cashierRetryZ = await request(whatsappApp)
      .post(`/api/whatsapp/messages/${failedZMsgId}/retry`)
      .set('Authorization', `Bearer ${noReportsCashierToken}`);
    assert.equal(cashierRetryZ.status, 403, 'cashier without reports.view cannot retry z_report');

    const cashierRetryDaily = await request(whatsappApp)
      .post(`/api/whatsapp/messages/${failedDailyMsgId}/retry`)
      .set('Authorization', `Bearer ${noReportsCashierToken}`);
    assert.equal(
      cashierRetryDaily.status,
      403,
      'cashier without reports.view cannot retry daily_sales_report',
    );

    const managerRetryDaily = await request(whatsappApp)
      .post(`/api/whatsapp/messages/${failedDailyMsgId}/retry`)
      .set('Authorization', `Bearer ${manager.token}`);
    assert.equal(
      managerRetryDaily.status,
      403,
      'manager with reports.view but without reports.daily-sales.export cannot retry daily_sales_report',
    );

    const cashierDirectSendReport = await request(whatsappApp)
      .post('/api/whatsapp/send')
      .set('Authorization', `Bearer ${noReportsCashierToken}`)
      .send({ phone_e164: '+14165551234', kind: 'z_report', body: 'spoofed report' });
    assert.equal(
      cashierDirectSendReport.status,
      403,
      'POST /whatsapp/send blocks report kinds without reports.view',
    );

    const managerDirectSendDaily = await request(whatsappApp)
      .post('/api/whatsapp/send')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({
        phone_e164: '+14165551234',
        kind: 'daily_sales_report',
        body: 'spoofed daily report',
      });
    assert.equal(
      managerDirectSendDaily.status,
      403,
      'POST /whatsapp/send blocks daily_sales_report without reports.daily-sales.export',
    );

    // ── Real WhatsApp service integration: quiet hours / weekly cap bypass, safety obedience, and Z-on-day-close ──
    useRealWhatsAppInReportsRoute = true;
    const fullApp = testSetup.createApp({
      '/api/reports': reportRoutes,
      '/api/whatsapp': whatsappRoutes,
      '/api/cash-closures': cashClosureRoutes,
      '/api/cash-sessions': cashSessionRoutes,
    });

    // Default Z-on-day-close rule is off with empty recipient (never inferred from business_phone)
    const initialAutoRes = await request(fullApp)
      .get('/api/whatsapp/automation')
      .set('Authorization', `Bearer ${owner.token}`);
    assert.equal(initialAutoRes.status, 200);
    const initialZRule = initialAutoRes.body.config.rules.find(
      (r: any) => r.trigger === 'z_report_day_close',
    );
    assert.ok(initialZRule, 'z_report_day_close rule is present in default automation config');
    assert.equal(initialZRule.enabled, false, 'z_report_day_close ships disabled by default');
    assert.equal(
      initialZRule.recipientPhone,
      '',
      'recipientPhone is never inferred from business_phone',
    );

    // Validation & owner-only gate on PUT /api/whatsapp/automation
    const missingRecipientSave = await request(fullApp)
      .put('/api/whatsapp/automation')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        rules: [
          {
            id: 'z_report_day_close',
            trigger: 'z_report_day_close',
            enabled: true,
            templateId: 'receipt',
            recipientPhone: '',
          },
        ],
      });
    assert.equal(missingRecipientSave.status, 400);
    assert.equal(missingRecipientSave.body.reason, 'phone_required');

    const invalidRecipientSave = await request(fullApp)
      .put('/api/whatsapp/automation')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        rules: [
          {
            id: 'z_report_day_close',
            trigger: 'z_report_day_close',
            enabled: true,
            templateId: 'receipt',
            recipientPhone: 'abc',
          },
        ],
      });
    assert.equal(invalidRecipientSave.status, 400);
    assert.equal(invalidRecipientSave.body.reason, 'invalid_phone');

    const managerModifyZRule = await request(fullApp)
      .put('/api/whatsapp/automation')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({
        rules: [
          {
            id: 'z_report_day_close',
            trigger: 'z_report_day_close',
            enabled: true,
            templateId: 'receipt',
            recipientPhone: '+14165559999',
          },
        ],
      });
    assert.equal(managerModifyZRule.status, 403, 'non-owner cannot configure z_report_day_close');
    assert.equal(managerModifyZRule.body.reason, 'owner_required');

    const managerSaveUnchangedZRule = await request(fullApp)
      .put('/api/whatsapp/automation')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({
        ...initialAutoRes.body.config,
        safety: { ...initialAutoRes.body.config.safety, maxPerCustomerPerWeek: 1 },
      });
    assert.equal(
      managerSaveUnchangedZRule.status,
      200,
      'manager can still save non-owner automation settings when z_report_day_close is unchanged',
    );

    // Disabled WhatsApp obeyed by owner reports
    const disabledDailySend = await request(fullApp)
      .post('/api/reports/daily-sales/whatsapp')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ date: '2026-10-05', phone_e164: '+14165558801' });
    assert.equal(disabledDailySend.status, 400, 'daily-sales WhatsApp obeys disabled WhatsApp');
    assert.equal(disabledDailySend.body.reason, 'feature_off');

    // Enable & connect simulated WhatsApp socket
    await whatsappService.enable(owner.userId);
    await whatsappService.connectWithQr();
    baileysEventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(whatsappService.getStatus().state, 'connected');

    // Configure 24-hour quiet hours + maxPerCustomerPerWeek = 1 + enable z_report_day_close to +14165559900
    // (quietHoursStart = 00:00, quietHoursEnd = 00:00 is equal; use 00:00..23:59 + 23:00..01:00 -> 00:01..00:00 wraps all 24 hours!)
    const ownerConfigureAuto = await request(fullApp)
      .put('/api/whatsapp/automation')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        rules: [
          ...initialAutoRes.body.config.rules.filter(
            (r: any) => r.trigger !== 'z_report_day_close',
          ),
          {
            id: 'z_report_day_close',
            trigger: 'z_report_day_close',
            enabled: true,
            templateId: 'receipt',
            recipientPhone: '416-555-9900',
          },
        ],
        safety: {
          autoOptOutEnabled: true,
          quietHoursEnabled: true,
          quietHoursStart: '00:01',
          quietHoursEnd: '00:00',
          maxPerCustomerPerWeek: 1,
          feedbackLink: '',
        },
      });
    assert.equal(ownerConfigureAuto.status, 200);
    const savedZRule = ownerConfigureAuto.body.config.rules.find(
      (r: any) => r.trigger === 'z_report_day_close',
    );
    assert.equal(savedZRule.enabled, true);
    assert.equal(savedZRule.recipientPhone, '+14165559900', 'recipientPhone normalized to E.164');

    // Seed a prior customer auto_followup to +14165558802 so weekly cap (1) is already reached,
    // and verify customer campaign send is blocked while owner report send succeeds!
    db.prepare(`
      INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body, queued_at, created_by_user_id)
      VALUES ('+14165558802', 'outbound', 'auto_followup', 'sent', 'Prior campaign', datetime('now', '-1 hour'), 'rule:winback')
    `).run();
    const campaignBlocked = await whatsappService.sendMessage({
      phoneE164: '+14165558802',
      body: 'Customer campaign during quiet hours / over cap',
      billId: null,
      customerId: null,
      kind: 'auto_followup',
      userId: 'rule:winback',
    });
    assert.equal(campaignBlocked.ok, false);
    assert.ok(
      campaignBlocked.reason === 'quiet_hours' || campaignBlocked.reason === 'weekly_cap',
      `customer campaign is blocked by quiet_hours or weekly_cap (got ${campaignBlocked.reason})`,
    );

    const reportBypassesCampaignLimits = await request(fullApp)
      .post('/api/reports/daily-sales/whatsapp')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ date: '2026-10-05', phone_e164: '+14165558802' });
    assert.equal(
      reportBypassesCampaignLimits.status,
      200,
      'owner daily-sales report bypasses quiet hours and weekly customer cap',
    );
    assert.equal(reportBypassesCampaignLimits.body.success, true);

    // Rate limit (RATE_LIMIT_MIN_GAP_MS) and blocklist are STILL obeyed by owner reports:
    delete process.env.FLO_WHATSAPP_FAST_DELAY;
    let rateLimitedSecondReport: any;
    try {
      rateLimitedSecondReport = await request(fullApp)
        .post('/api/reports/daily-sales/whatsapp')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ date: '2026-10-06', phone_e164: '+14165558802' });
    } finally {
      process.env.FLO_WHATSAPP_FAST_DELAY = '1';
    }
    assert.equal(
      rateLimitedSecondReport.status,
      429,
      'owner report still obeys transport rate limits',
    );
    assert.equal(rateLimitedSecondReport.body.reason, 'rate_limited');

    whatsappService.addToBlocklist('+14165558803', 'owner test block', owner.userId);
    const blockedReportRes = await request(fullApp)
      .post('/api/reports/daily-sales/whatsapp')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ date: '2026-10-05', phone_e164: '+14165558803' });
    assert.equal(blockedReportRes.status, 400, 'owner report still obeys blocklist');
    assert.equal(blockedReportRes.body.reason, 'blocked');

    // Per-staff shift close (scope = 'session') MUST NOT trigger automatic Z-report on day close
    const openShiftRes = await request(fullApp)
      .post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ opening_float_cents: 5000 });
    assert.equal(openShiftRes.status, 200);
    const shiftId = openShiftRes.body.id;
    const sentBeforeShiftClose = sentSocketMessages.length;
    const autoZBeforeShiftClose = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM whatsapp_messages WHERE created_by_user_id = 'rule:z_report_day_close'`,
        )
        .get() as { c: number }
    ).c;
    const closeShiftRes = await request(fullApp)
      .post(`/api/cash-sessions/${shiftId}/close`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ counted_cash_cents: 5000, notes: 'End of staff shift' });
    assert.equal(closeShiftRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      sentSocketMessages.length,
      sentBeforeShiftClose,
      'closing a per-staff shift never sends an automatic Z-report',
    );
    const shiftCloseAutoRows = db
      .prepare(`
      SELECT COUNT(*) AS c FROM whatsapp_messages WHERE created_by_user_id = 'rule:z_report_day_close'
    `)
      .get() as { c: number };
    assert.equal(
      shiftCloseAutoRows.c,
      autoZBeforeShiftClose,
      'per-staff shift close creates zero z_report_day_close rows',
    );
    const sessionClosureRow = db
      .prepare(`SELECT id FROM cash_closures WHERE scope = 'session' ORDER BY id DESC LIMIT 1`)
      .get() as { id: number };
    const directSessionTrigger = await whatsappService.triggerDayCloseZReport(sessionClosureRow.id);
    assert.equal(directSessionTrigger.reason, 'not_day_close');

    // Store-level day close (POST /api/cash-closures) triggers automatic Z-report once and is idempotent
    const dayCloseRes = await request(fullApp)
      .post('/api/cash-closures')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        business_date: '2026-10-05',
        opening_float_cents: 10000,
        counted_cash_cents: 16780,
        notes: 'Closed cleanly',
      });
    assert.equal(dayCloseRes.status, 201);
    const dayCloseId = dayCloseRes.body.zReport.id;
    // Wait briefly for the fire-and-forget async triggerDayCloseZReport to complete (5ms fast typing delay)
    for (let attempt = 0; attempt < 40; attempt++) {
      const row = db
        .prepare(
          `SELECT status FROM whatsapp_messages WHERE cash_closure_id = ? AND created_by_user_id = 'rule:z_report_day_close'`,
        )
        .get(dayCloseId) as { status: string } | undefined;
      if (row && (row.status === 'sent' || row.status === 'failed')) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const autoZRowsAfterClose = db
      .prepare(`
      SELECT id, phone_e164, kind, status, body, cash_closure_id, created_by_user_id
      FROM whatsapp_messages
      WHERE cash_closure_id = ? AND created_by_user_id = 'rule:z_report_day_close'
    `)
      .all(dayCloseId) as any[];
    assert.equal(
      autoZRowsAfterClose.length,
      1,
      'persists one automatic attempt for the day closure',
    );
    assert.equal(autoZRowsAfterClose[0].phone_e164, '+14165559900');
    assert.equal(autoZRowsAfterClose[0].kind, 'z_report');
    assert.equal(autoZRowsAfterClose[0].status, 'sent');
    assert.match(autoZRowsAfterClose[0].body, /Z report #/);
    assert.match(autoZRowsAfterClose[0].body, /2026-10-05/);
    assert.match(autoZRowsAfterClose[0].body, /\$237\.30/); // canonical day net collections

    // Duplicate close request (409) + repeated triggerDayCloseZReport + simulated restart never send a duplicate
    const sentCountAfterFirstAutoZ = sentSocketMessages.length;
    const duplicateCloseRes = await request(fullApp)
      .post('/api/cash-closures')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        business_date: '2026-10-05',
        opening_float_cents: 10000,
        counted_cash_cents: 16780,
      });
    assert.equal(duplicateCloseRes.status, 409);
    const dupTriggerResult = await whatsappService.triggerDayCloseZReport(dayCloseId);
    assert.equal(dupTriggerResult.reason, 'duplicate_closure');
    assert.equal(
      sentSocketMessages.length,
      sentCountAfterFirstAutoZ,
      'duplicate close and repeated trigger never re-send automatic Z-report',
    );

    // Failing transport on day close: day close STILL commits (201), records failed status, does NOT auto-retry on reconnect, and supports manual retry
    // Use a fresh recipient phone so RATE_LIMIT_MIN_GAP_MS from dayCloseId does not mask the transport failure test.
    await request(fullApp)
      .put('/api/whatsapp/automation')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        rules: [
          ...ownerConfigureAuto.body.config.rules.filter(
            (r: any) => r.trigger !== 'z_report_day_close',
          ),
          {
            id: 'z_report_day_close',
            trigger: 'z_report_day_close',
            enabled: true,
            templateId: 'receipt',
            recipientPhone: '+14165559901',
          },
        ],
      });
    socketSendShouldThrow = true;
    const autoSharePopupGuard = popupWindow();
    const failingTransportCloseRes = await request(fullApp)
      .post('/api/cash-closures')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        business_date: '2026-10-06',
        opening_float_cents: 5000,
        counted_cash_cents: 5000,
      });
    assert.equal(
      failingTransportCloseRes.status,
      201,
      'transport send failure never fails or rolls back day close',
    );
    const failedCloseId = failingTransportCloseRes.body.zReport.id;
    for (let attempt = 0; attempt < 40; attempt++) {
      const row = db
        .prepare(
          `SELECT status FROM whatsapp_messages WHERE cash_closure_id = ? AND created_by_user_id = 'rule:z_report_day_close'`,
        )
        .get(failedCloseId) as { status: string } | undefined;
      if (row && row.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(
      autoSharePopupGuard.location.href,
      '',
      'automatic send never opens a share window',
    );
    const failedAutoZRow = db
      .prepare(`
      SELECT id, status, error, cash_closure_id
      FROM whatsapp_messages
      WHERE cash_closure_id = ? AND created_by_user_id = 'rule:z_report_day_close'
    `)
      .get(failedCloseId) as {
      id: number;
      status: string;
      error: string | null;
      cash_closure_id: number;
    };
    assert.equal(
      failedAutoZRow.status,
      'failed',
      'failing transport records failed status on the single closure attempt',
    );
    assert.ok(Boolean(failedAutoZRow.error));

    // Reconnecting / restarting does NOT auto-retry failed Z-report
    socketSendShouldThrow = false;
    const sentBeforeReconnect = sentSocketMessages.length;
    whatsappService.initFromDb();
    baileysEventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      sentSocketMessages.length,
      sentBeforeReconnect,
      'reconnecting after transport failure does not automatically retry uncertain/failed Z-report',
    );
    const repeatedFailedTrigger = await whatsappService.triggerDayCloseZReport(failedCloseId);
    assert.equal(repeatedFailedTrigger.reason, 'duplicate_closure');

    // Backdate failed_at past RATE_LIMIT_MIN_GAP_MS so owner can immediately exercise manual retry
    db.prepare(
      `UPDATE whatsapp_messages SET queued_at = datetime('now', '-2 minutes'), failed_at = datetime('now', '-2 minutes') WHERE id = ?`,
    ).run(failedAutoZRow.id);
    const manualRetryRes = await request(fullApp)
      .post(`/api/whatsapp/messages/${failedAutoZRow.id}/retry`)
      .set('Authorization', `Bearer ${owner.token}`);
    assert.equal(manualRetryRes.status, 200, 'owner can manually retry failed automatic Z-report');
    assert.equal(manualRetryRes.body.ok, true);
    assert.equal(
      manualRetryRes.body.messageId,
      failedAutoZRow.id,
      'manual retry reuses the same message row',
    );
    const countForFailedCloseAfterRetry = db
      .prepare(`SELECT COUNT(*) AS c FROM whatsapp_messages WHERE cash_closure_id = ?`)
      .get(failedCloseId) as { c: number };
    assert.equal(
      countForFailedCloseAfterRetry.c,
      1,
      'manual retry does not duplicate the closure row',
    );

    // Uncertain delivery (submitted to socket without server ACK before ACK timeout):
    // exposes ack_timeout failure with no auto-retry, preserves whatsapp_message_attempts, and supports manual retry.
    await request(fullApp)
      .put('/api/whatsapp/automation')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        rules: [
          ...ownerConfigureAuto.body.config.rules.filter(
            (r: any) => r.trigger !== 'z_report_day_close',
          ),
          {
            id: 'z_report_day_close',
            trigger: 'z_report_day_close',
            enabled: true,
            templateId: 'receipt',
            recipientPhone: '+14165559902',
          },
        ],
      });
    autoServerAck = false;
    const unackedCloseRes = await request(fullApp)
      .post('/api/cash-closures')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        business_date: '2026-10-03',
        opening_float_cents: 0,
        counted_cash_cents: 0,
      });
    assert.equal(unackedCloseRes.status, 201);
    const unackedCloseId = unackedCloseRes.body.zReport.id;
    for (let attempt = 0; attempt < 40; attempt++) {
      const row = db
        .prepare(
          `SELECT status, external_message_id FROM whatsapp_messages WHERE cash_closure_id = ?`,
        )
        .get(unackedCloseId) as { status: string; external_message_id: string | null } | undefined;
      if (row && row.status === 'typing' && row.external_message_id) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const sweptCount = whatsappService.sweepAckTimeouts(Date.now() + 10 * 60 * 1000);
    assert.ok(
      sweptCount >= 1,
      'uncertain unacked Z-report attempt transitions to failed on ack_timeout',
    );
    const unackedRow = db
      .prepare(`SELECT id, status, error FROM whatsapp_messages WHERE cash_closure_id = ?`)
      .get(unackedCloseId) as { id: number; status: string; error: string | null };
    assert.equal(unackedRow.status, 'failed');
    assert.equal(unackedRow.error, 'ack_timeout');
    autoServerAck = true;
    const sentBeforeUnackedManualRetry = sentSocketMessages.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      sentSocketMessages.length,
      sentBeforeUnackedManualRetry,
      'no automatic retry after ack_timeout',
    );
    const unackedManualRetry = await request(fullApp)
      .post(`/api/whatsapp/messages/${unackedRow.id}/retry`)
      .set('Authorization', `Bearer ${owner.token}`);
    assert.equal(unackedManualRetry.status, 200);
    assert.equal(unackedManualRetry.body.ok, true);
    const recordedAttempts = db
      .prepare(`SELECT COUNT(*) AS c FROM whatsapp_message_attempts WHERE message_id = ?`)
      .get(unackedRow.id) as { c: number };
    assert.equal(
      recordedAttempts.c,
      2,
      'whatsapp_message_attempts records both the unacked initial send and manual retry',
    );

    // Explicit Offline mode suppresses automatic Z-on-day-close with NO delayed send on reconnection
    setSetting.run('offline_mode', 'true');
    notifyOfflineModeEnabled();
    const sentBeforeOfflineClose = sentSocketMessages.length;
    const offlineDayCloseRes = await request(fullApp)
      .post('/api/cash-closures')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        business_date: '2026-10-04',
        opening_float_cents: 0,
        counted_cash_cents: 0,
      });
    assert.equal(offlineDayCloseRes.status, 201);
    const offlineCloseId = offlineDayCloseRes.body.zReport.id;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const offlineAutoRows = db
      .prepare(`SELECT COUNT(*) AS c FROM whatsapp_messages WHERE cash_closure_id = ?`)
      .get(offlineCloseId) as { c: number };
    assert.equal(offlineAutoRows.c, 0, 'explicit Offline mode suppresses automatic Z-report send');

    // Turn Offline mode off and reconnect: no delayed send fires for offlineCloseId
    setSetting.run('offline_mode', 'false');
    await whatsappService.connectWithQr();
    baileysEventHandlers.get('connection.update')?.({ connection: 'open' });
    await whatsappService.runScheduledAutomationSweep();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const postReconnectOfflineRows = db
      .prepare(`SELECT COUNT(*) AS c FROM whatsapp_messages WHERE cash_closure_id = ?`)
      .get(offlineCloseId) as { c: number };
    assert.equal(
      postReconnectOfflineRows.c,
      0,
      'reconnecting after Offline mode does not trigger a delayed automatic Z-report send',
    );
    assert.equal(sentSocketMessages.length, sentBeforeOfflineClose);

    await whatsappService.shutdown();
    console.log(
      'Cash-close and daily-sales WhatsApp formatting, fallback, auto-Z, and permission tests passed.',
    );
  } finally {
    try {
      await whatsappService.shutdown();
    } catch {
      // ignore cleanup errors
    }
    testSetup.closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
