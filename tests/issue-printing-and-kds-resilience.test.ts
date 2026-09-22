/**
 * Issue: printing and KDS resilience (web-print-once, phase-aware-timeout, kds-zombie-eviction, kds-close-throw-guard)
 *
 * web-print-once: printWebBill can call window.print() twice when both the poll timer
 *      and onload invoke triggerPrint after the first settle.
 * phase-aware-timeout: printViaNetwork timeout always reports "connecting" even after the
 *      socket is connected and stalled mid-write.
 * kds-zombie-eviction: broadcastOrderUpdate leaves CLOSED KDS sockets in the clients map
 *      (zombie entries) when the close event never runs.
 * kds-close-throw-guard: closeKdsClient can throw if ws.close() throws, breaking the caller.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-printing-and-kds-resilience.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-print-kds-resilience-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const moduleApi = require('module') as { _resolveFilename: (...args: any[]) => string };
const originalResolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = request;
  if (request.startsWith('@print/')) {
    resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
  } else if (request.startsWith('@/')) {
    resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice('@/'.length));
  } else if (request === '@countries') {
    resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
  }
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const {
  initTestDb, assert, assertEqual, assertIncludes,
  getResults, closeDatabase,
} = require('./helpers/test-setup');

const { printWebBill } = require('../frontend/src/lib/printer/web-print');
const { printViaNetwork, classifyPrintFailure } = require('../main/printers/thermal');
const kds = require('../main/services/kds');
const net = require('net');
const { EventEmitter } = require('events');
const { WebSocket } = require('ws');

type MockWindow = {
  document: { open: () => void; write: (_html: string) => void; close: () => void; readyState: string };
  closed: boolean;
  printCalls: number;
  print: () => void;
  onload: (() => void) | null;
};

function createMockWindow(readyState: string): MockWindow {
  const win: MockWindow = {
    document: {
      open: () => {},
      write: (_html: string) => {},
      close: () => {},
      readyState,
    },
    closed: false,
    printCalls: 0,
    print: () => { win.printCalls += 1; },
    onload: null,
  };
  return win;
}

const sampleOrder = {
  id: 1,
  order_number: 'ORD-R4-001',
  status: 'completed',
  subtotal: 100,
  tax_amount: 0,
  discount_amount: 0,
  total: 100,
  created_at: '2026-09-21T10:00:00.000Z',
  items: [
    {
      id: 1,
      order_id: 1,
      product_id: 'p1',
      product_name: 'Espresso',
      unit_price: 100,
      quantity: 1,
      subtotal: 100,
      tax_amount: 0,
      total: 100,
      status: 'served',
    },
  ],
};

const sampleBill = {
  id: 1,
  bill_number: 'BILL-R4-001',
  order_id: 1,
  subtotal: 100,
  tax_amount: 0,
  discount_amount: 0,
  service_charge: 0,
  delivery_charge: 0,
  total: 100,
  paid_amount: 100,
  balance: 0,
  payment_status: 'paid',
  payment_details: [{ method: 'cash', amount: 100, timestamp: '2026-09-21T10:05:00.000Z' }],
  order: sampleOrder,
};

const sampleTenant = {
  business_name: 'Flo Cafe',
  currency: 'USD',
  country: 'US',
  timezone: 'UTC',
} as any;

async function testWebPrintSingleTrigger(): Promise<void> {
  console.log('\n─── web-print-once: printWebBill prints once when poll and onload both fire ───');
  const originalWindow = (global as any).window;
  try {
    const mockWindow = createMockWindow('loading');
    (global as any).window = { open: () => mockWindow };

    const printPromise = printWebBill(sampleBill as any, sampleTenant, { language: 'en' as any });

    await new Promise((r) => setTimeout(r, 80));
    mockWindow.document.readyState = 'complete';
    await new Promise((r) => setTimeout(r, 120));

    if (mockWindow.onload) mockWindow.onload();
    await printPromise;
    if (mockWindow.onload) mockWindow.onload();

    assertEqual(mockWindow.printCalls, 1, `window.print called once (got ${mockWindow.printCalls})`);
  } finally {
    (global as any).window = originalWindow;
  }
}

class StallAfterConnectSocket extends EventEmitter {
  public written: Buffer[] = [];
  public destroyed = false;
  public ended = false;
  public timeoutCb?: () => void;
  private connectCb?: () => void;

  connect(_port: number, _host: string, cb?: () => void): this {
    this.connectCb = cb;
    process.nextTick(() => { if (this.connectCb) this.connectCb(); });
    return this;
  }

  write(chunk: Buffer, _cb?: () => void): boolean {
    this.written.push(Buffer.from(chunk));
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  setTimeout(_ms: number, cb?: () => void): this {
    this.timeoutCb = cb;
    return this;
  }

  fireTimeout(): void {
    if (this.timeoutCb) this.timeoutCb();
  }
}

async function testThermalPhaseAwareTimeout(): Promise<void> {
  console.log('\n─── phase-aware-timeout: network timeout message is phase-aware after connect ───');
  const originalSocket = net.Socket;
  let mock: StallAfterConnectSocket | null = null;
  (net as any).Socket = function () {
    mock = new StallAfterConnectSocket();
    return mock;
  };

  try {
    const printPromise = printViaNetwork('192.168.1.100', 9100, Buffer.from('receipt-bytes'));
    await new Promise((r) => setTimeout(r, 20));
    assert(mock, 'mock socket constructed');
    mock!.fireTimeout();
    const result = await printPromise;
    assertEqual(result.ok, false, 'timed-out print fails');
    assertIncludes(String(result.detail || ''), 'writing', `detail mentions writing phase: ${result.detail}`);
    assert(
      !String(result.detail || '').includes('connecting'),
      `detail does not claim connect phase after connect: ${result.detail}`,
    );
    assertEqual(classifyPrintFailure(result.detail), 'timeout', 'phase-aware timeout still classifies as timeout');
    assertEqual(mock!.destroyed, true, 'socket destroyed on timeout');
  } finally {
    (net as any).Socket = originalSocket;
  }

  const originalSocket2 = net.Socket;
  let connectMock: StallAfterConnectSocket | null = null;
  (net as any).Socket = function () {
    connectMock = new StallAfterConnectSocket();
    connectMock.connect = function (_port: number, _host: string, _cb?: () => void): this {
      return this;
    };
    return connectMock;
  };
  try {
    const printPromise = printViaNetwork('192.168.1.101', 9100, Buffer.from('receipt-bytes'));
    await new Promise((r) => setTimeout(r, 20));
    connectMock!.fireTimeout();
    const result = await printPromise;
    assertEqual(result.ok, false, 'connect-phase timeout fails');
    assertIncludes(String(result.detail || ''), 'connecting', `connect-phase detail: ${result.detail}`);
    assertEqual(classifyPrintFailure(result.detail), 'timeout', 'connect timeout still classifies as timeout');
  } finally {
    (net as any).Socket = originalSocket2;
  }
}

function createFakeWs(options?: { closeThrows?: boolean }): any {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    on(event: string, cb: (...args: any[]) => void) {
      handlers[event] = cb;
    },
    once(event: string, cb: (...args: any[]) => void) {
      handlers[event] = cb;
    },
    send(_data: string) {},
    close() {
      if (options?.closeThrows) throw new Error('close failed');
      ws.readyState = WebSocket.CLOSED;
    },
    terminate() {
      ws.readyState = WebSocket.CLOSED;
    },
    ping() {},
    _emit(event: string, ...args: any[]) {
      if (handlers[event]) handlers[event](...args);
    },
  };
  return ws;
}

async function testKdsZombieEvictionAndCloseGuard(): Promise<void> {
  console.log('\n─── kds-zombie-eviction/kds-close-throw-guard: zombie KDS eviction and closeKdsClient throw guard ───');
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret-print-kds-resilience';
  const db = initTestDb();
  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');
  const { getJWTSecret } = require('../main/routes/auth');
  const { now } = require('./helpers/test-setup');

  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'chef', 1, ?, ?)`,
  ).run('kds-r4-chef', 'R4 Chef', 'kds-r4@flo.local', bcrypt.hashSync('Pass123!', 10), now(), now());

  const token = jwt.sign({ userId: 'kds-r4-chef', role: 'chef', jti: 'kds-r4-1' }, getJWTSecret(), { expiresIn: '1h' });

  const connectionHandlers: Array<(ws: any, req: any) => void> = [];
  const wss = new EventEmitter() as any;
  wss.on = (event: string, cb: any) => {
    if (event === 'connection') connectionHandlers.push(cb);
    return wss;
  };
  wss.once = (_event: string, _cb: any) => wss;

  kds.setupKdsWebSocket(wss);
  assertEqual(connectionHandlers.length, 1, 'setupKdsWebSocket registers connection handler');

  const authWs = createFakeWs();
  connectionHandlers[0](authWs, {});
  assertEqual(kds.getKdsClientCount(), 1, 'client present after connection');

  authWs._emit('message', JSON.stringify({ type: 'auth', token }));
  assertEqual(kds.getKdsClientCount(), 1, 'authorized client remains after auth');

  authWs.readyState = WebSocket.CLOSED;
  kds.notifyKdsUpdate();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assertEqual(kds.getKdsClientCount(), 0, 'CLOSED authorized zombie evicted on broadcast');

  const throwingWs = createFakeWs({ closeThrows: true });
  connectionHandlers[0](throwingWs, {});
  assertEqual(kds.getKdsClientCount(), 1, 'throwing-close client present after connection');

  let threw: Error | null = null;
  try {
    kds.closeKdsClientForTest(throwingWs, 'Session invalid');
  } catch (err: any) {
    threw = err;
  }
  assert(threw === null, `closeKdsClient survives ws.close() throw (got: ${threw?.message})`);
  assertEqual(kds.getKdsClientCount(), 0, 'client removed even when ws.close() throws');

  const healthyWs = createFakeWs();
  connectionHandlers[0](healthyWs, {});
  assertEqual(kds.getKdsClientCount(), 1, 'healthy client present');
  kds.closeKdsClientForTest(healthyWs, 'cleanup');
  assertEqual(kds.getKdsClientCount(), 0, 'healthy close still removes client');

  void db;
  closeDatabase();
}

async function main() {
  console.log('Issue Test: Printing and KDS Resilience');
  console.log('='.repeat(50));

  try {
    await testWebPrintSingleTrigger();
    await testThermalPhaseAwareTimeout();
    await testKdsZombieEvictionAndCloseGuard();
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: any) => {
  console.error('Test runner error:', err);
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
