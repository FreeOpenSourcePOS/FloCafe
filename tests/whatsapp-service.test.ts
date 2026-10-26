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
const presenceStartedPromise = new Promise<void>((resolve) => {
  presenceStarted = resolve;
});
let releasePendingPresence!: () => void;
const pendingPresence = new Promise<void>((resolve) => {
  releasePendingPresence = resolve;
});
let presenceSettled = false;
void pendingPresence.then(() => {
  presenceSettled = true;
});
let makeSocketCalls = 0;
let authStateCalls = 0;
let holdAuthState = false;
let authStateStarted!: () => void;
const authStateStartedPromise = new Promise<void>((resolve) => {
  authStateStarted = resolve;
});
let releaseAuthState!: () => void;
const authStateGate = new Promise<void>((resolve) => {
  releaseAuthState = resolve;
});
let holdRecoveryAuthState = false;
let recoveryAuthStateStarted!: () => void;
const recoveryAuthStateStartedPromise = new Promise<void>((resolve) => {
  recoveryAuthStateStarted = resolve;
});
let releaseRecoveryAuthState!: () => void;
const recoveryAuthStateGate = new Promise<void>((resolve) => {
  releaseRecoveryAuthState = resolve;
});
let holdRequestAuthState = false;
let requestAuthStateStarted!: () => void;
const requestAuthStateStartedPromise = new Promise<void>((resolve) => {
  requestAuthStateStarted = resolve;
});
let releaseRequestAuthState!: () => void;
const requestAuthStateGate = new Promise<void>((resolve) => {
  releaseRequestAuthState = resolve;
});
const baileysLogLines: string[] = [];
let holdCredentialWrite = false;
let credentialWriteStarted!: () => void;
const credentialWriteStartedPromise = new Promise<void>((resolve) => {
  credentialWriteStarted = resolve;
});
let releaseCredentialWrite!: () => void;
const credentialWriteGate = new Promise<void>((resolve) => {
  releaseCredentialWrite = resolve;
});
let holdPresence = false;
let sentMsgSeq = 0;
let saveCredsCalls = 0;
let rejectLogout = false;
let logoutCalls = 0;
let rejectPairingCode = false;
let holdPairingCode = false;
let pairingCodeStarted!: () => void;
const pairingCodeStartedPromise = new Promise<void>((resolve) => {
  pairingCodeStarted = resolve;
});
let releasePairingCode!: () => void;
const pairingCodeGate = new Promise<void>((resolve) => {
  releasePairingCode = resolve;
});
let rejectSendPresenceUpdate = false;
const fakeSocket: any = {
  ev: {
    on: (event: string, handler: (value: any) => void) => {
      eventHandlers.set(event, handler);
    },
  },
  onWhatsApp: async (jid: string) => [{ exists: true, jid }],
  presenceSubscribe: async () => {
    if (holdPresence) {
      presenceStarted();
      return pendingPresence;
    }
  },
  sendPresenceUpdate: async () => {
    if (rejectSendPresenceUpdate) {
      throw new Error('WebSocket closed after sleep');
    }
  },
  sendMessage: async () => ({ key: { id: `shutdown-test-message-${++sentMsgSeq}` } }),
  requestPairingCode: async () => {
    if (holdPairingCode) {
      pairingCodeStarted();
      await pairingCodeGate;
    }
    if (rejectPairingCode) {
      throw new Error('Pairing code rate limited');
    }
    return '12345678';
  },
  logout: async () => {
    logoutCalls++;
    if (rejectLogout) {
      throw new Error('Connection Closed');
    }
  },
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
        saveCredsCalls++;
        if (holdCredentialWrite) {
          credentialWriteStarted();
          await credentialWriteGate;
        }
      },
    };
  },
  makeWASocket: (options: any) => {
    makeSocketCalls++;
    options.logger.warn(
      { body: 'private bill body', phone: '+15555550100' },
      'Baileys warning for +15555550100',
    );
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
  assert(typeof whatsapp.cancelPairing === 'function', 'exports cancelPairing()');
  assert(typeof whatsapp.disconnect === 'function', 'exports disconnect()');
  assert(typeof whatsapp.shutdown === 'function', 'exports shutdown()');
  assert(typeof whatsapp.initFromDb === 'function', 'exports initFromDb()');
  assert(
    whatsapp.sanitizeLogText(
      new Error('recipient +1 555 555 0100 via https://wa.me/15555550100?text=private-bill'),
    ) === 'recipient [redacted-number] via [redacted-url]',
    'diagnostic sanitizer redacts formatted phone numbers and share URLs',
  );
  const jsonCredentialDiagnostics = [
    '{"password":"credential-value","token":"token-value"}',
    '{ "auth": "auth-value", "api_key": "api-key-value" }',
  ];
  for (const diagnostic of jsonCredentialDiagnostics) {
    const sanitized = whatsapp.sanitizeLogText(diagnostic) ?? '';
    assert(
      !sanitized.includes('credential-value') &&
        !sanitized.includes('token-value') &&
        !sanitized.includes('auth-value') &&
        !sanitized.includes('api-key-value') &&
        sanitized.includes('[redacted]'),
      'diagnostic sanitizer redacts JSON-style credential fields',
    );
  }
  for (const diagnostic of [
    'Authorization=Bearer secret-token',
    'Authorization: Bearer secret-token',
  ]) {
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
    [
      'disconnected',
      'connecting',
      'waiting_qr',
      'waiting_pairing',
      'connected',
      'cooldown',
    ].includes(s.state),
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
  assert(
    result.reason === 'feature_off',
    `sendMessage reason is 'feature_off' (got ${result.reason})`,
  );

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
    assert(
      makeSocketCalls === socketCallsBeforeRace + 1,
      'duplicate startup initialization creates one socket',
    );
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
    void credentialRecovery.then(
      () => {
        credentialRecoverySettled = true;
      },
      () => {
        credentialRecoverySettled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert(
      !credentialRecoverySettled,
      'startup waits for asynchronous credential persistence before reopening auth',
    );
    releaseCredentialWrite();
    holdCredentialWrite = false;
    await credentialRecovery;
    assert(
      authStateCalls === authStateCallsBeforeCredentialRecovery + 1,
      'credential cleanup completes before the replacement startup',
    );

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
    assert(
      whatsapp.getStatus().lastErrorReason === null,
      'intentional startup cancellation does not report a failure',
    );
    await whatsapp.enable('startup-recovery-test-user');
    const restartedStartup = whatsapp.connectWithQr();
    const restartedResult = await restartedStartup;
    assert(restartedResult.ok === true, 're-enable starts a fresh socket after cancellation');
    assert(
      makeSocketCalls === socketCallsBeforeRecovery + 1,
      'cancelled startup does not create a duplicate socket',
    );
    assert(
      authStateCalls === authStateCallsBeforeRecovery + 2,
      're-enable waits for the cancelled startup before retrying',
    );

    holdRequestAuthState = true;
    const authStateCallsBeforeRequestCancellation = authStateCalls;
    whatsapp.disconnect();
    await whatsapp.enable('request-cancellation-test-user');
    const requestAbort = new AbortController();
    const cancelledRequest = whatsapp.connectWithQr(requestAbort.signal).then(
      () => 'resolved',
      () => 'rejected',
    );
    await requestAuthStateStartedPromise;
    requestAbort.abort();
    const retriedRequest = whatsapp.connectWithQr();
    releaseRequestAuthState();
    holdRequestAuthState = false;
    const [cancelledRequestResult, retriedRequestResult] = await Promise.all([
      cancelledRequest,
      retriedRequest,
    ]);
    assert(cancelledRequestResult === 'rejected', 'aborted connect request is rejected');
    assert(retriedRequestResult.ok === true, 'retry joins request-independent startup');
    assert(
      authStateCalls === authStateCallsBeforeRequestCancellation + 1,
      'request cancellation does not restart shared auth loading',
    );

    // Connect the socket and run automation & safety tests
    eventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));
    process.env.FLO_WHATSAPP_FAST_DELAY = '1';
    const db = getDatabase();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'US'), ('currency', 'USD'), ('timezone', 'UTC'), ('business_name', 'Flo Test Cafe'), ('instagram_handle', '@flotestcafe')",
    ).run();

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
        interpolated.includes(
          'Store: Flo Bistro +919800000000 https://flocafe.example.com/review @flobistro',
        ),
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
    assert(
      whatsapp.isCurrentlyQuietHours(
        {
          autoOptOutEnabled: true,
          quietHoursEnabled: true,
          quietHoursStart: '22:00',
          quietHoursEnd: '09:00',
          maxPerCustomerPerWeek: 2,
          feedbackLink: '',
        },
        new Date('2026-06-15T23:30:00.000Z'),
      ) === true &&
        whatsapp.isCurrentlyQuietHours(
          {
            autoOptOutEnabled: true,
            quietHoursEnabled: true,
            quietHoursStart: '22:00',
            quietHoursEnd: '09:00',
            maxPerCustomerPerWeek: 2,
            feedbackLink: '',
          },
          new Date('2026-06-15T14:00:00.000Z'),
        ) === false,
      'isCurrentlyQuietHours evaluates deterministic timestamps in store timezone',
    );
    whatsapp.saveAutomationConfig({
      safety: {
        autoOptOutEnabled: true,
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '09:00',
        maxPerCustomerPerWeek: 2,
        feedbackLink: 'https://flocafe.example.com/feedback',
      },
    });
    const RealDate = globalThis.Date;
    const fixedQuietMs = new RealDate('2026-06-15T23:30:00.000Z').getTime();
    class MockQuietDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          super(fixedQuietMs);
        } else {
          // @ts-expect-error spread into Date constructor
          super(...args);
        }
      }
      static override now(): number {
        return fixedQuietMs;
      }
    }
    globalThis.Date = MockQuietDate as DateConstructor;
    let blockedByQuietHours!: { ok: boolean; reason?: string };
    let manualDuringQuietHours!: { ok: boolean; reason?: string };
    try {
      blockedByQuietHours = await whatsapp.sendMessage({
        phoneE164: '+15555550120',
        body: 'Auto follow-up during quiet hours',
        billId: null,
        customerId: null,
        kind: 'auto_followup',
        userId: 'rule:feedback_delay',
      });
      manualDuringQuietHours = await whatsapp.sendMessage({
        phoneE164: '+15555550120',
        body: 'Manual reply during quiet hours',
        billId: null,
        customerId: null,
        kind: 'manual_reply',
        userId: 'staff-1',
      });
    } finally {
      globalThis.Date = RealDate;
    }
    assert(
      blockedByQuietHours.ok === false && blockedByQuietHours.reason === 'quiet_hours',
      'quiet hours block automated follow-up sends',
    );
    assert(manualDuringQuietHours.ok === true, 'quiet hours still allow manual staff replies');

    // Disable quiet hours and verify weekly cap (maxPerCustomerPerWeek = 2)
    whatsapp.saveAutomationConfig({
      safety: {
        autoOptOutEnabled: true,
        quietHoursEnabled: false,
        quietHoursStart: '22:00',
        quietHoursEnd: '09:00',
        maxPerCustomerPerWeek: 2,
        feedbackLink: 'https://flocafe.example.com/feedback',
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
    assert(
      autoSend1.ok === true && autoSend2.ok === true,
      'automated sends under weekly cap succeed',
    );
    assert(
      autoSend3.ok === false && autoSend3.reason === 'weekly_cap',
      'weekly per-customer cap blocks automated sends once reached',
    );
    assert(manualAfterCap.ok === true, 'weekly per-customer cap still allows manual staff replies');

    // 4. Automated rules on bill payment completion (after_payment, points_threshold, nth_visit) + trigger_rule in listMessages
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
        feedbackLink: 'https://flocafe.example.com/feedback',
      },
      rules: [
        { id: 'after_payment', trigger: 'after_payment', enabled: true, templateId: 'receipt' },
        {
          id: 'points_threshold',
          trigger: 'points_threshold',
          enabled: true,
          templateId: 'loyalty_milestone',
          pointsThreshold: 100,
        },
        {
          id: 'nth_visit',
          trigger: 'nth_visit',
          enabled: true,
          templateId: 'visit_milestone',
          nthVisit: 1,
        },
        {
          id: 'feedback_delay',
          trigger: 'feedback_delay',
          enabled: false,
          templateId: 'feedback',
          delayHours: 2,
        },
        {
          id: 'winback',
          trigger: 'winback',
          enabled: false,
          templateId: 'winback',
          inactiveDays: 14,
        },
      ],
    });

    const autoTriggerRes = await whatsapp.triggerBillPaidAutomation(901, { pointsEarned: 150 });
    assert(
      autoTriggerRes.triggered.includes('after_payment') &&
        autoTriggerRes.triggered.includes('points_threshold') &&
        autoTriggerRes.triggered.includes('nth_visit'),
      `bill payment automation fires after_payment, points_threshold, and nth_visit (got ${autoTriggerRes.triggered.join(',')})`,
    );

    const billMessages = whatsapp.listMessages({
      phone: '+14089961010',
      limit: 20,
      offset: 0,
      canViewReports: true,
    });
    const triggerRulesRecorded = billMessages.map(
      (m: { trigger_rule: string | null }) => m.trigger_rule,
    );
    assert(
      triggerRulesRecorded.includes('after_payment') &&
        triggerRulesRecorded.includes('points_threshold') &&
        triggerRulesRecorded.includes('nth_visit'),
      `listMessages returns trigger_rule attribution for automated sends (got ${triggerRulesRecorded.join(',')})`,
    );
    const receiptMsg = billMessages.find(
      (m: { trigger_rule: string | null }) => m.trigger_rule === 'after_payment',
    );
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
    const afterBroadcastMessages = whatsapp.listMessages({
      phone: '+14089961010',
      limit: 20,
      offset: 0,
      canViewReports: true,
    });
    assert(
      afterBroadcastMessages.some(
        (m: { trigger_rule: string | null }) => m.trigger_rule === 'broadcast',
      ),
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
    `).run(
      twentyDaysAgo,
      twentyDaysAgo,
      threeHoursAgo,
      threeHoursAgo,
      twentyDaysAgo,
      twentyDaysAgo,
    );
    db.prepare(`
      INSERT INTO orders (id, order_number, type, status, customer_id, subtotal, tax_amount, discount_amount, total, created_at, updated_at)
      VALUES
        (905, 'ORD-905', 'dine_in', 'completed', 'cust-sweep-blocked', 20, 0, 0, 20, ?, ?),
        (906, 'ORD-906', 'dine_in', 'completed', 'cust-sweep-feedback', 30, 0, 0, 30, ?, ?),
        (907, 'ORD-907', 'dine_in', 'completed', 'cust-sweep-winback', 40, 0, 0, 40, ?, ?)
    `).run(
      threeHoursAgo,
      threeHoursAgo,
      threeHoursAgo,
      threeHoursAgo,
      twentyDaysAgo,
      twentyDaysAgo,
    );
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
        feedbackLink: 'https://flocafe.example.com/feedback',
      },
      rules: [
        { id: 'after_payment', trigger: 'after_payment', enabled: false, templateId: 'receipt' },
        {
          id: 'points_threshold',
          trigger: 'points_threshold',
          enabled: false,
          templateId: 'loyalty_milestone',
          pointsThreshold: 100,
        },
        {
          id: 'nth_visit',
          trigger: 'nth_visit',
          enabled: false,
          templateId: 'visit_milestone',
          nthVisit: 5,
        },
        {
          id: 'feedback_delay',
          trigger: 'feedback_delay',
          enabled: true,
          templateId: 'feedback',
          delayHours: 2,
        },
        {
          id: 'winback',
          trigger: 'winback',
          enabled: true,
          templateId: 'winback',
          inactiveDays: 14,
        },
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
    const feedbackRecipientMsgs = whatsapp.listMessages({
      phone: '+14089961021',
      limit: 10,
      offset: 0,
      canViewReports: true,
    });
    assert(
      feedbackRecipientMsgs.length === 1 &&
        feedbackRecipientMsgs[0]?.trigger_rule === 'feedback_delay',
      'scheduled sweep sends exactly one feedback_delay message to eligible customer',
    );

    // 5. Regression tests for review findings:
    // 5a. Fractional loyalty points are preserved (99.5 does not round to 100 or prematurely trigger threshold=100)
    db.prepare(`
      INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES ('cust-frac-1', 'Frac User', '+14089961030', 'US', 1, datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO orders (id, order_number, type, status, customer_id, subtotal, tax_amount, discount_amount, total, created_at, updated_at)
      VALUES (910, 'ORD-910', 'dine_in', 'completed', 'cust-frac-1', 20, 0, 0, 20, datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
      VALUES (910, 'INV-910', 910, 'cust-frac-1', 20, 0, 0, 20, 20, 0, 'paid', datetime('now'), datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at)
      VALUES ('cust-frac-1', 910, 'credit', 99.5, 'Fractional cashback', datetime('now'), datetime('now'))
    `).run();
    const fracContext = whatsapp.buildWhatsAppTemplateContext({ billId: 910 });
    assert(
      fracContext.points_balance === 99.5 && fracContext.points_value === '$99.50',
      `fractional loyalty balance is preserved without integer rounding (got ${fracContext.points_balance} / ${fracContext.points_value})`,
    );
    whatsapp.saveAutomationConfig({
      rules: [
        { id: 'after_payment', trigger: 'after_payment', enabled: false, templateId: 'receipt' },
        {
          id: 'points_threshold',
          trigger: 'points_threshold',
          enabled: true,
          templateId: 'loyalty_milestone',
          pointsThreshold: 100,
        },
        {
          id: 'nth_visit',
          trigger: 'nth_visit',
          enabled: true,
          templateId: 'visit_milestone',
          nthVisit: 1,
        },
        {
          id: 'feedback_delay',
          trigger: 'feedback_delay',
          enabled: false,
          templateId: 'feedback',
          delayHours: 2,
        },
        {
          id: 'winback',
          trigger: 'winback',
          enabled: false,
          templateId: 'winback',
          inactiveDays: 14,
        },
      ],
    });
    const fracTrigger = await whatsapp.triggerBillPaidAutomation(910, { pointsEarned: 99.5 });
    assert(
      !fracTrigger.triggered.includes('points_threshold') &&
        fracTrigger.triggered.includes('nth_visit'),
      '99.5 loyalty points does not prematurely trigger points_threshold=100 while first split check triggers nth_visit',
    );

    // 5b. Split checks on the same order do not repeat nth_visit milestone for the same customer
    db.prepare(`
      INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, split_group_id, paid_at, created_at, updated_at)
      VALUES (911, 'INV-910B', 910, 'cust-frac-1', 15, 0, 0, 15, 15, 0, 'paid', 'grp-910', datetime('now'), datetime('now'), datetime('now'))
    `).run();
    const splitSiblingTrigger = await whatsapp.triggerBillPaidAutomation(911);
    assert(
      !splitSiblingTrigger.triggered.includes('nth_visit'),
      'paying a second split bill on the same order does not repeat nth_visit milestone',
    );

    // 5c. 168-hour (7-day) feedback delay window, failed feedback retry, and skipping 25 rejected recipients
    const sevenDaysPlusTwoHoursAgo = new Date(Date.now() - 170 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
    db.prepare(`
      INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES ('cust-168h', 'Seven Day User', '+14089961031', 'US', 1, ?, ?)
    `).run(sevenDaysPlusTwoHoursAgo, sevenDaysPlusTwoHoursAgo);
    db.prepare(`
      INSERT INTO orders (id, order_number, type, status, customer_id, subtotal, tax_amount, discount_amount, total, created_at, updated_at)
      VALUES (912, 'ORD-912', 'dine_in', 'completed', 'cust-168h', 25, 0, 0, 25, ?, ?)
    `).run(sevenDaysPlusTwoHoursAgo, sevenDaysPlusTwoHoursAgo);
    db.prepare(`
      INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
      VALUES (912, 'INV-912', 912, 'cust-168h', 25, 0, 0, 25, 25, 0, 'paid', ?, ?, ?)
    `).run(sevenDaysPlusTwoHoursAgo, sevenDaysPlusTwoHoursAgo, sevenDaysPlusTwoHoursAgo);
    // Insert a failed feedback_delay row for bill 912 to verify failed feedback is retried
    db.prepare(`
      INSERT INTO whatsapp_messages (bill_id, customer_id, phone_e164, direction, kind, status, body, error, queued_at, failed_at, created_by_user_id)
      VALUES (912, 'cust-168h', '+14089961031', 'outbound', 'auto_followup', 'failed', 'Failed attempt', 'Transient socket error', ?, ?, 'rule:feedback_delay')
    `).run(sevenDaysPlusTwoHoursAgo, sevenDaysPlusTwoHoursAgo);
    // Insert 25 newer bills whose numbers are not on WhatsApp so they get rejected before recordMessageRow
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
    for (let i = 1; i <= 25; i++) {
      const cid = `cust-unreg-${i}`;
      const bid = 920 + i;
      const phone = `+14089962${String(i).padStart(3, '0')}`;
      db.prepare(`
        INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 'US', 1, ?, ?)
      `).run(cid, `Unreg ${i}`, phone, oneHourAgo, oneHourAgo);
      db.prepare(`
        INSERT INTO orders (id, order_number, type, status, customer_id, subtotal, tax_amount, discount_amount, total, created_at, updated_at)
        VALUES (?, ?, 'dine_in', 'completed', ?, 10, 0, 0, 10, ?, ?)
      `).run(bid, `ORD-${bid}`, cid, oneHourAgo, oneHourAgo);
      db.prepare(`
        INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 10, 0, 0, 10, 10, 0, 'paid', ?, ?, ?)
      `).run(
        bid,
        `INV-${bid}`,
        bid,
        cid,
        sevenDaysPlusTwoHoursAgo,
        sevenDaysPlusTwoHoursAgo,
        sevenDaysPlusTwoHoursAgo,
      );
    }
    const origOnWhatsApp = fakeSocket.onWhatsApp;
    fakeSocket.onWhatsApp = async (jid: string) => {
      if (jid.startsWith('14089962')) return [{ exists: false, jid }];
      return [{ exists: true, jid }];
    };
    try {
      whatsapp.saveAutomationConfig({
        rules: [
          { id: 'after_payment', trigger: 'after_payment', enabled: false, templateId: 'receipt' },
          {
            id: 'points_threshold',
            trigger: 'points_threshold',
            enabled: false,
            templateId: 'loyalty_milestone',
            pointsThreshold: 100,
          },
          {
            id: 'nth_visit',
            trigger: 'nth_visit',
            enabled: false,
            templateId: 'visit_milestone',
            nthVisit: 5,
          },
          {
            id: 'feedback_delay',
            trigger: 'feedback_delay',
            enabled: true,
            templateId: 'feedback',
            delayHours: 168,
          },
          {
            id: 'winback',
            trigger: 'winback',
            enabled: false,
            templateId: 'winback',
            inactiveDays: 14,
          },
        ],
      });
      const sweep168 = await whatsapp.runScheduledAutomationSweep();
      assert(
        sweep168.feedbackSent === 1,
        `168h feedback_delay window retries failed row and continues past 25 rejected recipients (got feedbackSent=${sweep168.feedbackSent})`,
      );
    } finally {
      fakeSocket.onWhatsApp = origOnWhatsApp;
    }

    // 5d. Mid-send opt-out recheck cancels active send before socket.sendMessage
    const origSendPresenceUpdate = fakeSocket.sendPresenceUpdate;
    fakeSocket.sendPresenceUpdate = async (stateUpdate?: string) => {
      if (stateUpdate === 'paused') {
        whatsapp.addToBlocklist('+14089961035', 'Auto opt-out: STOP', 'system:auto_opt_out');
      }
    };
    try {
      const midSendOptOutRes = await whatsapp.sendMessage({
        phoneE164: '+14089961035',
        body: 'Message cancelled by mid-send STOP',
        billId: null,
        customerId: null,
        kind: 'manual_reply',
        userId: 'staff-1',
      });
      assert(
        midSendOptOutRes.ok === false && midSendOptOutRes.reason === 'blocked',
        `mid-send opt-out cancels active send with reason=blocked (got ${JSON.stringify(midSendOptOutRes)})`,
      );
    } finally {
      fakeSocket.sendPresenceUpdate = origSendPresenceUpdate;
    }

    // 5e. Regional defaults resolve from country profile when currency/timezone settings are empty
    db.prepare("DELETE FROM settings WHERE key IN ('currency', 'timezone')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'IN')").run();
    const inContext = whatsapp.buildWhatsAppTemplateContext({ billId: 910 });
    assert(
      inContext.total.includes('₹'),
      `buildWhatsAppTemplateContext uses resolveRegionalSnapshot currency for country=IN when currency setting is unset (got ${inContext.total})`,
    );
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'US'), ('currency', 'USD'), ('timezone', 'UTC')",
    ).run();

    // 5f. roundLoyaltyAmount and buildWhatsAppTemplateContext honor 3-decimal (KWD) and 0-decimal (JPY) currencies
    {
      assert(
        whatsapp.roundLoyaltyAmount(12.3456, 3) === 12.346,
        `roundLoyaltyAmount rounds to 3 decimal places when fractionDigits=3 (got ${whatsapp.roundLoyaltyAmount(12.3456, 3)})`,
      );
      assert(
        whatsapp.roundLoyaltyAmount(12.6, 0) === 13,
        `roundLoyaltyAmount rounds to 0 decimal places when fractionDigits=0 (got ${whatsapp.roundLoyaltyAmount(12.6, 0)})`,
      );
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'KW'), ('currency', 'KWD')",
      ).run();
      const kwdContext = whatsapp.buildWhatsAppTemplateContext({
        billId: 910,
        customerId: 'cust-auto-1',
        pointsEarned: 1.235,
      });
      assert(
        kwdContext.points_earned === 1.235,
        `buildWhatsAppTemplateContext preserves 3-decimal points_earned for KWD (got ${kwdContext.points_earned})`,
      );
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'JP'), ('currency', 'JPY')",
      ).run();
      const jpyContext = whatsapp.buildWhatsAppTemplateContext({
        billId: 910,
        customerId: 'cust-auto-1',
        pointsEarned: 12.6,
      });
      assert(
        jpyContext.points_earned === 13,
        `buildWhatsAppTemplateContext rounds points_earned to 0 decimals for JPY (got ${jpyContext.points_earned})`,
      );
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'US'), ('currency', 'USD'), ('timezone', 'UTC')",
      ).run();
    }

    // 5g. Concurrent split-bill triggerBillPaidAutomation deduplicates nth_visit while onWhatsApp is in flight
    {
      db.prepare(`
        INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
        VALUES ('cust-split-nth', 'Split Milestone Guest', '+14089961099', 'US', 1, datetime('now'), datetime('now'))
      `).run();
      db.prepare(`
        INSERT INTO orders (id, order_number, type, status, customer_id, subtotal, tax_amount, discount_amount, total, created_at, updated_at)
        VALUES (9901, 'ORD-9901', 'dine_in', 'pending', 'cust-split-nth', 100, 0, 0, 100, datetime('now'), datetime('now'))
      `).run();
      const insertSplitBill = db.prepare(`
        INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, split_group_id, paid_at, created_at, updated_at)
        VALUES (?, ?, 9901, 'cust-split-nth', 50, 0, 0, 50, 50, 0, 'paid', 'split-9901', datetime('now'), datetime('now'), datetime('now'))
      `);
      insertSplitBill.run(9901, 'BILL-9901');
      whatsapp.saveAutomationConfig({
        safety: { quietHoursEnabled: false, maxPerCustomerPerWeek: 10 },
        rules: [
          { id: 'after_payment', trigger: 'after_payment', enabled: false, templateId: 'receipt' },
          {
            id: 'points_threshold',
            trigger: 'points_threshold',
            enabled: false,
            templateId: 'loyalty_milestone',
            pointsThreshold: 100,
          },
          {
            id: 'nth_visit',
            trigger: 'nth_visit',
            enabled: true,
            templateId: 'visit_milestone',
            nthVisit: 1,
          },
        ],
      });
      const prevOnWhatsApp = fakeSocket.onWhatsApp;
      let releaseNthLookup!: () => void;
      let nthLookupReached!: () => void;
      const nthLookupGate = new Promise<void>((resolve) => {
        releaseNthLookup = resolve;
      });
      const nthLookupStarted = new Promise<void>((resolve) => {
        nthLookupReached = resolve;
      });
      let holdNthLookup = true;
      fakeSocket.onWhatsApp = async (jid: string) => {
        if (holdNthLookup) {
          holdNthLookup = false;
          nthLookupReached();
          await nthLookupGate;
        }
        return [{ exists: true, jid }];
      };
      try {
        const firstSplitAuto = whatsapp.triggerBillPaidAutomation(9901);
        await nthLookupStarted;
        insertSplitBill.run(9902, 'BILL-9902');
        const secondSplitAuto = whatsapp.triggerBillPaidAutomation(9902);
        releaseNthLookup();
        const [res1, res2] = await Promise.all([firstSplitAuto, secondSplitAuto]);
        const nthRows = db
          .prepare(
            "SELECT bill_id, status FROM whatsapp_messages WHERE customer_id = 'cust-split-nth' AND created_by_user_id = 'rule:nth_visit'",
          )
          .all() as Array<{ bill_id: number; status: string }>;
        assert(
          nthRows.length === 1,
          `concurrent split-bill automation records exactly 1 nth_visit message for the order (got ${nthRows.length})`,
        );
        assert(
          res1.triggered.includes('nth_visit') && !res2.triggered.includes('nth_visit'),
          `only the first concurrent split bill triggers nth_visit (got ${JSON.stringify([res1.triggered, res2.triggered])})`,
        );
      } finally {
        fakeSocket.onWhatsApp = prevOnWhatsApp;
      }
    }

    // 5h. Offline mode aborts in-flight version lookup and blocks Baileys fallback version fetch
    {
      whatsapp.disconnect();
      await whatsapp.enable('offline-version-abort-check');
      let releaseVersionFetch!: () => void;
      let versionFetchReached!: () => void;
      const versionFetchGate = new Promise<void>((resolve) => {
        releaseVersionFetch = resolve;
      });
      const versionFetchStarted = new Promise<void>((resolve) => {
        versionFetchReached = resolve;
      });
      let capturedVersionSignal: AbortSignal | undefined;
      let fallbackVersionCalls = 0;
      const prevFetch = globalThis.fetch;
      const prevFetchLatest = fakeBaileys.fetchLatestWaWebVersion;
      const { notifyOfflineModeEnabled } = require('../main/services/offline-mode');
      globalThis.fetch = (async (_url: any, init?: RequestInit) => {
        capturedVersionSignal = init?.signal ?? undefined;
        versionFetchReached();
        await versionFetchGate;
        return { ok: false } as any;
      }) as typeof fetch;
      fakeBaileys.fetchLatestWaWebVersion = async () => {
        fallbackVersionCalls++;
        return { version: [2, 3000, 1] };
      };
      try {
        const connectDuringOffline = whatsapp.connectWithQr();
        await versionFetchStarted;
        const fallbackBeforeOffline = fallbackVersionCalls;
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('offline_mode', 'true')",
        ).run();
        whatsapp.suspendForOfflineMode();
        notifyOfflineModeEnabled();
        const abortedAtOffline = Boolean(capturedVersionSignal?.aborted);
        releaseVersionFetch();
        const offlineConnectRes = await connectDuringOffline;
        assert(
          abortedAtOffline === true,
          'enabling Offline mode aborts the in-flight WhatsApp version lookup signal immediately',
        );
        assert(
          fallbackVersionCalls - fallbackBeforeOffline === 0,
          `Offline mode blocks Baileys fallback version lookup after abort (got ${fallbackVersionCalls - fallbackBeforeOffline} calls)`,
        );
        assert(
          offlineConnectRes.ok === false && whatsapp.getStatus().state === 'disconnected',
          `connectWithQr aborted by Offline mode resolves disconnected (got ${JSON.stringify(offlineConnectRes)}, state=${whatsapp.getStatus().state})`,
        );
      } finally {
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('offline_mode', 'false')",
        ).run();
        globalThis.fetch = prevFetch;
        fakeBaileys.fetchLatestWaWebVersion = prevFetchLatest;
      }
    }

    // 5i. Issue #1344: ACK timeout sweep, startup sweep, late ACK promotion from failed, and idempotent retry
    {
      whatsapp.disconnect();
      await whatsapp.enable('ack-timeout-test');
      await whatsapp.connectWithQr();
      eventHandlers.get('connection.update')?.({ connection: 'open' });
      await new Promise((resolve) => setImmediate(resolve));

      assert(
        whatsapp.ACK_TIMEOUT_MS === 5 * 60 * 1000,
        `ACK_TIMEOUT_MS is 5 minutes (got ${whatsapp.ACK_TIMEOUT_MS})`,
      );

      let extSeq = 0;
      const prevSendMessage = fakeSocket.sendMessage;
      fakeSocket.sendMessage = async () => ({
        key: { id: `ack-timeout-ext-${++extSeq}` },
        message: { conversation: 'test' },
      });

      try {
        // 1. Send a message that receives no server ACK -> stays 'typing' until ACK_TIMEOUT_MS
        const sentNoAck = await whatsapp.sendMessage({
          phoneE164: '+12133734253',
          body: 'Receipt #1344 awaiting ACK',
          billId: null,
          customerId: null,
          kind: 'bill_receipt',
          userId: 'user-1344',
        });
        assert(
          sentNoAck.ok === true && typeof sentNoAck.messageId === 'number',
          `sendMessage succeeds before ACK (got ${JSON.stringify(sentNoAck)})`,
        );
        const msgId1 = sentNoAck.messageId!;
        const beforeSweep = db
          .prepare(
            'SELECT status, error, external_message_id, typing_at, failed_at FROM whatsapp_messages WHERE id = ?',
          )
          .get(msgId1) as {
          status: string;
          error: string | null;
          external_message_id: string | null;
          typing_at: string | null;
          failed_at: string | null;
        };
        assert(
          beforeSweep.status === 'typing' &&
            beforeSweep.external_message_id === 'ack-timeout-ext-1' &&
            beforeSweep.error === null,
          `message starts in typing waiting for ACK (got ${JSON.stringify(beforeSweep)})`,
        );

        // Sweep before timeout does not mark fresh typing row failed
        const earlySwept = whatsapp.sweepAckTimeouts(Date.now() + 60 * 1000);
        const afterEarlySweep = db
          .prepare('SELECT status, error FROM whatsapp_messages WHERE id = ?')
          .get(msgId1) as { status: string; error: string | null };
        assert(
          earlySwept === 0 && afterEarlySweep.status === 'typing',
          `fresh typing message is not swept before ACK_TIMEOUT_MS (got swept=${earlySwept}, status=${afterEarlySweep.status})`,
        );

        // Sweep after ACK_TIMEOUT_MS marks the row failed with error='ack_timeout'
        const sweptCount = whatsapp.sweepAckTimeouts(Date.now() + whatsapp.ACK_TIMEOUT_MS + 5_000);
        const afterTimeoutSweep = db
          .prepare(
            'SELECT status, error, failed_at, external_message_id FROM whatsapp_messages WHERE id = ?',
          )
          .get(msgId1) as {
          status: string;
          error: string | null;
          failed_at: string | null;
          external_message_id: string | null;
        };
        assert(
          sweptCount >= 1 &&
            afterTimeoutSweep.status === 'failed' &&
            afterTimeoutSweep.error === 'ack_timeout' &&
            afterTimeoutSweep.failed_at !== null &&
            afterTimeoutSweep.external_message_id === 'ack-timeout-ext-1',
          `stale typing message becomes failed (ack_timeout) after timeout while preserving external_message_id (got ${JSON.stringify(afterTimeoutSweep)})`,
        );

        // 2. Late ACK for a message already marked failed (ack_timeout) promotes it to sent/delivered and clears error/failed_at
        eventHandlers.get('messages.update')?.([
          { key: { id: 'ack-timeout-ext-1' }, update: { status: 2 } },
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        const afterLateSent = db
          .prepare(
            'SELECT status, error, failed_at, sent_at, delivered_at FROM whatsapp_messages WHERE id = ?',
          )
          .get(msgId1) as {
          status: string;
          error: string | null;
          failed_at: string | null;
          sent_at: string | null;
          delivered_at: string | null;
        };
        assert(
          afterLateSent.status === 'sent' &&
            afterLateSent.error === null &&
            afterLateSent.failed_at === null &&
            afterLateSent.sent_at !== null,
          `late SERVER_ACK (status=2) promotes failed (ack_timeout) message to sent and clears error/failed_at (got ${JSON.stringify(afterLateSent)})`,
        );

        // Mark failed again to test direct promotion from failed -> delivered (status=3) and out-of-order status=2 non-regression
        db.prepare(
          "UPDATE whatsapp_messages SET status = 'failed', error = 'ack_timeout', failed_at = datetime('now'), sent_at = NULL, delivered_at = NULL WHERE id = ?",
        ).run(msgId1);
        eventHandlers.get('messages.update')?.([
          { key: { id: 'ack-timeout-ext-1' }, update: { status: 3 } },
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        const afterLateDelivered = db
          .prepare(
            'SELECT status, error, failed_at, sent_at, delivered_at FROM whatsapp_messages WHERE id = ?',
          )
          .get(msgId1) as {
          status: string;
          error: string | null;
          failed_at: string | null;
          sent_at: string | null;
          delivered_at: string | null;
        };
        assert(
          afterLateDelivered.status === 'delivered' &&
            afterLateDelivered.error === null &&
            afterLateDelivered.failed_at === null &&
            afterLateDelivered.sent_at !== null &&
            afterLateDelivered.delivered_at !== null,
          `late delivered ACK (status=3) promotes failed message to delivered and backfills sent_at (got ${JSON.stringify(afterLateDelivered)})`,
        );

        eventHandlers.get('messages.update')?.([
          { key: { id: 'ack-timeout-ext-1' }, update: { status: 2 } },
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        const afterOutOfOrderSent = db
          .prepare('SELECT status FROM whatsapp_messages WHERE id = ?')
          .get(msgId1) as { status: string };
        assert(
          afterOutOfOrderSent.status === 'delivered',
          `out-of-order status=2 does not regress delivered back to sent (got ${afterOutOfOrderSent.status})`,
        );

        // 3. Startup sweep: rows stuck in queued/typing from before a restart are swept on initFromDb()
        whatsapp.disconnect();
        const staleQueuedInsert = db
          .prepare(`
            INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body, queued_at)
            VALUES ('+12133734253', 'outbound', 'bill_receipt', 'queued', 'Stuck queued before restart', datetime('now', '-10 minutes'))
          `)
          .run();
        const staleTypingInsert = db
          .prepare(`
            INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body, queued_at, typing_at)
            VALUES ('+12133734253', 'outbound', 'manual_reply', 'typing', 'Stuck typing before restart', datetime('now', '-1 minutes'), datetime('now', '-1 minutes'))
          `)
          .run();
        const staleQueuedId = Number(staleQueuedInsert.lastInsertRowid);
        const staleTypingId = Number(staleTypingInsert.lastInsertRowid);

        whatsapp.initFromDb();
        const sweptQueued = db
          .prepare('SELECT status, error, failed_at FROM whatsapp_messages WHERE id = ?')
          .get(staleQueuedId) as { status: string; error: string | null; failed_at: string | null };
        const sweptTyping = db
          .prepare('SELECT status, error, failed_at FROM whatsapp_messages WHERE id = ?')
          .get(staleTypingId) as { status: string; error: string | null; failed_at: string | null };
        assert(
          sweptQueued.status === 'failed' &&
            sweptQueued.error === 'ack_timeout' &&
            sweptQueued.failed_at !== null,
          `startup initFromDb sweeps pre-restart queued row to failed/ack_timeout (got ${JSON.stringify(sweptQueued)})`,
        );
        assert(
          sweptTyping.status === 'failed' &&
            sweptTyping.error === 'ack_timeout' &&
            sweptTyping.failed_at !== null,
          `startup initFromDb sweeps pre-restart typing row to failed/ack_timeout (got ${JSON.stringify(sweptTyping)})`,
        );

        // 4. Retry: blocked in Offline mode, honours #1315 safety controls, and sends once in-place without duplicates
        await whatsapp.enable('retry-test');
        await whatsapp.connectWithQr();
        eventHandlers.get('connection.update')?.({ connection: 'open' });
        await new Promise((resolve) => setImmediate(resolve));

        // 4a. Retry is blocked in Offline mode
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('offline_mode', 'true')",
        ).run();
        const offlineRetry = await whatsapp.retryMessage(staleQueuedId);
        const offlineSend = await whatsapp.sendMessage({
          phoneE164: '+12133734253',
          body: 'Should not send in offline mode',
          billId: null,
          customerId: null,
          kind: 'manual_reply',
          userId: null,
        });
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('offline_mode', 'false')",
        ).run();
        assert(
          offlineRetry.ok === false && offlineRetry.reason === 'offline_mode',
          `retryMessage is blocked in Offline mode with reason=offline_mode (got ${JSON.stringify(offlineRetry)})`,
        );
        assert(
          offlineSend.ok === false && offlineSend.reason === 'offline_mode',
          `sendMessage is blocked in Offline mode with reason=offline_mode (got ${JSON.stringify(offlineSend)})`,
        );
        const rowStillFailedAfterOffline = db
          .prepare('SELECT status, error FROM whatsapp_messages WHERE id = ?')
          .get(staleQueuedId) as { status: string; error: string | null };
        assert(
          rowStillFailedAfterOffline.status === 'failed' &&
            rowStillFailedAfterOffline.error === 'ack_timeout',
          `blocked offline retry leaves failed row untouched (got ${JSON.stringify(rowStillFailedAfterOffline)})`,
        );

        // 4b. Retry honours #1315 safety controls (quiet hours for automated messages)
        const autoFailedInsert = db
          .prepare(`
            INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, error, body, created_by_user_id, queued_at, failed_at)
            VALUES ('+12133734253', 'outbound', 'auto_followup', 'failed', 'ack_timeout', 'Automated follow-up retry', 'rule:winback', datetime('now', '-10 minutes'), datetime('now', '-5 minutes'))
          `)
          .run();
        const autoFailedId = Number(autoFailedInsert.lastInsertRowid);
        const prevConfig = whatsapp.getAutomationConfig();
        whatsapp.saveAutomationConfig({
          ...prevConfig,
          safety: {
            ...prevConfig.safety,
            quietHoursEnabled: true,
            quietHoursStart: '00:00',
            quietHoursEnd: '23:59',
          },
        });
        const quietHoursRetry = await whatsapp.retryMessage(autoFailedId);
        whatsapp.saveAutomationConfig(prevConfig);
        assert(
          quietHoursRetry.ok === false && quietHoursRetry.reason === 'quiet_hours',
          `retryMessage honours #1315 quiet hours for automated messages (got ${JSON.stringify(quietHoursRetry)})`,
        );

        // 4c. Concurrent retry calls send once in place (no duplicate rows, single socket.sendMessage call)
        const countBeforeRetry = (
          db.prepare('SELECT COUNT(*) AS c FROM whatsapp_messages').get() as { c: number }
        ).c;
        const extSeqBeforeRetry = extSeq;
        const [retryRes1, retryRes2] = await Promise.all([
          whatsapp.retryMessage(staleQueuedId, { userId: 'staff-retry' }),
          whatsapp.retryMessage(staleQueuedId, { userId: 'staff-retry' }),
        ]);
        const countAfterRetry = (
          db.prepare('SELECT COUNT(*) AS c FROM whatsapp_messages').get() as { c: number }
        ).c;
        const retriedRow = db
          .prepare(
            'SELECT id, status, error, failed_at, external_message_id FROM whatsapp_messages WHERE id = ?',
          )
          .get(staleQueuedId) as {
          id: number;
          status: string;
          error: string | null;
          failed_at: string | null;
          external_message_id: string | null;
        };
        assert(
          retryRes1.ok === true &&
            retryRes2.ok === true &&
            retryRes1.messageId === staleQueuedId &&
            retryRes2.messageId === staleQueuedId,
          `concurrent retryMessage calls resolve to the same existing messageId (got ${JSON.stringify([retryRes1, retryRes2])})`,
        );
        assert(
          countAfterRetry === countBeforeRetry && extSeq - extSeqBeforeRetry === 1,
          `retryMessage updates row in-place without inserting duplicates and calls socket.sendMessage once (rows delta=${countAfterRetry - countBeforeRetry}, send calls=${extSeq - extSeqBeforeRetry})`,
        );
        assert(
          retriedRow.status === 'typing' &&
            retriedRow.error === null &&
            retriedRow.failed_at === null &&
            retriedRow.external_message_id === `ack-timeout-ext-${extSeq}`,
          `retried row transitions to typing with cleared error/failed_at and new external_message_id (got ${JSON.stringify(retriedRow)})`,
        );

        // 4d. Sequential retry after row is already in typing/sent is rejected with not_failed
        const secondSequentialRetry = await whatsapp.retryMessage(staleQueuedId);
        assert(
          secondSequentialRetry.ok === false && secondSequentialRetry.reason === 'not_failed',
          `retrying a message that is no longer failed returns reason=not_failed (got ${JSON.stringify(secondSequentialRetry)})`,
        );

        // 4e. Prior attempt external_message_id still matches late ACK after retry overwrites external_message_id
        const priorAttemptSend = await whatsapp.sendMessage({
          phoneE164: '+14155550191',
          body: 'Prior attempt ACK test',
          billId: null,
          customerId: null,
          kind: 'manual_reply',
          userId: null,
        });
        assert(
          priorAttemptSend.ok === true && typeof priorAttemptSend.messageId === 'number',
          'prior attempt send succeeds',
        );
        const priorMsgId = priorAttemptSend.messageId!;
        const firstAttemptExtId = (
          db
            .prepare('SELECT external_message_id FROM whatsapp_messages WHERE id = ?')
            .get(priorMsgId) as {
            external_message_id: string;
          }
        ).external_message_id;
        whatsapp.sweepAckTimeouts(Date.now() + whatsapp.ACK_TIMEOUT_MS + 5_000);
        // Non-retry duplicate send immediately after ACK timeout is still blocked by recentBodies
        const nonRetryDupAfterTimeout = await whatsapp.sendMessage({
          phoneE164: '+14155550191',
          body: 'Prior attempt ACK test',
          billId: null,
          customerId: null,
          kind: 'manual_reply',
          userId: null,
        });
        assert(
          nonRetryDupAfterTimeout.ok === false &&
            nonRetryDupAfterTimeout.reason === 'content_blocked',
          `non-retry duplicate send after ACK timeout remains blocked by recentBodies (got ${JSON.stringify(nonRetryDupAfterTimeout)})`,
        );
        // Self-retry is allowed even though body is in recentBodies for the same messageId
        const secondAttemptRetry = await whatsapp.retryMessage(priorMsgId);
        assert(
          secondAttemptRetry.ok === true,
          `self-retry succeeds (got ${JSON.stringify(secondAttemptRetry)})`,
        );
        const secondAttemptExtId = (
          db
            .prepare('SELECT external_message_id FROM whatsapp_messages WHERE id = ?')
            .get(priorMsgId) as {
            external_message_id: string;
          }
        ).external_message_id;
        assert(
          firstAttemptExtId !== secondAttemptExtId,
          `retry produces a new external_message_id (${firstAttemptExtId} vs ${secondAttemptExtId})`,
        );
        // Emit late ACK (status=3 delivered) referencing the FIRST attempt's external_message_id
        const updateListener = eventHandlers.get('messages.update');
        updateListener?.([{ key: { id: firstAttemptExtId }, update: { status: 3 } }]);
        const promotedFromFirstAttempt = db
          .prepare(
            'SELECT status, error, failed_at, sent_at, delivered_at FROM whatsapp_messages WHERE id = ?',
          )
          .get(priorMsgId) as {
          status: string;
          error: string | null;
          failed_at: string | null;
          sent_at: string | null;
          delivered_at: string | null;
        };
        assert(
          promotedFromFirstAttempt.status === 'delivered' &&
            promotedFromFirstAttempt.error === null &&
            promotedFromFirstAttempt.sent_at !== null &&
            promotedFromFirstAttempt.delivered_at !== null,
          `late ACK for prior attempt external_message_id promotes retried row to delivered (got ${JSON.stringify(promotedFromFirstAttempt)})`,
        );

        // 4f. Retry duplicate-body check blocks when a DIFFERENT message with the same body was recently sent
        const otherFailedInsert = db
          .prepare(`
            INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, error, body, queued_at, failed_at)
            VALUES ('+14155550191', 'outbound', 'manual_reply', 'failed', 'ack_timeout', 'Prior attempt ACK test', datetime('now', '-20 minutes'), datetime('now', '-15 minutes'))
          `)
          .run();
        const otherFailedId = Number(otherFailedInsert.lastInsertRowid);
        const dupBlockedRetry = await whatsapp.retryMessage(otherFailedId);
        assert(
          dupBlockedRetry.ok === false && dupBlockedRetry.reason === 'content_blocked',
          `retry is blocked with content_blocked when a different message with the same body was recently sent (got ${JSON.stringify(dupBlockedRetry)})`,
        );

        // 4g. Rejected retry (unpaid bill) does not poison recentBodies for a subsequent valid send
        const unpaidOrderInsert = db
          .prepare(
            "INSERT INTO orders (order_number, type, status, subtotal, tax_amount, discount_amount, total, created_at, updated_at) VALUES ('ORD-RETRY-UNPAID', 'dine_in', 'pending', 100, 0, 0, 100, datetime('now'), datetime('now'))",
          )
          .run();
        const unpaidBillInsert = db
          .prepare(
            "INSERT INTO bills (order_id, bill_number, subtotal, tax_amount, discount_amount, total, paid_amount, balance, payment_status, created_at, updated_at) VALUES (?, 'BILL-RETRY-UNPAID', 100, 0, 0, 100, 0, 100, 'unpaid', datetime('now'), datetime('now'))",
          )
          .run(unpaidOrderInsert.lastInsertRowid);
        const unpaidBillId = Number(unpaidBillInsert.lastInsertRowid);
        const unpaidFailedInsert = db
          .prepare(`
            INSERT INTO whatsapp_messages (bill_id, phone_e164, direction, kind, status, error, body, queued_at, failed_at)
            VALUES (?, '+14155550192', 'outbound', 'bill_receipt', 'failed', 'ack_timeout', 'Unpaid bill receipt body', datetime('now', '-10 minutes'), datetime('now', '-5 minutes'))
          `)
          .run(unpaidBillId);
        const unpaidFailedMsgId = Number(unpaidFailedInsert.lastInsertRowid);
        const rejectedUnpaidRetry = await whatsapp.retryMessage(unpaidFailedMsgId);
        assert(
          rejectedUnpaidRetry.ok === false && rejectedUnpaidRetry.reason === 'send_failed',
          `retry for unpaid bill is rejected with send_failed (got ${JSON.stringify(rejectedUnpaidRetry)})`,
        );
        const validSendAfterRejectedRetry = await whatsapp.sendMessage({
          phoneE164: '+14155550192',
          body: 'Unpaid bill receipt body',
          billId: null,
          customerId: null,
          kind: 'manual_reply',
          userId: null,
        });
        assert(
          validSendAfterRejectedRetry.ok === true,
          `rejected retry does not poison recentBodies for subsequent valid send (got ${JSON.stringify(validSendAfterRejectedRetry)})`,
        );

        // 4h. Active in-flight send is excluded from sweepAckTimeouts while socket.sendMessage is pending
        let releaseSlowSend!: () => void;
        const slowSendGate = new Promise<void>((resolve) => {
          releaseSlowSend = resolve;
        });
        let slowSendEntered!: () => void;
        const slowSendEnteredPromise = new Promise<void>((resolve) => {
          slowSendEntered = resolve;
        });
        fakeSocket.sendMessage = async () => {
          slowSendEntered();
          await slowSendGate;
          extSeq += 1;
          return { key: { id: `ack-timeout-ext-${extSeq}` }, message: { conversation: 'slow' } };
        };
        const inFlightSendPromise = whatsapp.sendMessage({
          phoneE164: '+14155550193',
          body: 'Slow in-flight send test',
          billId: null,
          customerId: null,
          kind: 'manual_reply',
          userId: null,
        });
        await slowSendEnteredPromise;
        const inFlightRowBeforeSweep = db
          .prepare(
            "SELECT id, status FROM whatsapp_messages WHERE phone_e164 = '+14155550193' ORDER BY id DESC LIMIT 1",
          )
          .get() as { id: number; status: string };
        // Sweep far in the future while socket.sendMessage is still in flight
        whatsapp.sweepAckTimeouts(Date.now() + whatsapp.ACK_TIMEOUT_MS + 60_000);
        const inFlightRowDuringSend = db
          .prepare('SELECT status, error FROM whatsapp_messages WHERE id = ?')
          .get(inFlightRowBeforeSweep.id) as { status: string; error: string | null };
        assert(
          inFlightRowDuringSend.status === 'typing' && inFlightRowDuringSend.error === null,
          `active in-flight send is excluded from sweepAckTimeouts (got ${JSON.stringify(inFlightRowDuringSend)})`,
        );
        releaseSlowSend();
        const finishedSlowSend = await inFlightSendPromise;
        assert(finishedSlowSend.ok === true, 'slow in-flight send resolves ok=true');

        // 4i. Runtime initFromDb() after suspendForOfflineMode() does not sweep a recently submitted typing row
        whatsapp.suspendForOfflineMode();
        whatsapp.initFromDb();
        const afterRuntimeInit = db
          .prepare('SELECT status, error FROM whatsapp_messages WHERE id = ?')
          .get(inFlightRowBeforeSweep.id) as { status: string; error: string | null };
        assert(
          afterRuntimeInit.status === 'typing' && afterRuntimeInit.error === null,
          `runtime initFromDb after suspendForOfflineMode preserves recently submitted typing row (got ${JSON.stringify(afterRuntimeInit)})`,
        );
      } finally {
        fakeSocket.sendMessage = prevSendMessage;
      }
    }

    whatsapp.disconnect();
    await whatsapp.enable('broadcast-disconnected-check');
    const disconnectedBroadcast = await whatsapp.runBroadcast({
      templateId: 'winback',
      minVisits: 1,
    });
    assert(
      disconnectedBroadcast.ok === false && disconnectedBroadcast.reason === 'not_connected',
      `runBroadcast returns ok=false and reason=not_connected when disconnected (got ${JSON.stringify(disconnectedBroadcast)})`,
    );

    /*
     * Issue #1346 macOS v3.13.0+ verification summary (DMG and Mac App Store builds):
     * - Scenario 1 (Pair -> Quit -> Reopen without QR):
     *   queueCredentialWrite() evaluates isActiveSocket(socket) synchronously when creds.update
     *   fires and serializes saveCreds() through credentialWriteTail so a same-tick 515
     *   restartRequired close or requestShutdown() does not drop the final credential flush.
     *   On reopen, initFromDb() reads creds.json from path.join(app.getPath('userData'), 'whatsapp-auth')
     *   and reconnects to 'connected' without generating a QR code.
     * - Scenario 2 (Pair -> Sleep/Wake or transient drop -> Reconnect):
     *   Non-401 disconnects on paired sessions transition to state='connecting' with
     *   lastErrorReason='reconnecting' and retry after RECONNECT_DELAY_MS (5000ms). On macOS
     *   powerMonitor 'resume', handleSystemResume() immediately reconnects when state.socket is
     *   null or stale/non-connected, and runs a bounded presence probe on open sockets to replace
     *   half-open connections left behind by macOS sleep.
     * - Scenario 3 (Pair -> Unlink device from phone, 401 loggedOut -> Re-pair QR & UI clarity):
     *   Status 401 clears timers, sets state='disconnected' and lastErrorReason='logged_out',
     *   clears whatsapp_connected_phone, and wipes whatsapp-auth/ via scheduleAuthWipe(). The UI
     *   renders a rose alert banner and "Session expired - Re-pair required" badge, distinct from
     *   the amber "Reconnecting..." badge during transient drops.
     * - Scenario 4 (macOS DMG & Mac App Store auth persistence and pairing edge cases):
     *   Both macOS DMG (~/Library/Application Support/Flo Cafe/whatsapp-auth) and MAS sandbox
     *   (~/Library/Containers/com.flo.desktop/Data/Library/Application Support/Flo Cafe/whatsapp-auth)
     *   persist multi-file Baileys credentials across restarts under 0o700 permissions. Unpaired
     *   408 QR timeouts return cleanly to 'disconnected' instead of looping; connectWithPairingCode()
     *   validates socket identity/cancellation before publishing a code and restores QR mode on
     *   failure; cancelPairing() closes an in-progress pairing socket without calling logout() or
     *   wiping existing registered credentials.
     */
    // Issue #1346 regression 1: creds.update followed in the same tick by 515 restartRequired
    // must persist credentials and reconnect seamlessly without a false error banner.
    await whatsapp.connectWithQr();
    const saveCredsBefore515 = saveCredsCalls;
    eventHandlers.get('creds.update')?.({ me: { id: '15555550100:1@s.whatsapp.net' } });
    eventHandlers.get('connection.update')?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const statusAfter515 = whatsapp.getStatus();
    assert(
      saveCredsCalls === saveCredsBefore515 + 1,
      `creds.update persists across same-tick 515 restartRequired close (got ${saveCredsCalls - saveCredsBefore515} writes)`,
    );
    assert(
      statusAfter515.state === 'connecting' &&
        statusAfter515.lastError === null &&
        statusAfter515.lastErrorReason === null,
      `515 restartRequired reconnects seamlessly without error banner (got ${JSON.stringify(statusAfter515)})`,
    );

    // Issue #1346 regression 2: 408 timedOut on an unpaired waiting_qr session returns to
    // disconnected instead of entering an auto-reconnect loop.
    whatsapp.disconnect();
    await whatsapp.enable('qr-timeout-test-user');
    await whatsapp.connectWithQr();
    eventHandlers.get('connection.update')?.({ qr: 'unpaired-qr-1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert(
      whatsapp.getStatus().state === 'waiting_qr',
      'QR update transitions unpaired socket to waiting_qr',
    );
    eventHandlers.get('connection.update')?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const statusAfter408 = whatsapp.getStatus();
    assert(
      statusAfter408.state === 'disconnected' && statusAfter408.lastErrorReason === null,
      `unpaired QR timeout (408) returns to disconnected without reconnect loop (got ${JSON.stringify(statusAfter408)})`,
    );

    // Issue #1346 regression 3: 401 loggedOut followed by connectWithQr clears stale lastError.
    await whatsapp.connectWithQr();
    eventHandlers.get('connection.update')?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert(
      whatsapp.getStatus().state === 'disconnected' &&
        whatsapp.getStatus().lastErrorReason === 'logged_out',
      '401 loggedOut transitions to disconnected with logged_out reason',
    );
    await whatsapp.connectWithQr();
    eventHandlers.get('connection.update')?.({ qr: 'fresh-repair-qr' });
    await new Promise((resolve) => setImmediate(resolve));
    const statusAfterRepairQr = whatsapp.getStatus();
    assert(
      statusAfterRepairQr.state === 'waiting_qr' &&
        statusAfterRepairQr.qr === 'fresh-repair-qr' &&
        statusAfterRepairQr.lastError === null &&
        statusAfterRepairQr.lastErrorReason === null,
      `connectWithQr clears stale logged_out error on fresh QR (got ${JSON.stringify(statusAfterRepairQr)})`,
    );

    // Issue #1346 regression 4: connectWithPairingCode failure restores QR mode so subsequent
    // QR events are not suppressed and existing QR state remains usable.
    rejectPairingCode = true;
    const failedPairingRes = await whatsapp.connectWithPairingCode('+15555550100');
    rejectPairingCode = false;
    assert(
      failedPairingRes.ok === false,
      `connectWithPairingCode returns ok=false when requestPairingCode fails (got ${JSON.stringify(failedPairingRes)})`,
    );
    eventHandlers.get('connection.update')?.({ qr: 'qr-after-failed-pairing' });
    await new Promise((resolve) => setImmediate(resolve));
    const statusAfterFailedPairing = whatsapp.getStatus();
    assert(
      statusAfterFailedPairing.state === 'waiting_qr' &&
        statusAfterFailedPairing.qr === 'qr-after-failed-pairing',
      `failed connectWithPairingCode does not suppress subsequent QR events (got ${JSON.stringify(statusAfterFailedPairing)})`,
    );

    // Issue #1346 regression 5: connectWithPairingCode clears stale QR and ignores background QR timer events.
    const pairingRes = await whatsapp.connectWithPairingCode('+15555550100');
    assert(
      pairingRes.ok === true && pairingRes.code === '12345678',
      `connectWithPairingCode returns 8-digit code (got ${JSON.stringify(pairingRes)})`,
    );
    eventHandlers.get('connection.update')?.({ qr: 'rotated-qr-from-baileys-timer' });
    await new Promise((resolve) => setImmediate(resolve));
    const statusDuringPairing = whatsapp.getStatus();
    assert(
      statusDuringPairing.state === 'waiting_pairing' &&
        statusDuringPairing.pairingCode === '12345678' &&
        statusDuringPairing.qr === undefined,
      `QR rotation event does not clobber waiting_pairing state (got ${JSON.stringify(statusDuringPairing)})`,
    );

    // Issue #1346 regression 6: superseded or cancelled connectWithPairingCode does not publish
    // a stale pairing code after cancelPairing() or connectWithQr().
    holdPairingCode = true;
    const pendingPairingPromise = whatsapp.connectWithPairingCode('+15555550100');
    await pairingCodeStartedPromise;
    whatsapp.cancelPairing();
    releasePairingCode();
    const supersededPairingRes = await pendingPairingPromise;
    holdPairingCode = false;
    assert(
      supersededPairingRes.ok === false &&
        whatsapp.getStatus().state === 'disconnected' &&
        whatsapp.getStatus().pairingCode === undefined,
      `superseded connectWithPairingCode does not publish stale pairing code (got ${JSON.stringify(supersededPairingRes)}, status=${JSON.stringify(whatsapp.getStatus())})`,
    );

    // Issue #1346 regression 7: cancelPairing() closes an in-progress pairing socket without
    // calling socket.logout() or wiping existing registered credentials.
    const authDirPath = path.join(testDir, 'whatsapp-auth');
    fs.mkdirSync(authDirPath, { recursive: true, mode: 0o700 });
    const credsFilePath = path.join(authDirPath, 'creds.json');
    fs.writeFileSync(
      credsFilePath,
      JSON.stringify({ me: { id: '15555550199:1@s.whatsapp.net' }, registered: true }),
    );
    await whatsapp.connectWithQr();
    eventHandlers.get('connection.update')?.({ qr: 'cancel-test-qr' });
    await new Promise((resolve) => setImmediate(resolve));
    const logoutCallsBeforeCancel = logoutCalls;
    whatsapp.cancelPairing();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const statusAfterCancel = whatsapp.getStatus();
    assert(
      logoutCalls === logoutCallsBeforeCancel &&
        fs.existsSync(credsFilePath) &&
        statusAfterCancel.state === 'disconnected' &&
        statusAfterCancel.connectedPhone === '+15555550199',
      `cancelPairing preserves existing registered credentials without calling logout() (logoutDelta=${logoutCalls - logoutCallsBeforeCancel}, credsExists=${fs.existsSync(credsFilePath)}, status=${JSON.stringify(statusAfterCancel)})`,
    );

    // Issue #1346 regression 8: handleSystemResume() replaces a stale non-connected socket and
    // reconnects when aconnected socket fails its resume presence health probe.
    await whatsapp.connectWithQr();
    fakeSocket.ws = { isClosed: true, readyState: 3 };
    const socketCallsBeforeStaleResume = makeSocketCalls;
    whatsapp.handleSystemResume();
    await new Promise((resolve) => setTimeout(resolve, 25));
    delete fakeSocket.ws;
    assert(
      makeSocketCalls === socketCallsBeforeStaleResume + 1,
      `handleSystemResume replaces stale closed socket and reconnects (socketDelta=${makeSocketCalls - socketCallsBeforeStaleResume})`,
    );
    eventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));
    rejectSendPresenceUpdate = true;
    const socketCallsBeforeProbeResume = makeSocketCalls;
    whatsapp.handleSystemResume();
    await new Promise((resolve) => setTimeout(resolve, 25));
    rejectSendPresenceUpdate = false;
    assert(
      makeSocketCalls === socketCallsBeforeProbeResume + 1,
      `handleSystemResume reconnects when post-sleep presence probe fails (socketDelta=${makeSocketCalls - socketCallsBeforeProbeResume})`,
    );

    // Issue #1346 regression 9: disconnect() catches asynchronous socket.logout() rejection.
    let unhandledLogoutRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledLogoutRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    rejectLogout = true;
    whatsapp.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', onUnhandledRejection);
    rejectLogout = false;
    assert(
      unhandledLogoutRejection === null,
      `disconnect() suppresses async socket.logout() rejection (got ${String(unhandledLogoutRejection)})`,
    );

    await whatsapp.enable('shutdown-send-test-user');
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
    void sendPromise.then(
      () => {
        sendSettled = true;
      },
      () => {
        sendSettled = true;
      },
    );
    let shutdownSettled = false;
    void shutdownPromise.then(
      () => {
        shutdownSettled = true;
      },
      () => {
        shutdownSettled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert(!sendSettled, 'shutdown joins the send wrapper until raw WhatsApp work settles');
    assert(!shutdownSettled, 'shutdown remains pending while underlying WhatsApp work is active');
    releasePendingPresence();
    const cancelled = await sendPromise;
    await shutdownPromise;
    const row = getDatabase()
      .prepare(`
      SELECT status, error, failed_at FROM whatsapp_messages
      WHERE direction = 'outbound' AND body = ?
      ORDER BY id DESC LIMIT 1
    `)
      .get('shutdown cancellation test') as {
      status: string;
      error: string;
      failed_at: string | null;
    };
    assert(
      cancelled.ok === false && cancelled.reason === 'send_failed',
      'shutdown-cancelled send returns send_failed',
    );
    assert(row.status === 'failed', 'shutdown-cancelled send persists a failed status');
    assert(
      row.error === 'WhatsApp is shutting down.' && row.failed_at !== null,
      'shutdown-cancelled send records its failure details',
    );
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
