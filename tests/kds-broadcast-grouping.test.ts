/**
 * A KDS broadcast queries SQLite once per distinct filter signature, not once
 * per connected client, and every client in a signature group gets the same snapshot.
 */

import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kds-broadcast-group-'));

Module._load = function (requestName: string, parent: unknown, isMain: boolean) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startKdsServer, stopKdsServer, getKdsPort } from '../main/kds-server';
import { initDatabase, closeDatabase, getDatabase, now } from '../main/db';
import { clearRevokedTokens } from '../main/middleware/security';
import { notifyKdsUpdate } from '../main/services/kds';
import { getJWTSecret } from '../main/routes/auth';
import { WebSocket } from 'ws';
import * as jwt from 'jsonwebtoken';
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

function createMessageQueue(ws: WebSocket) {
  const messages: any[] = [];
  const servers: Array<{ type: string; resolve: (message: any) => void }> = [];
  ws.on('message', (raw: WebSocket.RawData) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = servers.findIndex((server) => server.type === message.type);
    if (waiterIndex >= 0) return servers.splice(waiterIndex, 1)[0].resolve(message);
    messages.push(message);
  });
  return (type: string): Promise<any> => {
    const messageIndex = messages.findIndex((message) => message.type === type);
    if (messageIndex >= 0) return Promise.resolve(messages.splice(messageIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const server = { type, resolve: (_message: any) => {} };
      const timeout = setTimeout(() => {
        const index = servers.indexOf(server);
        if (index >= 0) servers.splice(index, 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 10000);
      server.resolve = (message: any) => {
        clearTimeout(timeout);
        resolve(message);
      };
      servers.push(server);
    });
  };
}

async function run() {
  clearRevokedTokens();
  initDatabase();
  await startKdsServer();
  try {
    const port = getKdsPort();
    const db = getDatabase();
    const bcrypt = require('bcryptjs');
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active)
      VALUES ('kds-grp-chef', 'Group Chef', 'grpchef@flo.local', ?, 'chef', 1)`).run(
      bcrypt.hashSync('Pass123!', 10),
    );
    db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)').run(
      'grp-cat',
      'Grp',
      1,
    );
    db.prepare(
      'INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 1)',
    ).run('grp-prod', 'grp-cat', 'Grp Burger', 15);
    db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES ('GRP-001', 'takeaway', 'pending', 15, 15, ?, ?)`).run(now(), now());
    const orderId = (
      db.prepare("SELECT id FROM orders WHERE order_number = 'GRP-001'").get() as any
    ).id;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'grp-prod', 'Grp Burger', 15, 1, 15, 0, 15, 'pending', ?, ?)`).run(
      orderId,
      now(),
      now(),
    );

    const token = jwt.sign({ userId: 'kds-grp-chef', role: 'chef', jti: 'grp-1' }, getJWTSecret(), {
      expiresIn: '1h',
    });
    const sockets: WebSocket[] = [];
    const queues: Array<(type: string) => Promise<any>> = [];
    for (let i = 0; i < 6; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/kds`);
      const queue = createMessageQueue(ws);
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'auth', token }));
      await queue('auth_success');
      await queue('initial_data');
      sockets.push(ws);
      queues.push(queue);
    }

    let orderSnapshotQueries = 0;
    const originalPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (/FROM orders o\b[\s\S]*LEFT JOIN tables t/.test(sql) && !/COUNT\(\*\)/.test(sql))
        orderSnapshotQueries += 1;
      return originalPrepare(sql);
    };

    notifyKdsUpdate();
    notifyKdsUpdate();
    const snapshots = await Promise.all(queues.map((queue) => queue('initial_data')));
    (db as any).prepare = originalPrepare;

    assertEqualOrThrow(
      orderSnapshotQueries,
      1,
      'six clients sharing one filter signature run one order snapshot query',
    );
    assertEqualOrThrow(snapshots.length, 6, 'every client receives a snapshot');
    assertOrThrow(
      snapshots.every((snapshot) => JSON.stringify(snapshot) === JSON.stringify(snapshots[0])),
      'clients in one group receive identical snapshots',
    );
    assertEqualOrThrow(snapshots[0].orders.length, 1, 'the snapshot carries the active order');

    for (const ws of sockets) ws.close();
    await testRestPollingAndConflictResolution();
    console.log('kds-broadcast-grouping tests passed');
  } finally {
    await stopKdsServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

async function testRestPollingAndConflictResolution() {
  let stateIdx = 0;
  let refIdx = 0;
  let effectIdx = 0;
  let callbackIdx = 0;
  const states: any[] = [];
  const refs: any[] = [];
  const callbacks: Array<{ fn: any; deps?: any[] }> = [];
  const effects: Array<{ effect: () => any; cleanup?: () => any; deps?: any[] }> = [];

  const mockReact = {
    useState(init: any) {
      const i = stateIdx++;
      if (i >= states.length) states[i] = typeof init === 'function' ? init() : init;
      return [
        states[i],
        (action: any) => {
          states[i] = typeof action === 'function' ? action(states[i]) : action;
        },
      ];
    },
    useRef(init: any) {
      const i = refIdx++;
      if (i >= refs.length) refs[i] = { current: init };
      return refs[i];
    },
    useCallback(fn: any, deps?: any[]) {
      const i = callbackIdx++;
      const prev = callbacks[i];
      const hasChanged =
        !prev || !deps || !prev.deps || deps.some((d, idx) => d !== prev.deps![idx]);
      if (hasChanged) {
        callbacks[i] = { fn, deps };
      }
      return callbacks[i].fn;
    },
    useEffect(effect: () => any, deps?: any[]) {
      const i = effectIdx++;
      const prev = effects[i];
      const hasChanged =
        !prev || !deps || !prev.deps || deps.some((d, idx) => d !== prev.deps![idx]);
      if (hasChanged) {
        if (prev?.cleanup) prev.cleanup();
        const cleanup = effect();
        effects[i] = {
          effect,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
          deps,
        };
      }
    },
  };

  const toastMock = { success: () => {}, error: () => {}, default: null as any };
  toastMock.default = toastMock;
  const stableTranslate = (k: string) => k;
  const intlMock = { useTranslations: () => stableTranslate };

  const prevLoad = Module._load;
  Module._load = function (requestName: string, parent: unknown, isMain: boolean) {
    if (requestName === 'react') return mockReact;
    if (requestName === '@/hooks/use-confirm')
      return { useConfirm: () => ({ confirm: async () => true, ConfirmDialog: null }) };
    if (requestName === 'react-hot-toast') return toastMock;
    if (requestName === 'use-intl') return intlMock;
    return prevLoad.apply(this, arguments as any);
  };

  const prevWindow = (global as any).window;
  (global as any).window = {
    localStorage: {
      getItem: (k: string) => (k === 'token' ? 'test-token' : null),
      setItem: () => {},
      removeItem: () => {},
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };

  let initialFetchCb: (() => void) | null = null;
  let timerIntervalCb: (() => void) | null = null;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  (global as any).setTimeout = (cb: () => void, ms: number) => {
    if (ms === 0) {
      initialFetchCb = cb;
      return 101 as any;
    }
    return originalSetTimeout(cb, ms);
  };
  (global as any).setInterval = (cb: () => void, ms: number) => {
    timerIntervalCb = cb;
    return 102 as any;
  };

  try {
    const { useKdsConnection } = require('../frontend/src/hooks/useKdsConnection');

    states[0] = { id: 'chef-1', name: 'Chef', role: 'chef' }; // user
    states[1] = [
      {
        id: 1,
        order_number: 'GRP-001',
        items: [{ id: 10, status: 'pending', product_name: 'Burger' }],
      },
    ]; // initial orders
    states[5] = 'rest'; // connectionMode

    const apiGetInFlight: Array<{ url: string; resolve: (val: any) => void }> = [];
    let patchShouldConflict = false;

    const api = {
      get: (url: string) => {
        if (url.includes('/auth/me')) {
          return Promise.resolve({ data: { user: states[0] } });
        }
        return new Promise((resolve) => {
          apiGetInFlight.push({ url, resolve });
        });
      },
      patch: (_url: string, _body: any) => {
        if (patchShouldConflict) {
          return Promise.reject({
            response: { status: 409, data: { error: 'Item status conflict' } },
          });
        }
        return Promise.resolve({ data: { success: true } });
      },
    };

    function render() {
      stateIdx = 0;
      refIdx = 0;
      effectIdx = 0;
      callbackIdx = 0;
      return useKdsConnection({ api, enabled: true });
    }

    let hook = render();

    // 1. Initial poll and deduplication of overlapping background timer ticks
    assertOrThrow(typeof initialFetchCb === 'function', 'startRestPolling scheduled initial fetch');
    initialFetchCb!();
    assertEqualOrThrow(
      apiGetInFlight.length,
      1,
      'initial rest poll triggered first GET /kitchen/orders',
    );

    assertOrThrow(
      typeof timerIntervalCb === 'function',
      'startRestPolling scheduled interval timer',
    );
    timerIntervalCb!();
    assertEqualOrThrow(
      apiGetInFlight.length,
      1,
      'overlapping timer tick is deduplicated while poll is in flight',
    );

    // 2. updateItemStatus on 200 PATCH success while poll is in flight
    const updatePromise = hook.updateItemStatus(10, 'preparing');
    await new Promise((r) => setImmediate(r));
    assertEqualOrThrow(
      apiGetInFlight.length,
      2,
      'updateItemStatus triggers immediate fresh orders fetch while poll is in flight',
    );

    // Resolve the fresh fetch (call 2) with status 'preparing'
    apiGetInFlight[1].resolve({
      data: {
        orders: [
          {
            id: 1,
            order_number: 'GRP-001',
            items: [{ id: 10, status: 'preparing', product_name: 'Burger' }],
          },
        ],
      },
    });
    await updatePromise;
    hook = render();
    assertEqualOrThrow(
      hook.orders[0]?.items[0]?.status,
      'preparing',
      'orders updated to preparing after PATCH success',
    );

    // Stale poll (call 1) resolves later with status 'pending'
    apiGetInFlight[0].resolve({
      data: {
        orders: [
          {
            id: 1,
            order_number: 'GRP-001',
            items: [{ id: 10, status: 'pending', product_name: 'Burger' }],
          },
        ],
      },
    });
    await new Promise((r) => setImmediate(r));
    hook = render();
    assertEqualOrThrow(
      hook.orders[0]?.items[0]?.status,
      'preparing',
      'stale in-flight poll does not overwrite newer state',
    );

    // 3. updateItemStatus on 409 conflict while a timer poll is in flight
    timerIntervalCb!();
    assertEqualOrThrow(
      apiGetInFlight.length,
      3,
      'background timer triggers new poll when no poll was in flight',
    );

    patchShouldConflict = true;
    const conflictPromise = hook.updateItemStatus(10, 'ready');
    await new Promise((r) => setImmediate(r));
    assertEqualOrThrow(
      apiGetInFlight.length,
      4,
      '409 conflict triggers immediate fresh orders fetch while poll is in flight',
    );

    // Resolve the conflict recovery fetch (call 4) with status 'served'
    apiGetInFlight[3].resolve({
      data: {
        orders: [
          {
            id: 1,
            order_number: 'GRP-001',
            items: [{ id: 10, status: 'served', product_name: 'Burger' }],
          },
        ],
      },
    });
    await conflictPromise;
    hook = render();
    assertEqualOrThrow(
      hook.orders[0]?.items[0]?.status,
      'served',
      'orders updated to fresh state after 409 conflict',
    );

    // Stale poll (call 3) resolves with status 'preparing'
    apiGetInFlight[2].resolve({
      data: {
        orders: [
          {
            id: 1,
            order_number: 'GRP-001',
            items: [{ id: 10, status: 'preparing', product_name: 'Burger' }],
          },
        ],
      },
    });
    await new Promise((r) => setImmediate(r));
    hook = render();
    assertEqualOrThrow(
      hook.orders[0]?.items[0]?.status,
      'served',
      'stale in-flight poll after 409 conflict does not overwrite fresh state',
    );

    // 4. Older poll settling does not clear in-flight marker of newer pending refresh
    patchShouldConflict = false;
    timerIntervalCb!();
    assertEqualOrThrow(apiGetInFlight.length, 5, 'background timer triggers poll #5 when idle');

    const updatePromise2 = hook.updateItemStatus(10, 'ready');
    await new Promise((r) => setImmediate(r));
    assertEqualOrThrow(
      apiGetInFlight.length,
      6,
      'updateItemStatus triggers required refresh #6 while poll #5 is in flight',
    );

    // Older poll resolves while newer required refresh is still pending
    apiGetInFlight[4].resolve({
      data: {
        orders: [
          {
            id: 1,
            order_number: 'GRP-001',
            items: [{ id: 10, status: 'served', product_name: 'Burger' }],
          },
        ],
      },
    });
    await new Promise((r) => setImmediate(r));

    // Poll timer ticks while required refresh is pending: must not trigger a new GET
    timerIntervalCb!();
    assertEqualOrThrow(
      apiGetInFlight.length,
      6,
      'older poll settling does not clear in-flight marker of newer pending refresh',
    );

    // Resolve newer required refresh
    apiGetInFlight[5].resolve({
      data: {
        orders: [
          {
            id: 1,
            order_number: 'GRP-001',
            items: [{ id: 10, status: 'ready', product_name: 'Burger' }],
          },
        ],
      },
    });
    await updatePromise2;
    hook = render();
    assertEqualOrThrow(
      hook.orders[0]?.items[0]?.status,
      'ready',
      'orders updated to ready after required refresh resolves',
    );

    // Once newer refresh settles, background timer starts fresh poll
    timerIntervalCb!();
    assertEqualOrThrow(
      apiGetInFlight.length,
      7,
      'new poll starts after required refresh has completed',
    );
  } finally {
    for (const e of effects) {
      if (typeof e.cleanup === 'function') e.cleanup();
    }
    Module._load = prevLoad;
    (global as any).window = prevWindow;
    (global as any).setTimeout = originalSetTimeout;
    (global as any).setInterval = originalSetInterval;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
