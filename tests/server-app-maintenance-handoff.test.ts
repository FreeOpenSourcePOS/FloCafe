/**
 * Regression and integration tests for FloCafe Issue #1174:
 * Server App loopback proxy admission reservation handoff and maintenance synchronization.
 */
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-server-app-handoff-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function getFreeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('Test: Server App loopback proxy maintenance admission handoff');
  console.log('='.repeat(60));

  const {
    databaseMaintenanceMiddleware,
    createDatabaseMaintenanceHandoff,
    consumeDatabaseMaintenanceHandoff,
    revokeDatabaseMaintenanceHandoff,
    withDatabaseMaintenanceLock,
    getActiveDatabaseRequestsCount,
    initDatabase,
    getDatabase,
    closeDatabase,
    now,
  } = await import('../main/db');

  // --- Part 1: Unit & Middleware Tests ---
  console.log('[1/5] Testing admission reservation refcounting and loopback handoff...');

  const initialCount = getActiveDatabaseRequestsCount();
  assert.equal(initialCount, 0, 'initial activeDatabaseRequests must be 0');

  // 1a. Normal single admission releases on finish
  {
    const fakeRes = new EventEmitter() as any;
    fakeRes.status = () => fakeRes;
    fakeRes.json = () => fakeRes;
    let nextCalled = false;
    databaseMaintenanceMiddleware(
      {
        baseUrl: '',
        path: '/api/orders',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as any,
      fakeRes,
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true, 'normal request enters middleware');
    assert.equal(getActiveDatabaseRequestsCount(), 1, 'active count incremented to 1');
    fakeRes.emit('finish');
    assert.equal(
      getActiveDatabaseRequestsCount(),
      0,
      'active count decremented back to 0 on finish',
    );
  }

  // 1b. Direct request rejected with 503 during maintenance
  {
    let maintenanceRan = false;
    const maintenancePromise = withDatabaseMaintenanceLock(async () => {
      maintenanceRan = true;
      const fakeRes = new EventEmitter() as any;
      let statusCode = 0;
      let body: any = null;
      fakeRes.status = (code: number) => {
        statusCode = code;
        return fakeRes;
      };
      fakeRes.json = (b: any) => {
        body = b;
        return fakeRes;
      };

      let nextCalled = false;
      databaseMaintenanceMiddleware(
        {
          baseUrl: '',
          path: '/api/orders',
          headers: {},
          socket: { remoteAddress: '127.0.0.1' },
        } as any,
        fakeRes,
        () => {
          nextCalled = true;
        },
      );
      assert.equal(nextCalled, false, 'direct request blocked during maintenance');
      assert.equal(statusCode, 503, 'returns 503');
      assert.equal(body?.error, 'Database maintenance in progress', 'correct error message');
      await delay(10);
    });

    await maintenancePromise;
    assert.equal(maintenanceRan, true, 'maintenance lock completed');
    assert.equal(getActiveDatabaseRequestsCount(), 0, 'active count is 0');
  }

  // 1c. Trusted loopback handoff bypasses 503 and shares single reservation
  {
    // Outer request arrives at Server App (:3003)
    const outerRes = new EventEmitter() as any;
    outerRes.status = () => outerRes;
    outerRes.json = () => outerRes;
    let outerReq: any = {
      baseUrl: '',
      path: '/api/orders',
      headers: {},
      socket: { remoteAddress: '192.168.1.50' }, // client from LAN
    };
    let outerNextCalled = false;
    databaseMaintenanceMiddleware(outerReq, outerRes, () => {
      outerNextCalled = true;
    });
    assert.equal(outerNextCalled, true, 'outer request admitted');
    assert.equal(getActiveDatabaseRequestsCount(), 1, 'outer request increments active count to 1');

    const reservation = outerReq.databaseAdmissionReservation;
    assert(reservation, 'outer request has databaseAdmissionReservation');

    // Create handoff ticket for loopback forwarding
    const ticket = createDatabaseMaintenanceHandoff(reservation);
    assert.equal(typeof ticket, 'string', 'handoff ticket is a valid string');

    // Maintenance begins in the background after outer admission
    let maintenanceStarted = false;
    let maintenanceFinished = false;
    const maintenancePromise = withDatabaseMaintenanceLock(async () => {
      maintenanceStarted = true;
      await delay(20);
      maintenanceFinished = true;
    });

    // Give maintenance event loop turn to set databaseMaintenanceActive = true and wait for active count
    await delay(10);
    assert.equal(
      maintenanceStarted,
      false,
      'maintenance is paused waiting for active requests to drain',
    );

    // Downstream hop: loopback fetch arrives at Main API (:3001) carrying handoff ticket
    const innerRes = new EventEmitter() as any;
    innerRes.status = () => innerRes;
    innerRes.json = () => innerRes;
    const innerReq: any = {
      baseUrl: '',
      path: '/api/orders',
      headers: { 'x-flo-maintenance-handoff': ticket },
      socket: { remoteAddress: '127.0.0.1' }, // loopback hop
    };
    let innerNextCalled = false;
    databaseMaintenanceMiddleware(innerReq, innerRes, () => {
      innerNextCalled = true;
    });

    assert.equal(
      innerNextCalled,
      true,
      'proxied request is admitted via handoff even during maintenance',
    );
    assert.equal(
      getActiveDatabaseRequestsCount(),
      1,
      'active count is NOT double-counted (still 1)',
    );

    // Inner response finishes
    innerRes.emit('finish');
    assert.equal(
      getActiveDatabaseRequestsCount(),
      1,
      'count remains held while outer response is still open',
    );
    assert.equal(maintenanceStarted, false, 'maintenance still waits for outer response');

    // Outer response finishes
    outerRes.emit('finish');
    assert.equal(getActiveDatabaseRequestsCount(), 0, 'count drops to 0 after both layers finish');

    // Now maintenance can proceed and complete
    await maintenancePromise;
    assert.equal(maintenanceFinished, true, 'maintenance finished cleanly after drain');
  }

  // --- Part 2: Security & Untrusted Input Tests ---
  console.log('[2/5] Testing untrusted, forged, replayed, and revoked handoff tickets...');

  // 2a. External LAN client presenting handoff ticket must be rejected during maintenance
  {
    const fakeRes = new EventEmitter() as any;
    let statusCode = 0;
    fakeRes.status = (c: number) => {
      statusCode = c;
      return fakeRes;
    };
    fakeRes.json = () => fakeRes;

    const dummyReservation = { retain: () => true, release: () => {}, isReleased: () => false };
    const validTicket = createDatabaseMaintenanceHandoff(dummyReservation as any);
    assert(validTicket, 'valid ticket created');

    await withDatabaseMaintenanceLock(async () => {
      let nextCalled = false;
      databaseMaintenanceMiddleware(
        {
          baseUrl: '',
          path: '/api/orders',
          headers: { 'x-flo-maintenance-handoff': validTicket },
          socket: { remoteAddress: '192.168.1.100' }, // NON-LOOPBACK!
        } as any,
        fakeRes,
        () => {
          nextCalled = true;
        },
      );
      assert.equal(nextCalled, false, 'LAN request cannot use handoff header');
      assert.equal(statusCode, 503, 'rejected with 503');
    });

    // Clean up dummy ticket
    revokeDatabaseMaintenanceHandoff(validTicket);
  }

  // 2b. Forged non-existent ticket from loopback is rejected during maintenance
  {
    const fakeRes = new EventEmitter() as any;
    let statusCode = 0;
    fakeRes.status = (c: number) => {
      statusCode = c;
      return fakeRes;
    };
    fakeRes.json = () => fakeRes;

    await withDatabaseMaintenanceLock(async () => {
      let nextCalled = false;
      databaseMaintenanceMiddleware(
        {
          baseUrl: '',
          path: '/api/orders',
          headers: { 'x-flo-maintenance-handoff': 'completely-forged-ticket-1234' },
          socket: { remoteAddress: '127.0.0.1' },
        } as any,
        fakeRes,
        () => {
          nextCalled = true;
        },
      );
      assert.equal(nextCalled, false, 'forged ticket rejected');
      assert.equal(statusCode, 503, 'rejected with 503');
    });
  }

  // 2c. Replayed ticket is rejected (single use consumption)
  {
    const dummyReservation = { retain: () => true, release: () => {}, isReleased: () => false };
    const ticket = createDatabaseMaintenanceHandoff(dummyReservation as any);
    assert(ticket, 'ticket issued');
    const consumed1 = consumeDatabaseMaintenanceHandoff(ticket);
    assert.equal(consumed1, dummyReservation, 'first consumption succeeds');
    const consumed2 = consumeDatabaseMaintenanceHandoff(ticket);
    assert.equal(consumed2, null, 'second consumption fails (replay protection)');
  }

  // 2d. Explicit revocation prevents consumption
  {
    const dummyReservation = { retain: () => true, release: () => {}, isReleased: () => false };
    const ticket = createDatabaseMaintenanceHandoff(dummyReservation as any);
    assert(ticket, 'ticket issued');
    revokeDatabaseMaintenanceHandoff(ticket);
    const consumed = consumeDatabaseMaintenanceHandoff(ticket);
    assert.equal(consumed, null, 'revoked ticket cannot be consumed');
  }

  // --- Part 3: Client Disconnect & Socket Close Resilience ---
  console.log('[3/5] Testing premature socket close and disconnect handling...');

  {
    // Outer request admitted
    const outerRes = new EventEmitter() as any;
    outerRes.status = () => outerRes;
    outerRes.json = () => outerRes;
    const outerReq: any = {
      baseUrl: '',
      path: '/api/orders',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    databaseMaintenanceMiddleware(outerReq, outerRes, () => {});
    const reservation = outerReq.databaseAdmissionReservation;
    const ticket = createDatabaseMaintenanceHandoff(reservation);
    assert(ticket, 'ticket created');

    // Inner request admitted
    const innerRes = new EventEmitter() as any;
    innerRes.status = () => innerRes;
    innerRes.json = () => innerRes;
    const innerReq: any = {
      baseUrl: '',
      path: '/api/orders',
      headers: { 'x-flo-maintenance-handoff': ticket },
      socket: { remoteAddress: '127.0.0.1' },
    };
    databaseMaintenanceMiddleware(innerReq, innerRes, () => {});

    assert.equal(getActiveDatabaseRequestsCount(), 1, 'count is 1');

    // Outer client disconnects abruptly before inner finishes
    outerRes.emit('close');
    assert.equal(
      getActiveDatabaseRequestsCount(),
      1,
      'count remains held while inner is still working',
    );

    // Inner completes and closes
    innerRes.emit('close');
    assert.equal(getActiveDatabaseRequestsCount(), 0, 'count cleanly drops to 0 after both close');
  }

  // 3b. Outer client disconnects BEFORE inner request is admitted: ticket hold prevents maintenance race
  {
    const outerRes = new EventEmitter() as any;
    outerRes.status = () => outerRes;
    outerRes.json = () => outerRes;
    const outerReq: any = {
      baseUrl: '',
      path: '/api/orders',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    databaseMaintenanceMiddleware(outerReq, outerRes, () => {});
    const reservation = outerReq.databaseAdmissionReservation;
    const ticket = createDatabaseMaintenanceHandoff(reservation);
    assert(ticket, 'ticket issued');
    assert.equal(getActiveDatabaseRequestsCount(), 1, 'count is 1');

    // Outer client socket disconnects BEFORE inner hop arrives at Main API
    outerRes.emit('close');
    // Ticket retains active count so maintenance cannot sneak in!
    assert.equal(
      getActiveDatabaseRequestsCount(),
      1,
      'count remains held by pending ticket despite outer disconnect',
    );

    let maintRan = false;
    const maintPromise = withDatabaseMaintenanceLock(async () => {
      maintRan = true;
    });
    await delay(10);
    assert.equal(maintRan, false, 'maintenance blocked while pending ticket holds reservation');

    // Now inner hop arrives with ticket
    const innerRes = new EventEmitter() as any;
    innerRes.status = () => innerRes;
    innerRes.json = () => innerRes;
    const innerReq: any = {
      baseUrl: '',
      path: '/api/orders',
      headers: { 'x-flo-maintenance-handoff': ticket },
      socket: { remoteAddress: '127.0.0.1' },
    };
    let innerAdmitted = false;
    databaseMaintenanceMiddleware(innerReq, innerRes, () => {
      innerAdmitted = true;
    });
    assert.equal(innerAdmitted, true, 'inner admitted via held ticket');
    assert.equal(maintRan, false, 'maintenance still blocked while inner processes');

    // Inner completes
    innerRes.emit('finish');
    assert.equal(getActiveDatabaseRequestsCount(), 0, 'count drops to 0');
    await maintPromise;
    assert.equal(maintRan, true, 'maintenance ran only after inner finished');
  }

  // 3c. Outer disconnects and ticket is never consumed: revocation releases the hold
  {
    const outerRes = new EventEmitter() as any;
    outerRes.status = () => outerRes;
    outerRes.json = () => outerRes;
    const outerReq: any = {
      baseUrl: '',
      path: '/api/orders',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    databaseMaintenanceMiddleware(outerReq, outerRes, () => {});
    const reservation = outerReq.databaseAdmissionReservation;
    const ticket = createDatabaseMaintenanceHandoff(reservation)!;
    outerRes.emit('close');
    assert.equal(getActiveDatabaseRequestsCount(), 1, 'count held by pending ticket');

    // Forwarding failed / canceled; revoke ticket
    revokeDatabaseMaintenanceHandoff(ticket);
    assert.equal(getActiveDatabaseRequestsCount(), 0, 'count drops to 0 after ticket revoked');
  }

  // --- Part 4: Deterministic Two-Server Integration Test ---
  console.log('[4/5] Testing live Main API (:3001) and Server App (:3003) production stack...');

  const mainPort = await getFreeTcpPort();
  const kdsPort = await getFreeTcpPort();
  const serverAppPort = await getFreeTcpPort();

  process.env.PORT = String(mainPort);
  process.env.KDS_PORT = String(kdsPort);
  process.env.SERVER_APP_PORT = String(serverAppPort);

  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');
  const { clearInMemoryRevokedTokens } = await import('../main/middleware/security');
  const { getJWTSecret } = await import('../main/security/jwt-secret');
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  const { startKdsServer, stopKdsServer } = await import('../main/kds-server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');

  initDatabase();
  const db = getDatabase();
  const passwordHash = bcrypt.hashSync('ServerPass123!', 10);

  const setSetting = (key: string, value: string) =>
    db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);

  setSetting('country', 'US');
  setSetting('currency', 'USD');
  setSetting('currency_symbol', '$');

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    'user-waiter-1',
    'Waiter One',
    'waiter@flocafe.test',
    passwordHash,
    'server',
    now(),
    now(),
  );

  await startServer();
  await startKdsServer();
  await startServerApp();

  try {
    const waiterToken = jwt.sign(
      { userId: 'user-waiter-1', email: 'waiter@flocafe.test', role: 'server' },
      getJWTSecret(),
      { expiresIn: '1h' },
    );

    // 4a. Verify normal forwarded request from Server App to Main API
    const serverAppBase = `http://127.0.0.1:${serverAppPort}`;
    const mainApiBase = `http://127.0.0.1:${mainPort}`;

    const infoRes = await fetch(`${serverAppBase}/api/server-app/info`);
    assert.equal(infoRes.status, 200, 'direct Server App endpoint works');

    const proxiedRes = await fetch(`${serverAppBase}/api/tables`, {
      headers: { Authorization: `Bearer ${waiterToken}` },
    });
    assert.equal(
      proxiedRes.status,
      200,
      'proxied /api/tables succeeds through Server App to Main API',
    );

    // 4b. Deterministic race: Maintenance starts while proxied request is in flight between Server App and Main API
    console.log('[5/5] Testing deterministic maintenance lock across two live servers...');

    const originalFetch = globalThis.fetch;
    let interceptedHop = false;
    let maintenanceStarted = false;
    let maintenanceFinished = false;
    let maintenancePromise: Promise<string> | null = null;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!interceptedHop && url.includes(`:${mainPort}/api/tables`)) {
        interceptedHop = true;
        // Verify handoff header is present in the outgoing hop
        const headers = init?.headers as Record<string, string> | undefined;
        assert(
          headers && headers['x-flo-maintenance-handoff'],
          'loopback forward hop must carry x-flo-maintenance-handoff header',
        );

        // Start maintenance lock right now!
        // At this point, Server App has already admitted the request (active count = 1).
        // Maintenance sets databaseMaintenanceActive = true and pauses in waitForActiveDatabaseRequests.
        maintenancePromise = withDatabaseMaintenanceLock(async () => {
          maintenanceStarted = true;
          await delay(30);
          maintenanceFinished = true;
          return 'maintenance_ok';
        });

        // Yield so maintenance lock can set databaseMaintenanceActive = true
        await delay(10);
        assert.equal(
          maintenanceStarted,
          false,
          'maintenance is waiting for in-flight request to drain',
        );

        // Now let the HTTP request reach Main API while databaseMaintenanceActive is true!
        const upstreamResponse = await originalFetch(input, init);
        return upstreamResponse;
      }
      return originalFetch(input, init);
    };

    try {
      const raceRes = await fetch(`${serverAppBase}/api/tables`, {
        headers: { Authorization: `Bearer ${waiterToken}` },
      });
      assert.equal(
        raceRes.status,
        200,
        'forwarded request succeeded with 200 despite mid-flight maintenance',
      );
      assert(maintenancePromise, 'maintenance lock was triggered during hop');
      const maintResult = await maintenancePromise;
      assert.equal(
        maintResult,
        'maintenance_ok',
        'maintenance lock completed after request drained',
      );
      assert.equal(maintenanceFinished, true, 'maintenance finished cleanly');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 4c. Deterministic race: Maintenance starts AFTER BOTH Server App and Main API have admitted the request
    console.log(
      'Testing deterministic maintenance lock started after both 3003 and 3001 admissions...',
    );
    let bothAdmittedHop = false;
    let bothMaintStarted = false;
    let bothMaintFinished = false;
    let bothMaintPromise: Promise<string> | null = null;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!bothAdmittedHop && url.includes(`:${mainPort}/api/tables`)) {
        bothAdmittedHop = true;
        // Call originalFetch: reaches Main API, which admits via handoff token
        const upstreamResponse = await originalFetch(input, init);

        // At this point, BOTH 3003 and 3001 have admitted the request!
        // Start maintenance lock right now
        bothMaintPromise = withDatabaseMaintenanceLock(async () => {
          bothMaintStarted = true;
          await delay(20);
          bothMaintFinished = true;
          return 'both_maint_ok';
        });

        // Wrap arrayBuffer() to pause and assert maintenance is waiting while Server App response is buffered
        const origArrayBuffer = upstreamResponse.arrayBuffer.bind(upstreamResponse);
        upstreamResponse.arrayBuffer = async () => {
          await delay(15);
          assert.equal(
            bothMaintStarted,
            false,
            'maintenance must wait while Server App response streaming finishes',
          );
          return origArrayBuffer();
        };

        return upstreamResponse;
      }
      return originalFetch(input, init);
    };

    try {
      const bothRes = await fetch(`${serverAppBase}/api/tables`, {
        headers: { Authorization: `Bearer ${waiterToken}` },
      });
      assert.equal(bothRes.status, 200, 'proxied request succeeded with 200');
      assert(bothMaintPromise, 'maintenance lock was triggered after both admissions');
      const bothResult = await bothMaintPromise;
      assert.equal(bothResult, 'both_maint_ok', 'maintenance completed after request drained');
      assert.equal(bothMaintFinished, true, 'maintenance finished cleanly');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Verify direct requests to both servers are rejected during active maintenance
    let directServerAppBlocked = false;
    let directMainApiBlocked = false;

    await withDatabaseMaintenanceLock(async () => {
      const sAppRes = await fetch(`${serverAppBase}/api/server-app/info`);
      directServerAppBlocked = sAppRes.status === 503;

      const mainRes = await fetch(`${mainApiBase}/api/tables`, {
        headers: { Authorization: `Bearer ${waiterToken}` },
      });
      directMainApiBlocked = mainRes.status === 503;
    });

    assert.equal(
      directServerAppBlocked,
      true,
      'direct Server App request blocked with 503 during maintenance',
    );
    assert.equal(
      directMainApiBlocked,
      true,
      'direct Main API request blocked with 503 during maintenance',
    );
  } finally {
    // Cleanup servers and DB
    await stopServerApp();
    await stopKdsServer();
    await stopServer();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  console.log('='.repeat(60));
  console.log('All Server App maintenance handoff tests passed successfully!');
}

run().catch((error) => {
  console.error('Test failed with error:', error);
  process.exit(1);
});
