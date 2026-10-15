/**
 * Regression coverage for order-write and item-cancel rate limiting (#1073).
 *
 * Verifies:
 * - 61+ legitimate authenticated local/private order writes and item cancels succeed
 * - IPv4/IPv6 loopback, RFC 1918 private, Tailscale CGNAT, and public IP classification
 * - FLO_ORDER_WRITE_RATE_LIMIT_MAX positive integer parsing and fallback to 60/min
 * - Unauthenticated requests are never bypassed even from private/loopback sockets
 * - Spoofed X-Forwarded-For / Forwarded headers or trust-proxy req.ip overrides are ignored
 * - Public traffic is throttled with the JSON error envelope { error: "Too many requests, please try again later." }
 * - orderWriteRateLimit and orderItemCancelRateLimit remain independent buckets
 * - Manager/owner PIN attempt limits remain enforced on local/private traffic
 *
 * Run: node tests/run-electron-node-test.cjs tests/order-write-rate-limits.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-write-rate-limits-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-write-rate-limits';

const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const {
  orderRoutes,
  resetPinRateLimitForTests,
  resolveOrderWriteRateLimitMax,
  shouldSkipOrderWriteRateLimit,
} = require('../main/routes/orders');

function seedUser(db: any, id: string, role: string, pin?: string) {
  const email = `${id}@test.local`;
  db.prepare(
    `
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `,
  ).run(
    id,
    id,
    email,
    bcrypt.hashSync('testpass123', 10),
    role,
    pin ? bcrypt.hashSync(pin, 10) : null,
    now(),
    now(),
  );
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

function seedPendingOrderWithItem(db: any, suffix: string) {
  db.prepare(
    `INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at)
     VALUES (?, 'takeaway', 'pending', 100, 0, 100, ?, ?)`,
  ).run(`ORD-RL-${suffix}`, now(), now());
  const orderId = (
    db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-RL-${suffix}`) as any
  ).id;
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, 'rl-product', 'RL item', 100, 1, 100, 0, 100, 'pending', ?, ?)`,
  ).run(orderId, now(), now());
  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any)
    .id;
  return { orderId, itemId };
}

function seedPreparingOrderWithItem(db: any, suffix: string) {
  db.prepare(
    `INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at)
     VALUES (?, 'takeaway', 'preparing', 100, 0, 100, ?, ?)`,
  ).run(`ORD-RL-PREP-${suffix}`, now(), now());
  const orderId = (
    db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-RL-PREP-${suffix}`) as any
  ).id;
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
     VALUES (?, 'rl-product', 'RL item', 100, 1, 100, 0, 100, 'preparing', ?, ?)`,
  ).run(orderId, now(), now());
  const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any)
    .id;
  return { orderId, itemId };
}

async function main() {
  console.log('Order-write and item-cancel rate limits (#1073)');
  console.log('='.repeat(60));
  resetCounters();
  resetPinRateLimitForTests();

  const originalEnvLimit = process.env.FLO_ORDER_WRITE_RATE_LIMIT_MAX;
  const db = initTestDb();
  const managerAuth = seedUser(db, 'mgr-rl', 'manager', '1234');
  const serverAuth = seedUser(db, 'srv-rl', 'server');

  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('rl-category', 'RL', 1)`).run();
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
     VALUES ('rl-product', 'rl-category', 'RL item', 100, 'none', 1, 1, ?, ?)`,
  ).run(now(), now());

  const app = express();
  app.use(express.json());
  // Allow tests to simulate socket remoteAddress and req.ip independently of X-Forwarded-For
  app.use((req: any, _res: any, next: any) => {
    const simulatedSocketIp = req.get('x-test-socket-ip');
    if (simulatedSocketIp !== undefined) {
      Object.defineProperty(req.socket, 'remoteAddress', {
        get: () => simulatedSocketIp,
        configurable: true,
      });
      Object.defineProperty(req, 'ip', {
        get: () => simulatedSocketIp,
        configurable: true,
      });
    }
    const simulatedReqIpOnly = req.get('x-test-req-ip-only');
    if (simulatedReqIpOnly !== undefined) {
      Object.defineProperty(req, 'ip', {
        get: () => simulatedReqIpOnly,
        configurable: true,
      });
    }
    next();
  });
  app.use((req: any, res: any, next: any) => {
    if (req.get('x-test-skip-auth') === '1') {
      next();
      return;
    }
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      req.user = jwt.verify(header.slice(7), getJWTSecret());
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  });
  app.use('/api/orders', orderRoutes);

  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n1. FLO_ORDER_WRITE_RATE_LIMIT_MAX configuration parsing');
    assertEqualOrThrow(
      resolveOrderWriteRateLimitMax(undefined),
      60,
      'unset FLO_ORDER_WRITE_RATE_LIMIT_MAX defaults to 60',
    );
    assertEqualOrThrow(
      resolveOrderWriteRateLimitMax(''),
      60,
      'empty FLO_ORDER_WRITE_RATE_LIMIT_MAX defaults to 60',
    );
    assertEqualOrThrow(
      resolveOrderWriteRateLimitMax('0'),
      60,
      'zero FLO_ORDER_WRITE_RATE_LIMIT_MAX falls back to 60',
    );
    assertEqualOrThrow(
      resolveOrderWriteRateLimitMax('-15'),
      60,
      'negative FLO_ORDER_WRITE_RATE_LIMIT_MAX falls back to 60',
    );
    assertEqualOrThrow(
      resolveOrderWriteRateLimitMax('not-a-number'),
      60,
      'non-numeric FLO_ORDER_WRITE_RATE_LIMIT_MAX falls back to 60',
    );
    assertEqualOrThrow(
      resolveOrderWriteRateLimitMax('150'),
      150,
      'positive integer FLO_ORDER_WRITE_RATE_LIMIT_MAX is used',
    );

    console.log('\n2. IPv4/IPv6/private/public classification & auth requirement in skip helper');
    const mockReq = (
      remoteAddress: string | undefined,
      userId?: string,
      reqIp?: string,
      xff?: string,
    ): any => ({
      ip: reqIp ?? remoteAddress,
      headers: xff ? { 'x-forwarded-for': xff } : {},
      socket: { remoteAddress },
      user: userId ? { userId } : undefined,
    });

    for (const privateIp of [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '10.0.0.42',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.25',
      '::ffff:192.168.1.25',
      '100.64.0.1',
      '100.127.255.254',
    ]) {
      assertEqualOrThrow(
        shouldSkipOrderWriteRateLimit(mockReq(privateIp, 'user-1')),
        true,
        `authenticated request from private/local IP ${privateIp} is exempt`,
      );
      assertEqualOrThrow(
        shouldSkipOrderWriteRateLimit(mockReq(privateIp, undefined)),
        false,
        `unauthenticated request from private/local IP ${privateIp} is NOT exempt`,
      );
    }

    for (const nonExemptIp of [
      '8.8.8.8',
      '::ffff:8.8.8.8',
      '2001:4860:4860::8888',
      'fe80::1',
      'fc00::1',
      '100.63.255.255',
      '100.128.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '',
      undefined,
    ]) {
      assertEqualOrThrow(
        shouldSkipOrderWriteRateLimit(mockReq(nonExemptIp, 'user-1')),
        false,
        `authenticated request from public/invalid IP ${String(nonExemptIp)} is NOT exempt`,
      );
    }

    assertEqualOrThrow(
      shouldSkipOrderWriteRateLimit(mockReq('8.8.8.8', 'user-1', '127.0.0.1', '127.0.0.1')),
      false,
      'spoofed X-Forwarded-For or overridden req.ip does not exempt a public socket',
    );

    console.log('\n3. 61+ legitimate authenticated local order writes and item cancels succeed');
    delete process.env.FLO_ORDER_WRITE_RATE_LIMIT_MAX;
    for (let i = 0; i < 65; i++) {
      const res = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: serverAuth,
        body: {
          type: 'takeaway',
          items: [{ product_id: 'rl-product', quantity: 1 }],
        },
      });
      if (i === 0 || i === 60 || i === 64) {
        assertEqualOrThrow(
          res.status,
          201,
          `authenticated local POST /api/orders #${i + 1} succeeds with 201`,
        );
      } else if (res.status !== 201) {
        assertEqualOrThrow(
          res.status,
          201,
          `authenticated local POST /api/orders #${i + 1} succeeds with 201`,
        );
      }
    }

    for (let i = 0; i < 62; i++) {
      const { orderId, itemId } = seedPendingOrderWithItem(db, `LOCAL-CANCEL-${i}`);
      const res = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/cancel`, {
        method: 'PATCH',
        headers: managerAuth,
        body: { reason: 'burst test' },
      });
      if (i === 0 || i === 60 || i === 61 || res.status !== 200) {
        assertEqualOrThrow(
          res.status,
          200,
          `authenticated local PATCH .../cancel #${i + 1} succeeds with 200`,
        );
      }
    }

    console.log(
      '\n4. Public traffic is limited per FLO_ORDER_WRITE_RATE_LIMIT_MAX, buckets stay separate, and 429 returns JSON error envelope',
    );
    process.env.FLO_ORDER_WRITE_RATE_LIMIT_MAX = '2';

    const publicHeaders = {
      ...serverAuth,
      'x-test-socket-ip': '203.0.113.10',
    };
    const pubWrite1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: publicHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    assertEqualOrThrow(pubWrite1.status, 201, 'public order write #1 under limit (2) succeeds');

    const pubWrite2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: publicHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    assertEqualOrThrow(pubWrite2.status, 201, 'public order write #2 at limit (2) succeeds');

    const pubWrite3 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: publicHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    assertEqualOrThrow(pubWrite3.status, 429, 'public order write #3 over limit (2) returns 429');
    assertEqualOrThrow(
      pubWrite3.data?.error,
      'Too many requests, please try again later.',
      '429 on orderWriteRateLimit returns established JSON error envelope',
    );

    // Exhausting orderWriteRateLimit for 203.0.113.10 must NOT exhaust orderItemCancelRateLimit
    const publicManagerHeaders = {
      ...managerAuth,
      'x-test-socket-ip': '203.0.113.10',
    };
    const cancel1 = seedPendingOrderWithItem(db, 'PUB-CANCEL-1');
    const pubCancel1 = await api(
      baseUrl,
      `/api/orders/${cancel1.orderId}/items/${cancel1.itemId}/cancel`,
      {
        method: 'PATCH',
        headers: publicManagerHeaders,
        body: { reason: 'public cancel 1' },
      },
    );
    assertEqualOrThrow(
      pubCancel1.status,
      200,
      'item-cancel bucket is independent from exhausted order-write bucket (#1 succeeds)',
    );

    const cancel2 = seedPendingOrderWithItem(db, 'PUB-CANCEL-2');
    const pubCancel2 = await api(
      baseUrl,
      `/api/orders/${cancel2.orderId}/items/${cancel2.itemId}/cancel`,
      {
        method: 'PATCH',
        headers: publicManagerHeaders,
        body: { reason: 'public cancel 2' },
      },
    );
    assertEqualOrThrow(pubCancel2.status, 200, 'public item cancel #2 at limit (2) succeeds');

    const cancel3 = seedPendingOrderWithItem(db, 'PUB-CANCEL-3');
    const pubCancel3 = await api(
      baseUrl,
      `/api/orders/${cancel3.orderId}/items/${cancel3.itemId}/cancel`,
      {
        method: 'PATCH',
        headers: publicManagerHeaders,
        body: { reason: 'public cancel 3' },
      },
    );
    assertEqualOrThrow(pubCancel3.status, 429, 'public item cancel #3 over limit (2) returns 429');
    assertEqualOrThrow(
      pubCancel3.data?.error,
      'Too many requests, please try again later.',
      '429 on orderItemCancelRateLimit returns established JSON error envelope',
    );

    console.log('\n5. Spoofed forwarding headers and unauthenticated requests are not bypassed');
    const spoofedXffHeaders = {
      ...serverAuth,
      'x-test-socket-ip': '198.51.100.77',
      'X-Forwarded-For': '127.0.0.1',
      Forwarded: 'for=127.0.0.1',
    };
    const spoofXff1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: spoofedXffHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    const spoofXff2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: spoofedXffHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    const spoofXff3 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: spoofedXffHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    assertEqualOrThrow(spoofXff1.status, 201, 'spoofed X-Forwarded-For request #1 succeeds');
    assertEqualOrThrow(spoofXff2.status, 201, 'spoofed X-Forwarded-For request #2 succeeds');
    assertEqualOrThrow(
      spoofXff3.status,
      429,
      'spoofed X-Forwarded-For / Forwarded headers do not bypass rate limit on public socket',
    );

    const spoofedReqIpHeaders = {
      ...serverAuth,
      'x-test-socket-ip': '198.51.100.88',
      'x-test-req-ip-only': '10.0.0.99',
    };
    const spoof1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: spoofedReqIpHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    const spoof2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: spoofedReqIpHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    const spoof3 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: spoofedReqIpHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    assertEqualOrThrow(spoof1.status, 201, 'spoofed req.ip request #1 succeeds');
    assertEqualOrThrow(spoof2.status, 201, 'spoofed req.ip request #2 succeeds');
    assertEqualOrThrow(
      spoof3.status,
      429,
      'spoofed req.ip does not bypass rate limit when socket remoteAddress is public',
    );

    // Unauthenticated request reaching the router on loopback is still rate-limited
    const unauthHeaders = {
      'x-test-skip-auth': '1',
      'x-test-socket-ip': '127.0.0.1',
    };
    const unauth1 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: unauthHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    const unauth2 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: unauthHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    const unauth3 = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: unauthHeaders,
      body: { type: 'takeaway', items: [{ product_id: 'rl-product', quantity: 1 }] },
    });
    assertEqualOrThrow(
      unauth1.status,
      401,
      'unauthenticated loopback request #1 is rejected by permission gate (401)',
    );
    assertEqualOrThrow(
      unauth2.status,
      401,
      'unauthenticated loopback request #2 is rejected by permission gate (401)',
    );
    assertEqualOrThrow(
      unauth3.status,
      429,
      'unauthenticated loopback request #3 is throttled by orderWriteRateLimit (429)',
    );

    console.log('\n6. PIN guessing remains rate-limited on authenticated local traffic');
    delete process.env.FLO_ORDER_WRITE_RATE_LIMIT_MAX;
    resetPinRateLimitForTests();
    const prep = seedPreparingOrderWithItem(db, 'PIN-LOCAL');
    for (let i = 0; i < 5; i++) {
      const res = await api(baseUrl, `/api/orders/${prep.orderId}/status`, {
        method: 'PATCH',
        headers: managerAuth,
        body: { status: 'cancelled', override_pin: '9999' },
      });
      assertEqualOrThrow(res.status, 403, `local wrong PIN attempt #${i + 1} returns 403`);
    }
    const pinLocked = await api(baseUrl, `/api/orders/${prep.orderId}/status`, {
      method: 'PATCH',
      headers: managerAuth,
      body: { status: 'cancelled', override_pin: '1234' },
    });
    assertEqualOrThrow(
      pinLocked.status,
      429,
      '6th PIN attempt on local traffic is still throttled by PIN limiter (429)',
    );
    assertIncludesOrThrow(
      pinLocked.data?.error || '',
      'Too many PIN attempts',
      'PIN limiter error message is preserved',
    );
  } finally {
    if (originalEnvLimit === undefined) {
      delete process.env.FLO_ORDER_WRITE_RATE_LIMIT_MAX;
    } else {
      process.env.FLO_ORDER_WRITE_RATE_LIMIT_MAX = originalEnvLimit;
    }
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  if (results.failed > 0) {
    console.error(`${results.failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\n✅ All order-write rate-limit tests passed');
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
