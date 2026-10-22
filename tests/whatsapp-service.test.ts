/**
 * whatsapp-service.test.ts
 *
 * Smoke test for the service module's public API and shutdown persistence.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
const realLoad = (Module as any)._load;

const eventHandlers = new Map<string, (value: any) => void>();
let presenceStarted!: () => void;
const presenceStartedPromise = new Promise<void>((resolve) => { presenceStarted = resolve; });
let releasePendingPresence!: () => void;
const pendingPresence = new Promise<void>((resolve) => { releasePendingPresence = resolve; });
let presenceSettled = false;
void pendingPresence.then(() => { presenceSettled = true; });
let makeSocketCalls = 0;
let authStateCalls = 0;
let holdAuthState = false;
let authStateStarted!: () => void;
const authStateStartedPromise = new Promise<void>((resolve) => { authStateStarted = resolve; });
let releaseAuthState!: () => void;
const authStateGate = new Promise<void>((resolve) => { releaseAuthState = resolve; });
let holdRecoveryAuthState = false;
let recoveryAuthStateStarted!: () => void;
const recoveryAuthStateStartedPromise = new Promise<void>((resolve) => { recoveryAuthStateStarted = resolve; });
let releaseRecoveryAuthState!: () => void;
const recoveryAuthStateGate = new Promise<void>((resolve) => { releaseRecoveryAuthState = resolve; });
let holdRequestAuthState = false;
let requestAuthStateStarted!: () => void;
const requestAuthStateStartedPromise = new Promise<void>((resolve) => { requestAuthStateStarted = resolve; });
let releaseRequestAuthState!: () => void;
const requestAuthStateGate = new Promise<void>((resolve) => { releaseRequestAuthState = resolve; });
const baileysLogLines: string[] = [];
let holdCredentialWrite = false;
let credentialWriteStarted!: () => void;
const credentialWriteStartedPromise = new Promise<void>((resolve) => { credentialWriteStarted = resolve; });
let releaseCredentialWrite!: () => void;
const credentialWriteGate = new Promise<void>((resolve) => { releaseCredentialWrite = resolve; });
let holdPresence = false;
let sentMsgSeq = 0;
const fakeSocket = {
  ev: { on: (event: string, handler: (value: any) => void) => { eventHandlers.set(event, handler); } },
  onWhatsApp: async (jid: string) => [{ exists: true, jid }],
  presenceSubscribe: async () => {
    if (holdPresence) {
      presenceStarted();
      return pendingPresence;
    }
  },
  sendPresenceUpdate: async () => {},
  sendMessage: async () => ({ key: { id: `shutdown-test-message-${++sentMsgSeq}` } }),
  end: () => {},
};
const fakeBaileys = {
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1] }),
  useMultiFileAuthState: async () => {
    authStateCalls++;
    if (holdAuthState) {
      authStateStarted();
      await authStateGate;
    }
    if (holdRecoveryAuthState) {
      recoveryAuthStateStarted();
      await recoveryAuthStateGate;
    }
    if (holdRequestAuthState) {
      requestAuthStateStarted();
      await requestAuthStateGate;
    }
    return {
      state: {},
      saveCreds: async () => {
        if (holdCredentialWrite) {
          credentialWriteStarted();
          await credentialWriteGate;
        }
      },
    };
  },
  makeWASocket: (options: any) => {
    makeSocketCalls++;
    options.logger.warn({ body: 'private bill body', phone: '+15555550100' }, 'Baileys warning for +15555550100');
    return fakeSocket;
  },
  Browsers: { macOS: () => ({}) },
  proto: { Message: { create: () => ({}) } },
};

(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === 'electron') {
    const testDir = path.join(os.tmpdir(), 'flo-whatsapp-shutdown-test');
    return {
      app: { getPath: () => testDir, getVersion: () => 'test', isPackaged: true },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    };
  }
  if (request === '../baileys-loader.cjs') return { loadBaileys: async () => fakeBaileys };
  return realLoad.call(this, request, ...rest);
};

const whatsapp = require('../main/services/whatsapp');
const { createShutdownEntrypoints } = require('../main/shutdown');

async function main(): Promise<void> {
  console.log('Testing WhatsApp service API surface...');
  const originalConsoleWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (line.includes('"event":"baileys_log"')) baileysLogLines.push(line);
    originalConsoleWarn(...args);
  };
  const failures: string[] = [];
  const assert = (cond: unknown, msg: string): void => {
    if (!cond) failures.push(msg);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  };

  // Lifecycle
  assert(typeof whatsapp.getStatus === 'function', 'exports getStatus()');
  assert(typeof whatsapp.enable === 'function', 'exports enable()');
  assert(typeof whatsapp.disable === 'function', 'exports disable()');
  assert(typeof whatsapp.connectWithQr === 'function', 'exports connectWithQr()');
  assert(typeof whatsapp.connectWithPairingCode === 'function', 'exports connectWithPairingCode()');
  assert(typeof whatsapp.disconnect === 'function', 'exports disconnect()');
  assert(typeof whatsapp.shutdown === 'function', 'exports shutdown()');
  assert(typeof whatsapp.initFromDb === 'function', 'exports initFromDb()');
  assert(
    whatsapp.sanitizeLogText(new Error('recipient +1 555 555 0100 via https://wa.me/15555550100?text=private-bill'))
      === 'recipient [redacted-number] via [redacted-url]',
    'diagnostic sanitizer redacts formatted phone numbers and share URLs',
  );
  const jsonCredentialDiagnostics = [
    '{"password":"credential-value","token":"token-value"}',
    '{ "auth": "auth-value", "api_key": "api-key-value" }',
  ];
  for (const diagnostic of jsonCredentialDiagnostics) {
    const sanitized = whatsapp.sanitizeLogText(diagnostic) ?? '';
    assert(
      !sanitized.includes('credential-value')
        && !sanitized.includes('token-value')
        && !sanitized.includes('auth-value')
        && !sanitized.includes('api-key-value')
        && sanitized.includes('[redacted]'),
      'diagnostic sanitizer redacts JSON-style credential fields',
    );
  }
  for (const diagnostic of ['Authorization=Bearer secret-token', 'Authorization: Bearer secret-token']) {
    const sanitized = whatsapp.sanitizeLogText(diagnostic) ?? '';
    assert(
      !sanitized.includes('secret-token') && sanitized.includes('[redacted]'),
      'diagnostic sanitizer redacts assignment-style authorization tokens',
    );
  }

  // Send + storage
  assert(typeof whatsapp.sendMessage === 'function', 'exports sendMessage()');
  assert(typeof whatsapp.listMessages === 'function', 'exports listMessages()');
  assert(typeof whatsapp.listInbox === 'function', 'exports listInbox()');
  assert(typeof whatsapp.listBlocklist === 'function', 'exports listBlocklist()');
  assert(typeof whatsapp.addToBlocklist === 'function', 'exports addToBlocklist()');
  assert(typeof whatsapp.removeFromBlocklist === 'function', 'exports removeFromBlocklist()');

  // Status shape sanity (no socket started, so connected state)
  const s = whatsapp.getStatus();
  assert(typeof s === 'object' && s !== null, 'getStatus() returns an object');
  assert(typeof s.enabled === 'boolean', 'status.enabled is boolean');
  assert(typeof s.state === 'string', 'status.state is string');
  assert(
    ['disconnected', 'connecting', 'waiting_qr', 'waiting_pairing', 'connected', 'cooldown'].includes(s.state),
    `status.state is one of the known values (got ${s.state})`,
  );

  // Send before enable returns feature_off (without touching the socket)
  const result = await whatsapp.sendMessage({
    phoneE164: '+15555550100',
    body: 'test',
    billId: null,
    customerId: null,
    kind: 'manual_reply',
    userId: null,
  });
  assert(result.ok === false, 'sendMessage returns ok=false when feature is off');
  assert(result.reason === 'feature_off', `sendMessage reason is 'feature_off' (got ${result.reason})`);

  const testDir = path.join(os.tmpdir(), 'flo-whatsapp-shutdown-test');
  const originalFetch = globalThis.fetch;
  const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
  fs.rmSync(testDir, { recursive: true, force: true });
  initDatabase();
  globalThis.fetch = (() => Promise.reject(new Error('offline test network'))) as typeof fetch;
  try {
    await whatsapp.enable('shutdown-test-user');

    holdAuthState = true;
    const socketCallsBeforeRace = makeSocketCalls;
    whatsapp.initFromDb();
    whatsapp.initFromDb();
    await authStateStartedPromise;
    releaseAuthState();
    await new Promise((resolve) => setImmediate(resolve));
    assert(makeSocketCalls === socketCallsBeforeRace + 1, 'duplicate startup initialization creates one socket');
    assert(
      baileysLogLines.some((line) => line.includes('Baileys warning for [redacted-number]')),
      'Baileys warning details are retained and sanitized in diagnostics',
    );
    assert(
      baileysLogLines.every((line) => !line.includes('private bill body')),
      'Baileys diagnostics do not include logger object message bodies',
    );
    holdAuthState = false;

    await whatsapp.connectWithQr();
    eventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));

    holdCredentialWrite = true;
    const authStateCallsBeforeCredentialRecovery = authStateCalls;
    eventHandlers.get('creds.update')?.({});
    await credentialWriteStartedPromise;
    whatsapp.disconnect();
    await whatsapp.enable('credential-recovery-test-user');
    const credentialRecovery = whatsapp.connectWithQr();
    let credentialRecoverySettled = false;
    void credentialRecovery.then(() => { credentialRecoverySettled = true; }, () => { credentialRecoverySettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert(!credentialRecoverySettled, 'startup waits for asynchronous credential persistence before reopening auth');
    releaseCredentialWrite();
    holdCredentialWrite = false;
    await credentialRecovery;
    assert(authStateCalls === authStateCallsBeforeCredentialRecovery + 1, 'credential cleanup completes before the replacement startup');

    holdRecoveryAuthState = true;
    const authStateCallsBeforeRecovery = authStateCalls;
    whatsapp.disconnect();
    await whatsapp.enable('startup-recovery-test-user');
    const cancelledStartup = whatsapp.connectWithQr().catch(() => undefined);
    await recoveryAuthStateStartedPromise;
    await whatsapp.enable('startup-recovery-test-user');
    const socketCallsBeforeRecovery = makeSocketCalls;
    whatsapp.disconnect();
    releaseRecoveryAuthState();
    holdRecoveryAuthState = false;
    await cancelledStartup;
    assert(whatsapp.getStatus().lastErrorReason === null, 'intentional startup cancellation does not report a failure');
    await whatsapp.enable('startup-recovery-test-user');
    const restartedStartup = whatsapp.connectWithQr();
    const restartedResult = await restartedStartup;
    assert(restartedResult.ok === true, 're-enable starts a fresh socket after cancellation');
    assert(makeSocketCalls === socketCallsBeforeRecovery + 1, 'cancelled startup does not create a duplicate socket');
    assert(authStateCalls === authStateCallsBeforeRecovery + 2, 're-enable waits for the cancelled startup before retrying');

    holdRequestAuthState = true;
    const authStateCallsBeforeRequestCancellation = authStateCalls;
    whatsapp.disconnect();
    await whatsapp.enable('request-cancellation-test-user');
    const requestAbort = new AbortController();
    const cancelledRequest = whatsapp.connectWithQr(requestAbort.signal).then(() => 'resolved', () => 'rejected');
    await requestAuthStateStartedPromise;
    requestAbort.abort();
    const retriedRequest = whatsapp.connectWithQr();
    releaseRequestAuthState();
    holdRequestAuthState = false;
    const [cancelledRequestResult, retriedRequestResult] = await Promise.all([cancelledRequest, retriedRequest]);
    assert(cancelledRequestResult === 'rejected', 'aborted connect request is rejected');
    assert(retriedRequestResult.ok === true, 'retry joins request-independent startup');
    assert(authStateCalls === authStateCallsBeforeRequestCancellation + 1, 'request cancellation does not restart shared auth loading');

    // Connect the socket and run Issue #1239 automation & safety tests
    eventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));
    process.env.FLO_WHATSAPP_FAST_DELAY = '1';

    // 1. Placeholder interpolation (renderWhatsAppTemplate) across customer, bill, loyalty, and store fields
    const interpolated = whatsapp.renderWhatsAppTemplate(
      'Dear {customer_name} ({customer_phone}), Visit #{visit_count} since {last_visit_date} (Spent {total_spent}). Bill #{bill_no} on {order_date}:\n{order_items}\nTotal: {total} via {payment_method}. Earned {points_earned}, Balance {points_balance} ({points_value}). Store: {store_name} {store_phone} {feedback_link} {instagram}',
      {
        customer_name: 'Priya Verma {total}',
        customer_phone: '+919876543210',
        visit_count: 5,
        last_visit_date: '2026-10-01',
        total_spent: '₹2,500.00',
        bill_no: 'BILL-009',
        order_date: '2026-10-22',
        order_items: '2x Latte - ₹400.00',
        total: '₹400.00',
        payment_method: 'UPI',
        points_earned: 40,
        points_balance: 240,
        points_value: '₹240.00',
        store_name: 'Flo Bistro',
        store_phone: '+919800000000',
        feedback_link: 'https://flocafe.example.com/review',
        instagram: '@flobistro',
      },
    );
    assert(
      interpolated.includes('Dear Priya Verma {total} (+919876543210)') &&
        interpolated.includes('Visit #5 since 2026-10-01 (Spent ₹2,500.00)') &&
        interpolated.includes('Bill #BILL-009 on 2026-10-22') &&
        interpolated.includes('2x Latte - ₹400.00') &&
        interpolated.includes('Total: ₹400.00 via UPI. Earned 40, Balance 240 (₹240.00)') &&
        interpolated.includes('Store: Flo Bistro +919800000000 https://flocafe.example.com/review @flobistro'),
      'renderWhatsAppTemplate interpolates all 16 placeholders and prevents recursive placeholder injection',
    );

    // 2. Auto opt-out on inbound STOP / UNSUBSCRIBE adds sender to whatsapp_blocklist
    eventHandlers.get('messages.upsert')?.({
      messages: [
        {
          key: { id: 'inbound-stop-1', fromMe: false, remoteJid: '15555550199@s.whatsapp.net' },
          message: { conversation: '  stop! ' },
        },
        {
          key: { id: 'inbound-unsub-2', fromMe: false, remoteJid: '15555550198@s.whatsapp.net' },
          message: { extendedTextMessage: { text: 'UNSUBSCRIBE' } },
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const blocklistAfterStop = whatsapp.listBlocklist();
    assert(
      blocklistAfterStop.some(
        (b: { phone_e164: string; blocked_by_user_id: string | null }) =>
          b.phone_e164 === '+15555550199' && b.blocked_by_user_id === 'system:auto_opt_out',
      ),
      'inbound STOP automatically adds sender to whatsapp_blocklist',
    );
    assert(
      blocklistAfterStop.some(
        (b: { phone_e164: string; blocked_by_user_id: string | null }) =>
          b.phone_e164 === '+15555550198' && b.blocked_by_user_id === 'system:auto_opt_out',
      ),
      'inbound UNSUBSCRIBE automatically adds sender to whatsapp_blocklist',
    );

    // 3. Quiet hours and weekly per-customer cap block auto_followup sends while allowing manual replies
    assert(
      whatsapp.isTimeWithinQuietHours('23:15', '22:00', '09:00') === true &&
        whatsapp.isTimeWithinQuietHours('08:30', '22:00', '09:00') === true &&
        whatsapp.isTimeWithinQuietHours('14:00', '22:00', '09:00') === false,
      'isTimeWithinQuietHours handles overnight quiet-hours windows accurately',
    );
    // Set an all-day quiet window (00:00 -> 23:59) except current minute? Better: test both windows covering 24h by setting start='00:00', end='23:59'
    whatsapp.saveAutomationConfig({
      safety: {
        autoOptOutEnabled: true,
        quietHoursEnabled: true,
        quietHoursStart: '00:00',
        quietHoursEnd: '23:59',
        maxPerCustomerPerWeek: 2,
        rateLimitPerHour: 10,
        feedbackLink: 'https://flocafe.example.com/feedback',
        instagram: '@flocafe',
      },
    });
    const blockedByQuietHours = await whatsapp.sendMessage({
      phoneE164: '+15555550120',
      body: 'Auto follow-up during quiet hours',
      billId: null,
      customerId: null,
      kind: 'auto_followup',
      userId: 'rule:feedback_delay',
    });
    assert(
      blockedByQuietHours.ok === false && blockedByQuietHours.reason === 'quiet_hours',
      'quiet hours block automated follow-up sends',
    );
    const manualDuringQuietHours = await whatsapp.sendMessage({
      phoneE164: '+15555550120',
      body: 'Manual reply during quiet hours',
      billId: null,
      customerId: null,
      kind: 'manual_reply',
      userId: 'staff-1',
    });
    assert(
      manualDuringQuietHours.ok === true,
      'quiet hours still allow manual staff replies',
    );

    // Disable quiet hours and verify weekly cap (maxPerCustomerPerWeek = 2)
    whatsapp.saveAutomationConfig({
      safety: {
        autoOptOutEnabled: true,
        quietHoursEnabled: false,
        quietHoursStart: '22:00',
        quietHoursEnd: '09:00',
        maxPerCustomerPerWeek: 2,
        rateLimitPerHour: 10,
        feedbackLink: 'https://flocafe.example.com/feedback',
        instagram: '@flocafe',
      },
    });
    const autoSend1 = await whatsapp.sendMessage({
      phoneE164: '+15555550121',
      body: 'Auto 1',
      billId: null,
      customerId: null,
      kind: 'auto_followup',
      userId: 'rule:winback',
    });
    const autoSend2 = await whatsapp.sendMessage({
      phoneE164: '+15555550121',
      body: 'Auto 2',
      billId: null,
      customerId: null,
      kind: 'auto_followup',
      userId: 'rule:winback',
    });
    const autoSend3 = await whatsapp.sendMessage({
      phoneE164: '+15555550121',
      body: 'Auto 3 over weekly cap',
      billId: null,
      customerId: null,
      kind: 'auto_followup',
      userId: 'rule:winback',
    });
    const manualAfterCap = await whatsapp.sendMessage({
      phoneE164: '+15555550121',
      body: 'Manual reply after weekly cap',
      billId: null,
      customerId: null,
      kind: 'manual_reply',
      userId: 'staff-1',
    });
    assert(autoSend1.ok === true && autoSend2.ok === true, 'automated sends under weekly cap succeed');
    assert(
      autoSend3.ok === false && autoSend3.reason === 'weekly_cap',
      'weekly per-customer cap blocks automated sends once reached',
    );
    assert(
      manualAfterCap.ok === true,
      'weekly per-customer cap still allows manual staff replies',
    );

    // 4. Automated rules on bill payment completion (after_payment, points_threshold, nth_visit) + trigger_rule in listMessages
    const db = getDatabase();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'US'), ('currency', 'USD'), ('business_name', 'Flo Test Cafe')").run();
    db.prepare(`
      INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES ('cust-auto-1', 'Maya Lin', '+14089961010', 'US', 1, datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO orders (id, order_number, type, status, customer_id, subtotal, tax_amount, discount_amount, total, created_at, updated_at)
      VALUES (901, 'ORD-901', 'dine_in', 'completed', 'cust-auto-1', 50, 0, 0, 50, datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status)
      VALUES (901, 'prod-auto-1', 'Cappuccino', 2, 25, 50, 0, 50, 'delivered')
    `).run();
    db.prepare(`
      INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (901, 'INV-901', 901, 'cust-auto-1', 50, 0, 0, 50, 50, 0, 'paid', '[{"method":"card","amount":50}]', datetime('now'), datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at)
      VALUES ('cust-auto-1', 901, 'credit', 150, 'Cashback on bill INV-901', datetime('now'), datetime('now'))
    `).run();

    whatsapp.saveAutomationConfig({
      safety: {
        autoOptOutEnabled: true,
        quietHoursEnabled: false,
        quietHoursStart: '22:00',
        quietHoursEnd: '09:00',
        maxPerCustomerPerWeek: 10,
        rateLimitPerHour: 10,
        feedbackLink: 'https://flocafe.example.com/feedback',
        instagram: '@flotestcafe',
      },
      rules: [
        { id: 'after_payment', trigger: 'after_payment', enabled: true, templateId: 'receipt' },
        { id: 'points_threshold', trigger: 'points_threshold', enabled: true, templateId: 'loyalty_milestone', pointsThreshold: 100 },
        { id: 'nth_visit', trigger: 'nth_visit', enabled: true, templateId: 'feedback', nthVisit: 1, repeatEveryNth: true },
        { id: 'feedback_delay', trigger: 'feedback_delay', enabled: false, templateId: 'feedback', delayHours: 2 },
        { id: 'winback', trigger: 'winback', enabled: false, templateId: 'winback', inactiveDays: 14 },
      ],
    });

    const autoTriggerRes = await whatsapp.triggerBillPaidAutomation(901, { pointsEarned: 150 });
    assert(
      autoTriggerRes.triggered.includes('after_payment') &&
        autoTriggerRes.triggered.includes('points_threshold') &&
        autoTriggerRes.triggered.includes('nth_visit'),
      `bill payment automation fires after_payment, points_threshold, and nth_visit (got ${autoTriggerRes.triggered.join(',')})`,
    );

    const billMessages = whatsapp.listMessages({ phone: '+14089961010', limit: 20, offset: 0, canViewReports: true });
    const triggerRulesRecorded = billMessages.map((m: { trigger_rule: string | null }) => m.trigger_rule);
    assert(
      triggerRulesRecorded.includes('after_payment') &&
        triggerRulesRecorded.includes('points_threshold') &&
        triggerRulesRecorded.includes('nth_visit'),
      `listMessages returns trigger_rule attribution for automated sends (got ${triggerRulesRecorded.join(',')})`,
    );
    const receiptMsg = billMessages.find((m: { trigger_rule: string | null }) => m.trigger_rule === 'after_payment');
    assert(
      receiptMsg?.body.includes('Maya Lin') &&
        receiptMsg?.body.includes('INV-901') &&
        receiptMsg?.body.includes('2x Cappuccino'),
      'automated receipt message interpolates customer, bill number, and order items',
    );

    const broadcastRes = await whatsapp.runBroadcast({
      templateId: 'winback',
      minVisits: 1,
      limit: 5,
    });
    assert(
      broadcastRes.sent >= 1,
      `runBroadcast sends template to matching customer segment (sent=${broadcastRes.sent})`,
    );
    const afterBroadcastMessages = whatsapp.listMessages({ phone: '+14089961010', limit: 20, offset: 0, canViewReports: true });
    assert(
      afterBroadcastMessages.some((m: { trigger_rule: string | null }) => m.trigger_rule === 'broadcast'),
      'listMessages records trigger_rule=broadcast for segment broadcasts',
    );

    db.prepare(`
      INSERT INTO orders (id, order_number, type, status, customer_id, subtotal, tax_amount, discount_amount, total, created_at, updated_at)
      VALUES (902, 'ORD-902', 'dine_in', 'completed', 'cust-auto-1', 60, 0, 0, 60, datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (902, 'INV-902', 902, 'cust-auto-1', 60, 0, 0, 60, 60, 0, 'paid', '[{"method":"wallet","amount":50},{"method":"card","amount":10}]', datetime('now'), datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at)
      VALUES
        ('cust-auto-1', 902, 'debit', 100, 'Redeem on bill INV-902', datetime('now'), datetime('now')),
        ('cust-auto-1', 902, 'credit', 60, 'Cashback on bill INV-902', datetime('now'), datetime('now'))
    `).run();
    const secondBillTrigger = await whatsapp.triggerBillPaidAutomation(902, { pointsEarned: 60 });
    assert(
      !secondBillTrigger.triggered.includes('points_threshold'),
      'points_threshold does not re-fire within 7 days when customer redeems points but was already above threshold before the bill',
    );

    db.prepare(`
      INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES ('cust-split-2', 'Noah Patel', '+14089961011', 'US', 1, datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO orders (id, order_number, type, status, customer_id, subtotal, tax_amount, discount_amount, total, created_at, updated_at)
      VALUES (903, 'ORD-903', 'dine_in', 'completed', 'cust-auto-1', 35, 0, 0, 35, datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO order_items (id, order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status)
      VALUES
        (9031, 903, 'prod-split-1', 'Croissant', 2, 10, 20, 0, 20, 'delivered'),
        (9032, 903, 'prod-split-2', 'Matcha', 1, 15, 15, 0, 15, 'delivered')
    `).run();
    db.prepare(`
      INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, split_group_id, paid_at, created_at, updated_at)
      VALUES
        (903, 'INV-903A', 903, 'cust-auto-1', 10, 0, 0, 10, 10, 0, 'paid', 'grp-903', datetime('now'), datetime('now'), datetime('now')),
        (904, 'INV-903B', 903, 'cust-split-2', 25, 0, 0, 25, 25, 0, 'paid', 'grp-903', datetime('now'), datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO bill_items (bill_id, order_item_id, quantity)
      VALUES
        (903, 9031, 1),
        (904, 9031, 1),
        (904, 9032, 1)
    `).run();
    const splitContextA = whatsapp.buildWhatsAppTemplateContext({ billId: 903 });
    assert(
      splitContextA.order_items.includes('1x Croissant - $10.00') &&
        !splitContextA.order_items.includes('2x Croissant') &&
        !splitContextA.order_items.includes('Matcha'),
      `split bill template context scopes order_items to bill_items allocation (got "${splitContextA.order_items}")`,
    );
    assert(
      splitContextA.total_spent === '$120.00',
      `split bill customer total_spent excludes sibling bill assigned to another customer (got ${splitContextA.total_spent})`,
    );

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
    db.prepare(`
      INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES
        ('cust-sweep-blocked', 'Blocked User', '+15555550199', 'US', 1, ?, ?),
        ('cust-sweep-feedback', 'Feedback User', '+14089961021', 'US', 1, ?, ?),
        ('cust-sweep-winback', 'Winback User', '+14089961022', 'US', 1, ?, ?)
    `).run(twentyDaysAgo, twentyDaysAgo, threeHoursAgo, threeHoursAgo, twentyDaysAgo, twentyDaysAgo);
    db.prepare(`
      INSERT INTO orders (id, order_number, type, status, customer_id, subtotal, tax_amount, discount_amount, total, created_at, updated_at)
      VALUES
        (905, 'ORD-905', 'dine_in', 'completed', 'cust-sweep-blocked', 20, 0, 0, 20, ?, ?),
        (906, 'ORD-906', 'dine_in', 'completed', 'cust-sweep-feedback', 30, 0, 0, 30, ?, ?),
        (907, 'ORD-907', 'dine_in', 'completed', 'cust-sweep-winback', 40, 0, 0, 40, ?, ?)
    `).run(threeHoursAgo, threeHoursAgo, threeHoursAgo, threeHoursAgo, twentyDaysAgo, twentyDaysAgo);
    db.prepare(`
      INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
      VALUES
        (905, 'INV-905', 905, 'cust-sweep-blocked', 20, 0, 0, 20, 20, 0, 'paid', ?, ?, ?),
        (906, 'INV-906', 906, 'cust-sweep-feedback', 30, 0, 0, 30, 30, 0, 'paid', ?, ?, ?),
        (907, 'INV-907', 907, 'cust-sweep-winback', 40, 0, 0, 40, 40, 0, 'paid', ?, ?, ?)
    `).run(
      threeHoursAgo,
      threeHoursAgo,
      threeHoursAgo,
      threeHoursAgo,
      threeHoursAgo,
      threeHoursAgo,
      twentyDaysAgo,
      twentyDaysAgo,
      twentyDaysAgo,
    );
    whatsapp.saveAutomationConfig({
      safety: {
        autoOptOutEnabled: true,
        quietHoursEnabled: false,
        quietHoursStart: '22:00',
        quietHoursEnd: '09:00',
        maxPerCustomerPerWeek: 10,
        rateLimitPerHour: 10,
        feedbackLink: 'https://flocafe.example.com/feedback',
        instagram: '@flotestcafe',
      },
      rules: [
        { id: 'after_payment', trigger: 'after_payment', enabled: false, templateId: 'receipt' },
        { id: 'points_threshold', trigger: 'points_threshold', enabled: false, templateId: 'loyalty_milestone', pointsThreshold: 100 },
        { id: 'nth_visit', trigger: 'nth_visit', enabled: false, templateId: 'loyalty_milestone', nthVisit: 5, repeatEveryNth: true },
        { id: 'feedback_delay', trigger: 'feedback_delay', enabled: true, templateId: 'feedback', delayHours: 2 },
        { id: 'winback', trigger: 'winback', enabled: true, templateId: 'winback', inactiveDays: 14 },
      ],
    });
    const [sweep1, sweep2] = await Promise.all([
      whatsapp.runScheduledAutomationSweep(),
      whatsapp.runScheduledAutomationSweep(),
    ]);
    assert(
      sweep1.feedbackSent === 1 &&
        sweep1.winbackSent === 1 &&
        sweep2.feedbackSent === 1 &&
        sweep2.winbackSent === 1,
      `concurrent runScheduledAutomationSweep calls deduplicate in-flight work (got ${JSON.stringify(sweep1)})`,
    );
    const feedbackRecipientMsgs = whatsapp.listMessages({ phone: '+14089961021', limit: 10, offset: 0, canViewReports: true });
    assert(
      feedbackRecipientMsgs.length === 1 && feedbackRecipientMsgs[0]?.trigger_rule === 'feedback_delay',
      'scheduled sweep sends exactly one feedback_delay message to eligible customer',
    );

    whatsapp.disconnect();
    await whatsapp.enable('broadcast-disconnected-check');
    const disconnectedBroadcast = await whatsapp.runBroadcast({ templateId: 'winback', minVisits: 1 });
    assert(
      disconnectedBroadcast.ok === false && disconnectedBroadcast.reason === 'not_connected',
      `runBroadcast returns ok=false and reason=not_connected when disconnected (got ${JSON.stringify(disconnectedBroadcast)})`,
    );
    await whatsapp.connectWithQr();
    eventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));

    delete process.env.FLO_WHATSAPP_FAST_DELAY;
    holdPresence = true;

    const sendAbort = new AbortController();
    const sendPromise = whatsapp.sendMessage({
      phoneE164: '+15555550100',
      body: 'shutdown cancellation test',
      billId: null,
      customerId: null,
      kind: 'manual_reply',
      userId: null,
      signal: sendAbort.signal,
    });
    await presenceStartedPromise;
    const shutdownEntrypoints = createShutdownEntrypoints({
      app: { on: () => {}, quit: () => {}, exit: () => {} },
      process: { on: () => {}, exit: () => {} },
      cleanup: () => whatsapp.shutdown(),
      setQuitting: () => {},
      onShutdownRequested: whatsapp.requestShutdown,
      destroyWindow: () => {},
    });
    const shutdownPromise = shutdownEntrypoints.runCleanup();
    sendAbort.abort();
    let sendSettled = false;
    void sendPromise.then(() => { sendSettled = true; }, () => { sendSettled = true; });
    let shutdownSettled = false;
    void shutdownPromise.then(() => { shutdownSettled = true; }, () => { shutdownSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert(!sendSettled, 'shutdown joins the send wrapper until raw WhatsApp work settles');
    assert(!shutdownSettled, 'shutdown remains pending while underlying WhatsApp work is active');
    releasePendingPresence();
    const cancelled = await sendPromise;
    await shutdownPromise;
    const row = getDatabase().prepare(`
      SELECT status, error, failed_at FROM whatsapp_messages
      WHERE direction = 'outbound' AND body = ?
      ORDER BY id DESC LIMIT 1
    `).get('shutdown cancellation test') as { status: string; error: string; failed_at: string | null };
    assert(cancelled.ok === false && cancelled.reason === 'send_failed', 'shutdown-cancelled send returns send_failed');
    assert(row.status === 'failed', 'shutdown-cancelled send persists a failed status');
    assert(row.error === 'WhatsApp is shutting down.' && row.failed_at !== null, 'shutdown-cancelled send records its failure details');
    assert(presenceSettled, 'shutdown waits for the underlying WhatsApp operation to settle');
  } finally {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nAll WhatsApp service API assertions passed.');
  }
}

main().catch((err) => {
  (Module as any)._load = realLoad;
  console.error('Test crashed:', err);
  process.exit(1);
});
