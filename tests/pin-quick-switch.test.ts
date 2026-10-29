/**
 * Issue #1338: PIN quick user switch with user picker (PIN for all roles, approvals stay owner/manager).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const frontendRequire = Module.createRequire(path.join(process.cwd(), 'frontend/package.json'));
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pin-quick-switch-'));

let mockApiHandler: {
  get?: (url: string, config?: any) => Promise<any>;
  post?: (url: string, body?: any, config?: any) => Promise<any>;
  patch?: (url: string, body?: any, config?: any) => Promise<any>;
} = {};

const mockPosSettingsStore = {
  state: {
    language: 'en',
    billingType: 'prepaid',
    billTemplateSource: 'core' as 'core' | null,
    billLanguagePolicy: null as unknown,
    kotLanguagePolicy: null as unknown,
    autoLockMinutes: 0,
    tablesRequired: false,
    setLanguage(language: string) {
      this.language = language;
    },
    setBillTemplateSource(source: 'core' | null) {
      this.billTemplateSource = source;
    },
    setBillLanguagePolicy(policy: unknown) {
      this.billLanguagePolicy = policy;
    },
    setKotLanguagePolicy(policy: unknown) {
      this.kotLanguagePolicy = policy;
    },
    setAutoLockMinutes(mins: number) {
      this.autoLockMinutes = mins;
    },
  },
  getState() {
    return this.state;
  },
};
const mockPosSettingsStoreFn = Object.assign(
  (selector?: (s: any) => any) =>
    selector ? selector(mockPosSettingsStore.state) : mockPosSettingsStore.state,
  mockPosSettingsStore,
);

const realReact = frontendRequire('react');
const hookStates: any[] = [];
const hookSetters: any[] = [];
const hookRefs: any[] = [];
const hookEffectEntries: any[] = [];
const hookPendingEffects: Array<() => void> = [];

let hookStateIndex = 0;
let hookRefIndex = 0;
let hookEffectIndex = 0;

const reactHooks: Record<string, any> = {
  ...realReact,
  useSyncExternalStore: (subscribe: any, getSnapshot: () => any) => getSnapshot(),
  useDebugValue: () => {},
  useState: (initial: any) => {
    const idx = hookStateIndex++;
    if (idx >= hookStates.length) {
      hookStates.push(typeof initial === 'function' ? initial() : initial);
      hookSetters.push((next: any) => {
        hookStates[idx] = typeof next === 'function' ? next(hookStates[idx]) : next;
      });
    }
    return [hookStates[idx], hookSetters[idx]];
  },
  useRef: (initial: any) => {
    const idx = hookRefIndex++;
    if (idx >= hookRefs.length) {
      hookRefs.push({ current: initial });
    }
    return hookRefs[idx];
  },
  useEffect: (effect: any, deps: any) => {
    const idx = hookEffectIndex++;
    const prev = hookEffectEntries[idx];
    const changed =
      !prev ||
      !prev.initialized ||
      deps === undefined ||
      prev.deps === undefined ||
      deps.length !== prev.deps.length ||
      deps.some((d: any, i: number) => !Object.is(d, prev.deps[i]));
    if (!prev) hookEffectEntries[idx] = { deps, initialized: false };
    else prev.deps = deps;
    if (changed) {
      hookPendingEffects.push(() => {
        if (typeof hookEffectEntries[idx].cleanup === 'function') hookEffectEntries[idx].cleanup();
        hookEffectEntries[idx].cleanup = effect();
        hookEffectEntries[idx].initialized = true;
      });
    }
  },
  useCallback: (fn: any) => fn,
  useMemo: (fn: any) => fn(),
};

function findElement(node: any, type: any): any {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  const children = Array.isArray(node.props?.children)
    ? node.props.children
    : node.props?.children
      ? [node.props.children]
      : [];
  for (const child of children) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return null;
}

function renderPOSPage(POSPage: any) {
  hookStateIndex = 0;
  hookRefIndex = 0;
  hookEffectIndex = 0;
  const res = POSPage({});
  while (hookPendingEffects.length > 0) {
    const fn = hookPendingEffects.shift()!;
    fn();
  }
  return res;
}

function resetPOSHooks() {
  hookStates.length = 0;
  hookSetters.length = 0;
  hookRefs.length = 0;
  hookEffectEntries.length = 0;
  hookPendingEffects.length = 0;
  hookStateIndex = 0;
  hookRefIndex = 0;
  hookEffectIndex = 0;
  capturedTopbarProps = null;
  capturedScheduledDrawerProps = null;
}

let capturedCartPanelProps: any = null;
let capturedPrepaidModalProps: any = null;
let capturedTopbarProps: any = null;
let capturedScheduledDrawerProps: any = null;

const CartPanelStub = (props: any) => {
  capturedCartPanelProps = props;
  return null;
};
const PrepaidCheckoutModalStub = (props: any) => {
  capturedPrepaidModalProps = props;
  return null;
};
const PosTopbarStub = (props: any) => {
  capturedTopbarProps = props;
  return null;
};
const ScheduledOrdersDrawerStub = (props: any) => {
  capturedScheduledDrawerProps = props;
  return null;
};
const toastStub = Object.assign(() => {}, {
  success: () => {},
  error: () => {},
  custom: () => {},
});

Module._load = function (reqName: string, parent: unknown, isMain: boolean) {
  if (reqName === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  }
  if (reqName === 'react') return reactHooks;
  if (reqName === 'react-hot-toast')
    return { __esModule: true, default: toastStub, toast: toastStub };
  if (reqName === 'lucide-react') return new Proxy({}, { get: () => () => null });
  if (reqName === 'use-intl') return { useTranslations: () => (k: string) => k };
  if (reqName === 'next/dynamic') return () => () => null;
  if (reqName === '@/components/ui/sidebar') return { useSidebar: () => ({ isMobile: false }) };
  if (reqName === '@/components/ui/drawer')
    return { Drawer: () => null, DrawerContent: () => null, DrawerTrigger: () => null };
  if (reqName === '@/hooks/use-confirm')
    return { useConfirm: () => ({ confirm: async () => true, ConfirmDialog: () => null }) };
  if (reqName === '@/hooks/useCashSession')
    return {
      useCashSession: () => ({
        isShiftOpen: true,
        openSessions: [],
        openModalOpen: false,
        setOpenModalOpen: () => {},
        closeModalOpen: false,
        setCloseModalOpen: () => {},
      }),
    };
  if (reqName === '@/hooks/usePosSort')
    return { usePosSortPreference: () => ({ sortBy: 'name', sortDirection: 'asc' }) };
  if (reqName === '@/hooks/useCashDrawerMovements')
    return { useCashDrawerMovements: () => ({ open: false, setOpen: () => {} }) };
  if (reqName === '@/hooks/usePrinter')
    return {
      usePrinterStore: () => ({ isConnected: false, status: 'disconnected' }),
      isPrintCancelledOnTenantChangeError: () => false,
    };
  if (reqName === '@/hooks/useBarcodeScanner') return { useBarcodeScanner: () => {} };
  if (reqName === '@/hooks/usePosKeyboardShortcuts') return { usePosKeyboardShortcuts: () => {} };
  if (reqName === '@/hooks/useFormatCurrency')
    return { useFormatCurrency: () => (v: number) => `$${v}` };
  if (reqName === '@/hooks/useSupportTicketStatus')
    return { useSupportTicketStatus: () => ({ errorCount: 0 }) };
  if (reqName === '@/lib/countries')
    return {
      getCurrencySymbol: () => '$',
      getCountryByCode: () => ({ code: 'US', currency: 'USD' }),
    };
  if (reqName === '@/lib/api') {
    return {
      __esModule: true,
      default: {
        get: (...args: [string, any]) => mockApiHandler.get?.(...args),
        post: (...args: [string, any, any]) => mockApiHandler.post?.(...args),
        patch: (...args: [string, any, any]) => mockApiHandler.patch?.(...args),
      },
      get: (...args: [string, any]) => mockApiHandler.get?.(...args),
      post: (...args: [string, any, any]) => mockApiHandler.post?.(...args),
      patch: (...args: [string, any, any]) => mockApiHandler.patch?.(...args),
      operationHeaders: () => ({}),
      createOperationReference: () => 'op-test',
      captureClientOperationFailure: () => {},
    };
  }
  if (reqName === '@/store/pos-settings') {
    return { usePosSettingsStore: mockPosSettingsStoreFn };
  }
  if (reqName === '@/components/pos/PrepaidCheckoutModal') {
    return { __esModule: true, default: PrepaidCheckoutModalStub };
  }
  if (reqName === '@/components/pos/CartPanel') {
    return { __esModule: true, default: CartPanelStub };
  }
  if (reqName === '@/components/pos/PosTopbar') {
    return { __esModule: true, default: PosTopbarStub };
  }
  if (reqName === '@/components/pos/ScheduledOrdersDrawer') {
    return { __esModule: true, default: ScheduledOrdersDrawerStub };
  }
  if (reqName.startsWith('@/components/')) return () => null;
  if (reqName === '@/lib/cart-identity') {
    return originalLoad.call(
      this,
      path.join(process.cwd(), 'frontend/src/lib/cart-identity.ts'),
      parent,
      isMain,
    );
  }
  if (reqName === '@/lib/cart-price') {
    return originalLoad.call(
      this,
      path.join(process.cwd(), 'frontend/src/lib/cart-price.ts'),
      parent,
      isMain,
    );
  }
  if (reqName === 'zustand') {
    return originalLoad.call(this, frontendRequire.resolve('zustand'), parent, isMain);
  }
  if (reqName.startsWith('@/')) {
    try {
      return originalLoad.call(
        this,
        path.join(process.cwd(), 'frontend/src', reqName.slice(2)),
        parent,
        isMain,
      );
    } catch {
      return () => null;
    }
  }
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb,
  createApp,
  seedTable,
  seedCategory,
  seedProduct,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { authRoutes, getJWTSecret } = require('../main/routes/auth');
const { staffRoutes } = require('../main/routes/staff');
const {
  billRoutes,
  resetPinRateLimitForTests: resetBillPinRateLimit,
} = require('../main/routes/bills');
const {
  orderRoutes,
  resetPinRateLimitForTests: resetOrderPinRateLimit,
} = require('../main/routes/orders');
const { settingsRoutes } = require('../main/routes/settings');
const { refundRoutes } = require('../main/routes/refunds');
const { resetSuccessfulLogin } = require('../main/middleware/security');

function makeToken(id: string, role: string, email: string) {
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function run() {
  console.log('Testing PIN Quick User Switch & Approval Hardening (#1338)...');
  console.log('='.repeat(64));

  const db = initTestDb();
  resetBillPinRateLimit();
  resetOrderPinRateLimit();

  const ts = now();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_requires_approval', 'true', ?)",
  ).run(ts);

  // Seed owner (PIN 2468) and manager (PIN 1357)
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('owner-1', 'Alice Owner', 'owner@test.local', ?, 'owner', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('OwnerPass1!', 10), bcrypt.hashSync('2468', 10), ts, ts);

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-1', 'Bob Manager', 'manager@test.local', ?, 'manager', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('MgrPass1!', 10), bcrypt.hashSync('1357', 10), ts, ts);

  // Seed user without PIN (server) and inactive user with PIN
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('server-no-pin', 'NoPin Server', 'server@test.local', ?, 'server', NULL, 1, ?, ?)
  `).run(bcrypt.hashSync('SrvPass1!', 10), ts, ts);

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('inactive-pin', 'Inactive Chef', 'inactive@test.local', ?, 'chef', ?, 0, ?, ?)
  `).run(bcrypt.hashSync('ChefPass1!', 10), bcrypt.hashSync('9999', 10), ts, ts);

  const ownerAuth = makeToken('owner-1', 'owner', 'owner@test.local');
  const managerAuth = makeToken('mgr-1', 'manager', 'manager@test.local');

  const app = createApp({
    '/api/auth': authRoutes,
    '/api/staff': staffRoutes,
    '/api/bills': billRoutes,
    '/api/orders': orderRoutes,
    '/api/settings': settingsRoutes,
    '/api/refunds': refundRoutes,
  });

  // ── 1. Cashier setting a PIN and signing in via POST /api/auth/pin-login ──
  console.log('\n1. Cashier setting a PIN (shared PIN 2468 with owner) and signing in');
  const createCashierRes = await request(app).post('/api/staff').set(managerAuth).send({
    name: 'Charlie Cashier',
    email: 'cashier@test.local',
    password: 'CashierPass1!',
    role: 'cashier',
    pin: '2468', // Same PIN as owner-1!
  });
  assertEqualOrThrow(
    createCashierRes.status,
    201,
    'Manager can create cashier with a 4-6 digit PIN',
  );
  const cashierId = createCashierRes.body.staff.id as string;
  assertEqualOrThrow(createCashierRes.body.staff.has_pin, 1, 'Created cashier has_pin is 1');

  // Update cashier PIN to 5555 and back to 2468 via PUT /api/staff/:id
  const updateCashierPinRes = await request(app)
    .put(`/api/staff/${cashierId}`)
    .set(managerAuth)
    .send({ pin: '5555' });
  assertEqualOrThrow(updateCashierPinRes.status, 200, 'Manager can update cashier PIN');

  const restoreSharedPinRes = await request(app)
    .put(`/api/staff/${cashierId}`)
    .set(managerAuth)
    .send({ pin: '2468' });
  assertEqualOrThrow(restoreSharedPinRes.status, 200, 'Cashier can share PIN 2468 with owner');

  // ── 2. Quick-switch directory omits users without PIN and inactive users ──
  console.log('\n2. GET /api/auth/pin-users returns only active users with PIN');
  const pickerRes = await request(app).get('/api/auth/pin-users');
  assertEqualOrThrow(pickerRes.status, 200, 'GET /api/auth/pin-users returns 200');
  const pickerUsers = pickerRes.body.users as Array<Record<string, unknown>>;
  assertEqualOrThrow(pickerUsers.length, 3, 'Picker includes owner, manager, and cashier with PIN');
  assertOrThrow(
    !pickerUsers.some((u) => u.id === 'server-no-pin'),
    'User without a PIN is omitted from quick-switch picker',
  );
  assertOrThrow(
    !pickerUsers.some((u) => u.id === 'inactive-pin'),
    'Inactive user with a PIN is omitted from quick-switch picker',
  );
  for (const u of pickerUsers) {
    assertEqualOrThrow(
      Object.keys(u).sort().join(','),
      'id,name,role',
      'Picker exposes only id, name, role',
    );
  }

  // ── 3. Two users with the same PIN each sign in as themselves ──
  console.log('\n3. Two users sharing PIN 2468 sign in as themselves via POST /api/auth/pin-login');
  const ownerPinLogin = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: 'owner-1', pin: '2468' });
  assertEqualOrThrow(ownerPinLogin.status, 200, 'Owner signs in with PIN 2468');
  assertEqualOrThrow(ownerPinLogin.body.user.id, 'owner-1', 'Owner PIN login returns owner-1');
  assertEqualOrThrow(ownerPinLogin.body.user.role, 'owner', 'Owner PIN login returns owner role');
  assertOrThrow(Boolean(ownerPinLogin.body.access_token), 'Owner PIN login issues access_token');

  const cashierPinLogin = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: cashierId, pin: '2468' });
  assertEqualOrThrow(cashierPinLogin.status, 200, 'Cashier signs in with same PIN 2468');
  assertEqualOrThrow(
    cashierPinLogin.body.user.id,
    cashierId,
    'Cashier PIN login returns cashierId',
  );
  assertEqualOrThrow(
    cashierPinLogin.body.user.role,
    'cashier',
    'Cashier PIN login returns cashier role',
  );
  assertOrThrow(
    ownerPinLogin.body.access_token !== cashierPinLogin.body.access_token,
    'Owner and cashier receive distinct tokens',
  );

  // User without PIN cannot sign in via pin-login
  const noPinLogin = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: 'server-no-pin', pin: '2468' });
  assertEqualOrThrow(noPinLogin.status, 401, 'User without PIN is rejected on pin-login');

  // Missing user_id or pin returns 400 and records failure in auth_audit_log
  const missingUserRes = await request(app).post('/api/auth/pin-login').send({ pin: '2468' });
  assertEqualOrThrow(missingUserRes.status, 400, 'Missing user_id returns 400');
  const missingPinRes = await request(app).post('/api/auth/pin-login').send({ user_id: 'owner-1' });
  assertEqualOrThrow(missingPinRes.status, 400, 'Missing pin returns 400');
  const missingAuditRows = db
    .prepare(
      "SELECT user_id, outcome, details_json FROM auth_audit_log WHERE event_type = 'pin_login' AND outcome = 'failure' ORDER BY id ASC",
    )
    .all() as Array<{ user_id: string | null; outcome: string; details_json: string | null }>;
  assertOrThrow(
    missingAuditRows.some(
      (r) => r.user_id === null && String(r.details_json).includes('missing_user_id'),
    ),
    'Missing user_id is recorded in auth_audit_log',
  );
  assertOrThrow(
    missingAuditRows.some(
      (r) => r.user_id === 'owner-1' && String(r.details_json).includes('missing_pin'),
    ),
    'Missing pin is recorded in auth_audit_log',
  );

  // Repeated successful quick switches from one IP (>10 times) succeed without 429
  for (let i = 0; i < 12; i++) {
    const switchRes = await request(app)
      .post('/api/auth/pin-login')
      .send({ user_id: i % 2 === 0 ? 'owner-1' : cashierId, pin: '2468' });
    assertEqualOrThrow(switchRes.status, 200, `Quick switch #${i + 1} from shared IP returns 200`);
  }

  // ── 4. Per-user rate limiting and audit logging on POST /api/auth/pin-login ──
  console.log('\n4. Wrong PIN rate limiting per user and auth_audit_log rows');
  resetSuccessfulLogin(`127.0.0.1:pin:${cashierId}`);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wrongRes = await request(app)
      .post('/api/auth/pin-login')
      .send({ user_id: cashierId, pin: '0000' });
    assertEqualOrThrow(wrongRes.status, 401, `Wrong PIN attempt ${attempt} returns 401`);
    assertEqualOrThrow(
      wrongRes.body.attempts_remaining,
      5 - attempt,
      `Attempt ${attempt} reports ${5 - attempt} attempts remaining`,
    );
  }
  const lockedOutRes = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: cashierId, pin: '2468' });
  assertEqualOrThrow(
    lockedOutRes.status,
    429,
    '6th attempt for locked-out user returns 429 even with correct PIN',
  );

  // Another user on the same device/IP is NOT locked out by cashierId's failed attempts
  const ownerStillCanLogin = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: 'owner-1', pin: '2468' });
  assertEqualOrThrow(
    ownerStillCanLogin.status,
    200,
    'Rate limit is scoped per user so owner-1 can still sign in on the same terminal',
  );

  const auditRows = db
    .prepare(
      "SELECT user_id, event_type, outcome FROM auth_audit_log WHERE event_type = 'pin_login' ORDER BY id ASC",
    )
    .all() as Array<{ user_id: string; event_type: string; outcome: string }>;
  assertOrThrow(
    auditRows.some((r) => r.user_id === 'owner-1' && r.outcome === 'success'),
    'Audit log records successful owner PIN sign-in',
  );
  assertOrThrow(
    auditRows.some((r) => r.user_id === cashierId && r.outcome === 'success'),
    'Audit log records successful cashier PIN sign-in',
  );
  assertEqualOrThrow(
    auditRows.filter((r) => r.user_id === cashierId && r.outcome === 'failure').length,
    5,
    'Audit log records 5 failed PIN attempts for cashier',
  );
  assertOrThrow(
    auditRows.some((r) => r.user_id === cashierId && r.outcome === 'rate_limited'),
    'Audit log records rate_limited outcome on 6th attempt',
  );

  resetSuccessfulLogin(`127.0.0.1:pin:${cashierId}`);

  // Concurrent wrong-PIN burst is serialized per user and cannot bypass the 5-attempt lockout
  const concurrentWrongResponses = await Promise.all(
    Array.from({ length: 8 }, () =>
      request(app).post('/api/auth/pin-login').send({ user_id: cashierId, pin: '0000' }),
    ),
  );
  assertEqualOrThrow(
    concurrentWrongResponses.filter((r) => r.status === 401).length,
    5,
    'Concurrent wrong-PIN burst allows exactly 5 attempts (401) before lockout',
  );
  assertEqualOrThrow(
    concurrentWrongResponses.filter((r) => r.status === 429).length,
    3,
    'Remaining 3 concurrent wrong-PIN requests receive 429 rate-limited',
  );
  resetSuccessfulLogin(`127.0.0.1:pin:${cashierId}`);

  // Rotating source IP cannot bypass the 5-attempt per-account lockout (pin-user:<userId>)
  app.set('trust proxy', true);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const resIp = await request(app)
      .post('/api/auth/pin-login')
      .set('X-Forwarded-For', `10.10.0.${attempt}`)
      .send({ user_id: cashierId, pin: '0000' });
    assertEqualOrThrow(
      resIp.status,
      401,
      `Rotated IP attempt ${attempt} (10.10.0.${attempt}) returns 401`,
    );
    assertEqualOrThrow(
      resIp.body.attempts_remaining,
      5 - attempt,
      `Rotated IP attempt ${attempt} reports ${5 - attempt} attempts remaining on account bucket`,
    );
  }
  const lockedAcrossIps = await request(app)
    .post('/api/auth/pin-login')
    .set('X-Forwarded-For', '10.10.0.99')
    .send({ user_id: cashierId, pin: '2468' });
  assertEqualOrThrow(
    lockedAcrossIps.status,
    429,
    '6th attempt from a fresh source IP returns 429 due to per-account lockout',
  );
  const rotatedIpAuditRows = db
    .prepare(
      "SELECT user_id, outcome, ip_address FROM auth_audit_log WHERE event_type = 'pin_login' AND ip_address = '10.10.0.99'",
    )
    .all() as Array<{ user_id: string; outcome: string; ip_address: string }>;
  assertOrThrow(
    rotatedIpAuditRows.some((r) => r.user_id === cashierId && r.outcome === 'rate_limited'),
    'Audit log records rate_limited on 6th attempt from rotated source IP 10.10.0.99',
  );
  for (let attempt = 1; attempt <= 5; attempt++) {
    resetSuccessfulLogin(`10.10.0.${attempt}:pin:${cashierId}`);
  }
  resetSuccessfulLogin(`127.0.0.1:pin:${cashierId}`);

  // Concurrent failed attempts across distinct source IPs are serialized by withPinVerificationLock(accountRateKey)
  const concurrentCrossIpResponses = await Promise.all(
    Array.from({ length: 8 }, (_, idx) =>
      request(app)
        .post('/api/auth/pin-login')
        .set('X-Forwarded-For', `10.20.0.${idx + 1}`)
        .send({ user_id: cashierId, pin: '0000' }),
    ),
  );
  assertEqualOrThrow(
    concurrentCrossIpResponses.filter((r) => r.status === 401).length,
    5,
    'Concurrent cross-IP wrong-PIN burst is serialized by withPinVerificationLock and allows only 5 attempts (401)',
  );
  assertEqualOrThrow(
    concurrentCrossIpResponses.filter((r) => r.status === 429).length,
    3,
    'Remaining 3 concurrent cross-IP wrong-PIN requests receive 429 rate-limited',
  );
  app.set('trust proxy', false);
  for (let idx = 1; idx <= 8; idx++) {
    resetSuccessfulLogin(`10.20.0.${idx}:pin:${cashierId}`);
  }
  resetSuccessfulLogin(`127.0.0.1:pin:${cashierId}`);

  // ── 5. Cashier PIN rejected on EVERY approval endpoint ──
  console.log('\n5. Cashier PIN rejected on every approval endpoint');
  const cashierAuth = makeToken(cashierId, 'cashier', 'cashier@test.local');

  // Grant cashier configurable permissions so only the owner/manager approval check stands between them
  const grantPermStmt = db.prepare(`
    INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, effect, updated_by, updated_at)
    VALUES (?, ?, 'allow', 'owner-1', ?)
  `);
  for (const perm of [
    'bills.discount.apply',
    'orders.discount.apply',
    'orders.item.cancel',
    'orders.status.update',
    'payments.take',
    'bills.read',
    'bills.generate',
  ]) {
    grantPermStmt.run(cashierId, perm, ts);
  }

  // (a) GET /api/staff/approvers omits cashier
  const approversRes = await request(app).get('/api/staff/approvers').set(cashierAuth);
  assertEqualOrThrow(approversRes.status, 200, 'GET /api/staff/approvers returns 200');
  assertOrThrow(
    !approversRes.body.approvers.some((a: any) => a.id === cashierId),
    'Cashier with PIN is excluded from GET /api/staff/approvers',
  );

  // Set a distinct PIN on cashier (7777) so fallback PIN scanning cannot match owner-1 (2468)
  await request(app).put(`/api/staff/${cashierId}`).set(managerAuth).send({ pin: '7777' });

  // Even when a store grants cashier route permissions for discounts, item cancel, and refunds,
  // cashier PINs must STILL be rejected on every PIN approval check (only owner/manager PINs approve).
  for (const permId of ['bills.discount.apply', 'orders.item.cancel', 'refunds.initiate']) {
    db.prepare(`
      INSERT OR REPLACE INTO role_permission_overrides (role, permission_id, effect, updated_by, updated_at)
      VALUES ('cashier', ?, 'allow', 'owner-1', ?)
    `).run(permId, ts);
  }

  // Seed an active order + item + bill for discount, void, status, kitchen-delivery, charge waiver, and refund tests
  const tableId = 'tbl-pin-test';
  seedTable(db, tableId, 1, 4);
  db.prepare('UPDATE tables SET status = ? WHERE id = ?').run('occupied', tableId);

  const catId = 'cat-pin-test';
  seedCategory(db, catId, 'Main Course');

  const prodId = 'prod-pin-test';
  seedProduct(db, prodId, catId, 'Espresso', 100);

  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('custom_charges', ?, ?)",
  ).run(
    JSON.stringify([
      {
        id: 'service_charge',
        name: 'Service Charge',
        type: 'percentage',
        value: 10,
        calculation_basis: 'net',
        order_types: ['dine_in'],
        is_optional: true,
        is_default_active: true,
        is_active: true,
      },
    ]),
    ts,
  );

  const initialChargesBreakdown = JSON.stringify([
    {
      id: 'service_charge',
      name: 'Service Charge',
      type: 'percentage',
      rate: 10,
      calculation_basis: 'net',
      amount: 10,
      waived: false,
    },
  ]);

  db.prepare(`
    INSERT INTO orders (order_number, type, table_id, subtotal, tax_amount, service_charge, charges_breakdown, total, status, user_id, created_at, updated_at)
    VALUES ('ORD-PIN-001', 'dine_in', ?, 100, 0, 10, ?, 110, 'preparing', ?, ?, ?)
  `).run(tableId, initialChargesBreakdown, cashierId, ts, ts);
  const orderId = (
    db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-PIN-001'").get() as any
  ).id;

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, ?, 'Espresso', 1, 100, 100, 0, 100, 'preparing', ?, ?)
  `).run(orderId, prodId, ts, ts);
  const orderItemId = (
    db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any
  ).id;

  db.prepare(`
    INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, service_charge, packaging_charge, charges_breakdown, total, paid_amount, balance, payment_status, created_at, updated_at)
    VALUES ('BILL-PIN-001', ?, 100, 0, 10, 0, ?, 110, 0, 110, 'unpaid', ?, ?)
  `).run(orderId, initialChargesBreakdown, ts, ts);
  const billId = (
    db.prepare("SELECT id FROM bills WHERE bill_number = 'BILL-PIN-001'").get() as any
  ).id;

  // (b) Bill discount with cashier PIN -> 403
  resetBillPinRateLimit();
  const billDiscCashierScan = await request(app)
    .post(`/api/bills/${billId}/discount`)
    .set(cashierAuth)
    .send({ type: 'percentage', value: 10, override_pin: '7777' });
  assertEqualOrThrow(
    billDiscCashierScan.status,
    403,
    'Bill discount rejects cashier PIN (scan path) with 403',
  );

  const billDiscCashierTargeted = await request(app)
    .post(`/api/bills/${billId}/discount`)
    .set(cashierAuth)
    .send({ type: 'percentage', value: 10, approver_id: cashierId, override_pin: '7777' });
  assertEqualOrThrow(
    billDiscCashierTargeted.status,
    403,
    'Bill discount rejects cashier PIN (targeted approver_id) with 403',
  );

  // (c) Order discount & order item discount with cashier PIN -> 403
  resetOrderPinRateLimit();
  const orderDiscCashier = await request(app)
    .patch(`/api/orders/${orderId}/discount`)
    .set(cashierAuth)
    .send({ discount_type: 'percentage', discount_value: 10, override_pin: '7777' });
  assertEqualOrThrow(orderDiscCashier.status, 403, 'Order discount rejects cashier PIN with 403');

  const itemDiscCashier = await request(app)
    .patch(`/api/orders/${orderId}/items/${orderItemId}/discount`)
    .set(cashierAuth)
    .send({ discount_type: 'percentage', discount_value: 10, override_pin: '7777' });
  assertEqualOrThrow(
    itemDiscCashier.status,
    403,
    'Order item discount rejects cashier PIN with 403',
  );

  // (d) Item void (cancel in-progress preparing item) with cashier PIN -> 403
  resetOrderPinRateLimit();
  const itemVoidCashierScan = await request(app)
    .patch(`/api/orders/${orderId}/items/${orderItemId}/cancel`)
    .set(cashierAuth)
    .send({ reason: 'Customer changed mind', override_pin: '7777' });
  assertEqualOrThrow(
    itemVoidCashierScan.status,
    403,
    'In-progress item void rejects cashier PIN (scan path) with 403',
  );

  const itemVoidCashierTargeted = await request(app)
    .patch(`/api/orders/${orderId}/items/${orderItemId}/cancel`)
    .set(cashierAuth)
    .send({ reason: 'Customer changed mind', approver_id: cashierId, override_pin: '7777' });
  assertEqualOrThrow(
    itemVoidCashierTargeted.status,
    403,
    'In-progress item void rejects cashier PIN (targeted approver_id) with 403',
  );

  db.prepare(`
    INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at)
    VALUES ('ORD-PIN-VOID-002', 'dine_in', 'preparing', 100, 0, 100, ?, ?)
  `).run(ts, ts);
  const voidOrder2Id = (
    db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-PIN-VOID-002'").get() as any
  ).id;
  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, ?, 'Espresso', 1, 100, 100, 0, 100, 'preparing', ?, ?)
  `).run(voidOrder2Id, prodId, ts, ts);
  const voidOrder2ItemId = (
    db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(voidOrder2Id) as any
  ).id;

  const itemVoidTrimmedManager = await request(app)
    .patch(`/api/orders/${voidOrder2Id}/items/${voidOrder2ItemId}/cancel`)
    .set(cashierAuth)
    .send({
      reason: 'Customer changed mind',
      manager_id: '',
      approver_id: '  mgr-1  ',
      override_pin: '1357',
    });
  assertEqualOrThrow(
    itemVoidTrimmedManager.status,
    200,
    'In-progress item void succeeds with whitespace-trimmed manager approver_id and empty alias',
  );

  // (e) Order-status override (cancel preparing order, complete unpaid order) with cashier PIN -> 403
  resetOrderPinRateLimit();
  const orderCancelCashier = await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set(cashierAuth)
    .send({ status: 'cancelled', override_pin: '7777' });
  assertEqualOrThrow(
    orderCancelCashier.status,
    403,
    'Order cancel override rejects cashier PIN with 403',
  );

  const orderCompleteCashier = await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set(cashierAuth)
    .send({ status: 'completed', approver_id: cashierId, override_pin: '7777' });
  assertEqualOrThrow(
    orderCompleteCashier.status,
    403,
    'Order complete override rejects cashier PIN with 403',
  );

  // (f) Charge waiver on bill (service/packaging/custom charge waiver) with cashier PIN -> 403
  resetBillPinRateLimit();
  const chargeWaiveNoPin = await request(app)
    .patch(`/api/bills/${billId}/charges`)
    .set(cashierAuth)
    .send({ charge_id: 'service_charge', waived: true });
  assertEqualOrThrow(
    chargeWaiveNoPin.status,
    403,
    'Cashier cannot waive a bill charge without an owner/manager approval PIN',
  );

  const chargeWaiveCashierPin = await request(app)
    .patch(`/api/bills/${billId}/charges`)
    .set(cashierAuth)
    .send({
      charge_id: 'service_charge',
      waived: true,
      approver_id: cashierId,
      override_pin: '7777',
    });
  assertEqualOrThrow(
    chargeWaiveCashierPin.status,
    403,
    'Charge waiver rejects cashier PIN with 403',
  );

  const chargeWaiveManagerPin = await request(app)
    .patch(`/api/bills/${billId}/charges`)
    .set(cashierAuth)
    .send({
      charge_id: 'service_charge',
      waived: true,
      approver_id: 'mgr-1',
      override_pin: '1357',
    });
  assertEqualOrThrow(
    chargeWaiveManagerPin.status,
    200,
    'Charge waiver succeeds when authorized with manager PIN',
  );

  // Restore charge to un-waived for payment test
  await request(app)
    .patch(`/api/bills/${billId}/charges`)
    .set(ownerAuth)
    .send({ charge_id: 'service_charge', waived: false });

  // (g) Kitchen-delivery override on bill payment and table payment with cashier PIN -> 403
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('require_kitchen_delivered_before_settlement', 'true', ?)",
  ).run(ts);
  resetBillPinRateLimit();

  const billPayKitchenOverrideCashier = await request(app)
    .post(`/api/bills/${billId}/payments`)
    .set(cashierAuth)
    .send({
      payments: [{ method: 'card', amount: 110 }],
      override_pin: '7777',
      approver_id: cashierId,
    });
  assertEqualOrThrow(
    billPayKitchenOverrideCashier.status,
    403,
    'Kitchen-delivery payment override rejects cashier PIN with 403',
  );

  const singlePayKitchenOverrideCashier = await request(app)
    .post(`/api/bills/${billId}/payment`)
    .set(cashierAuth)
    .send({
      method: 'card',
      amount: 110,
      override_pin: '7777',
    });
  assertEqualOrThrow(
    singlePayKitchenOverrideCashier.status,
    403,
    'Single payment kitchen-delivery override rejects cashier PIN with 403',
  );

  // Settle bill with valid manager PIN override so we can test refund approval
  const billPayWithManagerPin = await request(app)
    .post(`/api/bills/${billId}/payments`)
    .set(cashierAuth)
    .send({
      payments: [{ method: 'card', amount: 110 }],
      approver_id: 'mgr-1',
      override_pin: '1357',
    });
  assertEqualOrThrow(
    billPayWithManagerPin.status,
    200,
    'Kitchen-delivery payment override succeeds with manager PIN',
  );

  // (h) Refund with cashier PIN -> 403
  resetBillPinRateLimit();
  const refundCashierPin = await request(app).post('/api/refunds').set(cashierAuth).send({
    bill_id: billId,
    amount: 20,
    reason: 'Customer complaint',
    method: 'card',
    approver_id: cashierId,
    override_pin: '7777',
  });
  assertEqualOrThrow(refundCashierPin.status, 403, 'Refund rejects cashier PIN with 403');

  const refundValidOwnerPin = await request(app).post('/api/refunds').set(cashierAuth).send({
    bill_id: billId,
    amount: 20,
    reason: 'Customer complaint',
    method: 'card',
    approver_id: 'owner-1',
    override_pin: '2468',
  });
  assertEqualOrThrow(
    refundValidOwnerPin.status,
    201,
    'Refund succeeds with valid owner approver_id and PIN',
  );

  // ── 6. Auto-lock setting validation ──
  console.log('\n6. Idle auto-lock store setting (off by default; 1, 5, 15, or 30 minutes)');
  const unauthAutoLock = await request(app).get('/api/settings/auto_lock_minutes');
  assertEqualOrThrow(
    unauthAutoLock.status,
    401,
    'Unauthenticated GET /api/settings/auto_lock_minutes returns 401',
  );

  const defaultAutoLock = await request(app)
    .get('/api/settings/auto_lock_minutes')
    .set(cashierAuth);
  assertEqualOrThrow(
    defaultAutoLock.status,
    200,
    'Cashier can read /api/settings/auto_lock_minutes',
  );
  assertEqualOrThrow(
    defaultAutoLock.body.setting.value,
    '0',
    'auto_lock_minutes defaults to 0 (off)',
  );

  for (const validMins of ['1', '5', '15', '30', '0']) {
    const saveAutoLock = await request(app)
      .put('/api/settings/auto_lock_minutes')
      .set(ownerAuth)
      .send({ value: validMins });
    assertEqualOrThrow(saveAutoLock.status, 200, `Owner can set auto_lock_minutes to ${validMins}`);
    assertEqualOrThrow(
      saveAutoLock.body.setting.value,
      validMins,
      `auto_lock_minutes persists ${validMins}`,
    );
  }

  const invalidAutoLock = await request(app)
    .put('/api/settings/auto_lock_minutes')
    .set(ownerAuth)
    .send({ value: '10' });
  assertEqualOrThrow(
    invalidAutoLock.status,
    400,
    'Invalid auto_lock_minutes value (10) is rejected with 400',
  );

  // User with only reports.view / dashboard access can read auto_lock_minutes (PR #1392)
  const reportsOnlyId = 'reports-only-user';
  const reportsOnlyAuth = makeToken(reportsOnlyId, 'server', 'reports@test.local');
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, 'Reports Staff', 'reports@test.local', ?, 'server', ?, 1, ?, ?)
  `).run(reportsOnlyId, bcrypt.hashSync('Pass123!', 10), bcrypt.hashSync('8888', 10), ts, ts);

  for (const perm of [
    'pos.use',
    'orders.read',
    'orders.create',
    'orders.status.update',
    'tables.view',
    'catalog.view',
    'kitchen.use',
    'support.use',
    'settings.view',
  ]) {
    db.prepare(`
      INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES (?, ?, 'deny', 'owner-1', ?, ?)
    `).run(reportsOnlyId, perm, ts, ts);
  }
  db.prepare(`
    INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
    VALUES (?, 'reports.view', 'allow', 'owner-1', ?, ?)
  `).run(reportsOnlyId, ts, ts);

  await request(app).put('/api/settings/auto_lock_minutes').set(ownerAuth).send({ value: '15' });

  const reportsUserAutoLock = await request(app)
    .get('/api/settings/auto_lock_minutes')
    .set(reportsOnlyAuth);
  assertEqualOrThrow(
    reportsUserAutoLock.status,
    200,
    'Reports-only staff user can read /api/settings/auto_lock_minutes (200)',
  );
  assertEqualOrThrow(
    reportsUserAutoLock.body.setting.value,
    '15',
    'Reports-only staff user receives configured non-zero idle-lock timeout (15)',
  );

  // ── 7. Frontend auth + cart store lock & quick-switch behavior ──
  console.log(
    '\n7. Frontend auth & cart store: lock preserves cart, clears privileged state, ignores stale async callbacks',
  );
  (globalThis as any).window = {
    dispatchEvent: () => {},
  };
  (globalThis as any).localStorage = {
    values: new Map<string, string>(),
    getItem(k: string) {
      return this.values.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      this.values.set(k, v);
    },
    removeItem(k: string) {
      this.values.delete(k);
    },
  };

  const { useAuthStore } = require('../frontend/src/store/auth');
  const { useCartStore } = require('../frontend/src/store/cart');

  let staleMeResolver!: (val: any) => void;
  const staleMePromise = new Promise((res) => {
    staleMeResolver = res;
  });
  const capturedLogoutHeaders: Array<string | undefined> = [];
  const capturedLogoutBodies: Array<unknown> = [];

  mockApiHandler = {
    post: async (url: string, body?: any, config?: any) => {
      if (url === '/auth/logout') {
        capturedLogoutBodies.push(body);
        capturedLogoutHeaders.push(config?.headers?.Authorization);
        return { data: { message: 'Logged out' } };
      }
      if (url === '/auth/pin-login') {
        return {
          data: {
            access_token: `token-for-${body.user_id}`,
            user: {
              id: body.user_id,
              name: body.user_id === 'owner-1' ? 'Alice Owner' : 'Charlie Cashier',
              email: `${body.user_id}@test.local`,
              role: body.user_id === 'owner-1' ? 'owner' : 'cashier',
            },
            tenants: [
              {
                id: 1,
                business_name: 'Test Cafe',
                role: body.user_id === 'owner-1' ? 'owner' : 'cashier',
                permission_ids:
                  body.user_id === 'owner-1'
                    ? ['pos.use', 'orders.item.price_override']
                    : ['pos.use'],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    },
    get: async (url: string) => {
      if (url === '/auth/me') return staleMePromise;
      throw new Error(`Unexpected GET ${url}`);
    },
  };

  // Sign in as owner via pinLogin
  await useAuthStore.getState().pinLogin('owner-1', '2468');
  assertEqualOrThrow(useAuthStore.getState().user?.id, 'owner-1', 'Store signed in as owner-1');
  assertEqualOrThrow(
    useAuthStore.getState().isLocked,
    false,
    'Store isLocked is false after pinLogin',
  );

  // Add item to cart, apply owner price override, and waive a charge
  const sampleProduct = {
    id: 'prod-1',
    name: 'Latte',
    price: 120,
    category_id: 'cat-1',
    is_available: 1,
  };
  useCartStore.getState().clearCart();
  useCartStore.getState().addItem(sampleProduct as any, 2);
  const cartItemId = useCartStore.getState().items[0].id;
  useCartStore.getState().setItemPriceOverride(cartItemId, { price: 90, reason: 'Owner promo' });
  useCartStore.getState().toggleWaiveCharge('service_charge');
  assertEqualOrThrow(
    useCartStore.getState().items[0].price_override?.price,
    90,
    'Owner price override applied to cart item',
  );
  assertEqualOrThrow(
    useCartStore.getState().waivedChargeIds.has('service_charge'),
    true,
    'Charge waiver present before lock',
  );

  // Start an in-flight refreshAuthContext() for owner-1 before locking/switching
  const inFlightRefresh = useAuthStore.getState().refreshAuthContext();
  mockPosSettingsStore.state.setAutoLockMinutes(15);

  // Lock terminal
  await useAuthStore.getState().lock();
  assertEqualOrThrow(useAuthStore.getState().user, null, 'lock() clears active user');
  assertEqualOrThrow(useAuthStore.getState().token, null, 'lock() clears active token');
  assertEqualOrThrow(useAuthStore.getState().isLocked, true, 'lock() sets isLocked = true');
  assertEqualOrThrow(
    capturedLogoutHeaders[capturedLogoutHeaders.length - 1],
    'Bearer token-for-owner-1',
    'lock() passes Authorization Bearer header to POST /auth/logout before clearing storage',
  );
  assertEqualOrThrow(
    capturedLogoutBodies[capturedLogoutBodies.length - 1],
    undefined,
    'lock() passes undefined body to POST /auth/logout so express.json() accepts the empty body',
  );
  assertEqualOrThrow(
    mockPosSettingsStore.state.autoLockMinutes,
    0,
    'lock() resets autoLockMinutes to 0',
  );
  assertEqualOrThrow(
    useCartStore.getState().items.length,
    1,
    'lock() preserves unfinished cart items on the terminal',
  );
  assertEqualOrThrow(
    useCartStore.getState().items[0].quantity,
    2,
    'lock() preserves cart item quantity',
  );
  assertEqualOrThrow(
    useCartStore.getState().items[0].price_override ?? null,
    null,
    'lock() clears privileged price_override from cart items',
  );
  assertEqualOrThrow(
    useCartStore.getState().waivedChargeIds.size,
    0,
    'lock() clears privileged charge waivers from cart',
  );

  // Quick-switch to cashier via pinLogin
  await useAuthStore.getState().pinLogin(cashierId, '7777');
  assertEqualOrThrow(useAuthStore.getState().user?.id, cashierId, 'Quick switch sets cashier user');
  assertEqualOrThrow(useAuthStore.getState().isLocked, false, 'Quick switch clears isLocked');

  // Resolve stale /auth/me from owner-1's previous session and confirm it is ignored
  staleMeResolver({
    data: {
      user: { id: 'owner-1', name: 'Alice Owner', email: 'owner@test.local', role: 'owner' },
      tenants: [{ id: 1, business_name: 'Test Cafe', role: 'owner' }],
    },
  });
  await inFlightRefresh;
  assertEqualOrThrow(
    useAuthStore.getState().user?.id,
    cashierId,
    'Stale /auth/me callback from previous session is ignored after user switch',
  );

  // ── 8. POS checkout session-continuation guard ──
  console.log(
    '\n8. POS checkout session-continuation guard: switching session invalidates in-flight checkout and preserves recovery state',
  );

  const fakeStorage = {
    values: new Map<string, string>(),
    getItem(k: string) {
      return this.values.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      this.values.set(k, String(v));
    },
    removeItem(k: string) {
      this.values.delete(k);
    },
  };
  (globalThis as any).window = {
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
    localStorage: fakeStorage,
    sessionStorage: fakeStorage,
  };
  const documentCookieMap = new Map<string, string>();
  (globalThis as any).document = {
    fullscreenElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    get cookie() {
      return Array.from(documentCookieMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    },
    set cookie(str: string) {
      if (!str) return;
      const [pair, ...directives] = str.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx !== -1) {
        const k = pair.slice(0, eqIdx).trim();
        const v = pair.slice(eqIdx + 1).trim();
        const maxAgeDirective = directives.find((d) =>
          d.trim().toLowerCase().startsWith('max-age='),
        );
        if (maxAgeDirective && maxAgeDirective.split('=')[1].trim() === '0') {
          documentCookieMap.delete(k);
        } else {
          documentCookieMap.set(k, v);
        }
      }
    },
  };
  (globalThis as any).localStorage = fakeStorage;
  (globalThis as any).sessionStorage = fakeStorage;

  const { getPrepaidOrderAttemptStorageKey } = require('../frontend/src/lib/order-attempt');
  const POSPage = require('../frontend/src/app/(dashboard)/pos/page').default;

  resetPOSHooks();
  capturedCartPanelProps = null;
  capturedPrepaidModalProps = null;

  // 1. Sign in as owner
  useAuthStore.setState({
    user: { id: 'owner-1', name: 'Alice Owner', email: 'owner@test.local', role: 'owner' },
    token: 'token-for-owner-1',
    isLocked: false,
  });
  useCartStore.getState().clearCart();
  useCartStore.getState().addItem(
    {
      id: 'prod-1',
      name: 'Coffee',
      price: 100,
      category_id: 'cat-1',
      is_available: 1,
    } as any,
    1,
  );

  let tree = renderPOSPage(POSPage);
  const cartPanelEl = findElement(tree, CartPanelStub);
  assertOrThrow(cartPanelEl, 'CartPanel element found in render tree');
  assertOrThrow(
    typeof cartPanelEl.props?.onPlaceOrder === 'function',
    'CartPanel onPlaceOrder is a function',
  );

  // Trigger place order to open prepaid checkout modal
  cartPanelEl.props.onPlaceOrder();
  tree = renderPOSPage(POSPage);
  const prepaidModalEl = findElement(tree, PrepaidCheckoutModalStub);
  assertOrThrow(prepaidModalEl, 'PrepaidCheckoutModal element found in render tree');
  assertOrThrow(
    typeof prepaidModalEl.props?.onConfirm === 'function',
    'PrepaidCheckoutModal onConfirm is a function',
  );

  const handlePrepaidCheckout = prepaidModalEl.props.onConfirm;

  let ordersDeferredResolve!: (val: any) => void;
  const ordersPromise = new Promise((resolve) => {
    ordersDeferredResolve = resolve;
  });
  const checkoutCalls: Array<{ url: string; body?: any; headers?: any }> = [];
  mockApiHandler = {
    post: async (url: string, body?: any, config?: any) => {
      checkoutCalls.push({ url, body, headers: config?.headers });
      if (url === '/orders') {
        return ordersPromise;
      }
      if (url === '/bills/generate') {
        return { data: { bill: { id: 'bill-1', payment_status: 'unpaid' } } };
      }
      if (url.includes('/payments')) {
        return { data: { bill: { id: 'bill-1', payment_status: 'paid' } } };
      }
      return { data: {} };
    },
    get: async () => ({ data: {} }),
  };

  // 2. Trigger prepaid checkout (starts /orders call and holds)
  const checkoutPromise = handlePrepaidCheckout([{ method: 'cash', amount: 100 }], 0, null);

  // Allow promise tick so api.post('/orders') executes
  await new Promise((r) => setTimeout(r, 15));

  // 3. While /orders is held, lock and switch to manager
  useAuthStore.setState({
    user: null,
    token: null,
    isLocked: true,
  });
  useAuthStore.setState({
    user: { id: 'mgr-1', name: 'Bob Manager', email: 'manager@test.local', role: 'manager' },
    token: 'token-for-mgr-1',
    isLocked: false,
  });
  useCartStore.getState().clearCart();
  useCartStore.getState().addItem(
    {
      id: 'prod-2',
      name: 'Tea',
      price: 50,
      category_id: 'cat-1',
      is_available: 1,
    } as any,
    1,
  );

  // Re-render to propagate session switch
  renderPOSPage(POSPage);

  // 4. Release /orders response
  ordersDeferredResolve({ data: { order: { id: 'order-123', order_number: 'ORD-123' } } });
  await checkoutPromise;

  // 5. Assertions under manager
  const billOrPayCalls = checkoutCalls.filter(
    (c) => c.url === '/bills/generate' || c.url.includes('/payments'),
  );
  assertEqualOrThrow(
    billOrPayCalls.length,
    0,
    'No bill generation or payment calls executed under manager session',
  );

  const mgrCartItems = useCartStore.getState().items;
  assertEqualOrThrow(mgrCartItems.length, 1, 'Manager cart has 1 item');
  assertEqualOrThrow(mgrCartItems[0].product.id, 'prod-2', 'Manager cart item is Tea');

  const ownerKey = getPrepaidOrderAttemptStorageKey('owner-1');
  const ownerSavedRaw = fakeStorage.getItem(ownerKey);
  assertOrThrow(ownerSavedRaw, 'Owner recovery state exists in storage under owner key');
  const ownerSaved = JSON.parse(ownerSavedRaw!);
  assertEqualOrThrow(
    ownerSaved?.order?.id,
    'order-123',
    'Owner recovery state preserved with created order id',
  );

  // 6. Switch back to owner-1 and verify owner recovery state is preserved
  useAuthStore.setState({
    user: null,
    token: null,
    isLocked: true,
  });
  useAuthStore.setState({
    user: { id: 'owner-1', name: 'Alice Owner', email: 'owner@test.local', role: 'owner' },
    token: 'token-for-owner-1',
    isLocked: false,
  });
  renderPOSPage(POSPage);

  const ownerRestored = JSON.parse(fakeStorage.getItem(ownerKey)!);
  assertEqualOrThrow(
    ownerRestored?.order?.id,
    'order-123',
    'Owner recovery record preserved after switching back to owner',
  );

  // ── 9. Cart isolation across user switches ──
  console.log(
    '\n9. Cart isolation: in-flight response resolution under !isSessionCurrent() clears untouched cart while subsequent orders can be placed normally',
  );

  // Sign in as owner again
  useAuthStore.setState({
    user: { id: 'owner-1', name: 'Alice Owner', email: 'owner@test.local', role: 'owner' },
    token: 'token-for-owner-1',
    isLocked: false,
  });
  useCartStore.getState().clearCart();
  useCartStore.getState().addItem(
    {
      id: 'prod-latte',
      name: 'Latte',
      price: 120,
      category_id: 'cat-1',
      is_available: 1,
    } as any,
    1,
  );

  resetPOSHooks();
  capturedCartPanelProps = null;
  capturedPrepaidModalProps = null;
  tree = renderPOSPage(POSPage);

  let p2CartPanel = findElement(tree, CartPanelStub);
  p2CartPanel.props.onPlaceOrder();
  tree = renderPOSPage(POSPage);
  const p2PrepaidModal = findElement(tree, PrepaidCheckoutModalStub);

  let p2OrdersDeferredResolve!: (val: any) => void;
  const p2OrdersPromise = new Promise((resolve) => {
    p2OrdersDeferredResolve = resolve;
  });
  const p2Calls: Array<{ url: string; body?: any }> = [];
  mockApiHandler = {
    post: async (url: string, body?: any) => {
      p2Calls.push({ url, body });
      if (url === '/orders') return p2OrdersPromise;
      if (url === '/bills/generate')
        return { data: { bill: { id: 'bill-2', payment_status: 'unpaid' } } };
      if (url.includes('/payments'))
        return { data: { bill: { id: 'bill-2', payment_status: 'paid' } } };
      return { data: {} };
    },
    get: async () => ({ data: {} }),
  };

  const p2CheckoutPromise = p2PrepaidModal.props.onConfirm(
    [{ method: 'cash', amount: 120 }],
    0,
    null,
  );
  await new Promise((r) => setTimeout(r, 15));

  // User switches to manager while in-flight, but manager DOES NOT touch the cart
  useAuthStore.setState({
    user: null,
    token: null,
    isLocked: true,
  });
  useAuthStore.setState({
    user: { id: 'mgr-1', name: 'Bob Manager', email: 'manager@test.local', role: 'manager' },
    token: 'token-for-mgr-1',
    isLocked: false,
  });
  renderPOSPage(POSPage);

  // Cart before release still has Latte
  assertEqualOrThrow(useCartStore.getState().items.length, 1, 'Manager starts with untouched cart');

  // Release the in-flight order
  p2OrdersDeferredResolve({
    data: { order: { id: 'order-latte-456', order_number: 'ORD-LATTE-456' } },
  });
  await p2CheckoutPromise;

  // Stale continuation must have safely cleared the matching cart so manager cannot double-charge
  assertEqualOrThrow(
    useCartStore.getState().items.length,
    0,
    'Stale continuation safely cleared matching committed cart after switch',
  );

  // Now, suppose manager re-creates the exact same cart and attempts checkout
  useCartStore.getState().addItem(
    {
      id: 'prod-latte',
      name: 'Latte',
      price: 120,
      category_id: 'cat-1',
      is_available: 1,
    } as any,
    1,
  );
  renderPOSPage(POSPage);
  tree = renderPOSPage(POSPage);
  p2CartPanel = findElement(tree, CartPanelStub);

  // Trigger onPlaceOrder() under manager: subsequent order with identical items can be placed normally
  p2CartPanel.props.onPlaceOrder();
  tree = renderPOSPage(POSPage);
  const managerPrepaidModal = findElement(tree, PrepaidCheckoutModalStub);
  assertOrThrow(
    managerPrepaidModal,
    'Prepaid checkout modal opens for subsequent order with identical items',
  );
  assertEqualOrThrow(
    useCartStore.getState().items.length,
    1,
    'Cart preserved for checkout rather than blocked or cleared',
  );

  const { buildCartFingerprintFromState } = require('../frontend/src/lib/order-attempt');
  const baseCartForFingerprint = {
    tableId: null,
    customerId: null,
    orderType: 'takeaway',
    guestCount: 1,
    orderNotes: null,
    items: [
      {
        product: { id: 'prod-latte', name: 'Latte', price: 120 },
        quantity: 1,
        addons: [],
      },
    ],
    waivedChargeIds: new Set<string>(),
    optedInChargeIds: new Set<string>(),
  };
  const fpImmediate = buildCartFingerprintFromState({
    ...baseCartForFingerprint,
    scheduledFor: '',
  });
  const fpScheduled1 = buildCartFingerprintFromState({
    ...baseCartForFingerprint,
    scheduledFor: '2026-10-30T10:00:00.000Z',
  });
  const fpScheduled2 = buildCartFingerprintFromState({
    ...baseCartForFingerprint,
    scheduledFor: '2026-10-30T11:00:00.000Z',
  });
  assertOrThrow(fpImmediate !== fpScheduled1, 'Immediate and scheduled order fingerprints differ');
  assertOrThrow(
    fpScheduled1 !== fpScheduled2,
    'Different scheduled times yield different fingerprints',
  );

  const fpDineIn1 = buildCartFingerprintFromState({
    ...baseCartForFingerprint,
    orderType: 'dine_in',
    tableId: 't-1',
    scheduledFor: '2026-10-30T10:00:00.000Z',
  });
  const fpDineIn2 = buildCartFingerprintFromState({
    ...baseCartForFingerprint,
    orderType: 'dine_in',
    tableId: 't-1',
    scheduledFor: '',
  });
  assertEqualOrThrow(fpDineIn1, fpDineIn2, 'Dine-in ignores scheduledFor in cart fingerprint');

  useAuthStore.setState({
    user: null,
    token: null,
    isLocked: true,
  });
  useAuthStore.setState({
    user: { id: 'owner-1', name: 'Alice Owner', email: 'owner@test.local', role: 'owner' },
    token: 'token-for-owner-1',
    isLocked: false,
  });
  useCartStore.getState().clearCart();
  useCartStore.getState().addItem(
    {
      id: 'prod-latte',
      name: 'Latte',
      price: 120,
      category_id: 'cat-1',
      is_available: 1,
    } as any,
    1,
  );
  tree = renderPOSPage(POSPage);
  p2CartPanel = findElement(tree, CartPanelStub);
  p2CartPanel.props.onPlaceOrder();
  tree = renderPOSPage(POSPage);
  const recoveredModal = findElement(tree, PrepaidCheckoutModalStub);
  assertOrThrow(
    recoveredModal,
    'Prepaid checkout modal opens for originating user with matching attempt',
  );
  assertEqualOrThrow(
    useCartStore.getState().items.length,
    1,
    'Cart is preserved rather than wiped during prepaid recovery',
  );

  // ── 10. Append continuation and pendingOrder isolation across session switches ──
  console.log(
    '\n10. Append continuation: session switch clears pendingOrder and in-flight append continuation clears cart',
  );

  // 1. Sign in as owner and open scheduled orders drawer
  useAuthStore.setState({
    user: { id: 'owner-1', name: 'Alice Owner', email: 'owner@test.local', role: 'owner' },
    token: 'token-for-owner-1',
    isLocked: false,
  });
  renderPOSPage(POSPage);
  tree = renderPOSPage(POSPage);
  const topbarEl = findElement(tree, PosTopbarStub);
  assertOrThrow(topbarEl, 'PosTopbar element found in render tree');
  topbarEl.props.onShowScheduledOrders();
  tree = renderPOSPage(POSPage);

  const scheduledDrawerEl = findElement(tree, ScheduledOrdersDrawerStub);
  assertOrThrow(scheduledDrawerEl, 'ScheduledOrdersDrawer element found in render tree');
  scheduledDrawerEl.props.onAddItemsToOrder({
    id: 'ord-append-1',
    order_number: 'ORD-APP-001',
    type: 'takeaway',
    status: 'in_progress',
    items: [],
  });
  tree = renderPOSPage(POSPage);
  p2CartPanel = findElement(tree, CartPanelStub);

  // CartPanel now has existingOrder set to the target order
  assertEqualOrThrow(
    p2CartPanel?.props?.existingOrder?.id,
    'ord-append-1',
    'pendingOrder is set on CartPanel before session switch',
  );

  // Add items to append
  useCartStore.getState().clearCart();
  useCartStore.getState().addItem(
    {
      id: 'prod-latte',
      name: 'Latte',
      price: 120,
      category_id: 'cat-1',
      is_available: 1,
      addons: [],
    } as any,
    1,
  );
  tree = renderPOSPage(POSPage);
  p2CartPanel = findElement(tree, CartPanelStub);

  let appendDeferredResolve!: (val: any) => void;
  const appendPromise = new Promise((resolve) => {
    appendDeferredResolve = resolve;
  });
  mockApiHandler = {
    post: async (url: string, body?: any) => {
      if (url.includes('/items')) return appendPromise;
      return { data: {} };
    },
    get: async () => ({ data: {} }),
  };

  const appendCallPromise = p2CartPanel.props.onPlaceOrder();
  await new Promise((r) => setTimeout(r, 15));

  // 2. Switch to manager while append request is in-flight
  useAuthStore.setState({
    user: null,
    token: null,
    isLocked: true,
  });
  useAuthStore.setState({
    user: { id: 'mgr-1', name: 'Bob Manager', email: 'manager@test.local', role: 'manager' },
    token: 'token-for-mgr-1',
    isLocked: false,
  });
  renderPOSPage(POSPage);
  tree = renderPOSPage(POSPage);
  p2CartPanel = findElement(tree, CartPanelStub);

  // Verify: pendingOrder was cleared upon session switch
  assertEqualOrThrow(
    p2CartPanel?.props?.existingOrder,
    null,
    'pendingOrder is cleared when switching session',
  );

  // 3. Resolve the in-flight append call
  appendDeferredResolve({
    data: {
      order: {
        id: 'ord-append-1',
        order_number: 'ORD-APP-001',
        items: [{ id: 1, product_id: 'prod-latte', quantity: 1 }],
      },
    },
  });
  await appendCallPromise;

  // Stale append continuation must have safely cleared the matching cart so new session doesn't double-order
  assertEqualOrThrow(
    useCartStore.getState().items.length,
    0,
    'Stale append continuation safely cleared matching cart after session switch',
  );

  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n✅ All PIN Quick Switch & Approval Hardening tests passed!');
  process.exit(0);
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
