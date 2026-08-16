import request from 'supertest';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kds-test-'));

Module._load = function (requestName: string, parent: unknown, isMain: boolean) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startKdsServer, stopKdsServer, getKdsPort } from '../main/kds-server';
import { initDatabase, closeDatabase, getDatabase, now } from '../main/db';
import { WebSocket } from 'ws';

function createMessageQueue(ws: WebSocket) {
  const messages: any[] = [];
  const waiters: Array<{ type: string; resolve: (message: any) => void }> = [];
  ws.on('message', (raw: WebSocket.RawData) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
    if (waiterIndex >= 0) return waiters.splice(waiterIndex, 1)[0].resolve(message);
    messages.push(message);
  });
  return (type: string): Promise<any> => {
    const messageIndex = messages.findIndex((message) => message.type === type);
    if (messageIndex >= 0) return Promise.resolve(messages.splice(messageIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve: (_message: any) => {} };
      const timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 5000);
      waiter.resolve = (message: any) => { clearTimeout(timeout); resolve(message); };
      waiters.push(waiter);
    });
  };
}

async function run() {
  console.log('Testing KDS Server API Integration & Role Contracts...');
  
  const assert = (condition: boolean, msg: string) => {
    if (!condition) {
      throw new Error(`Assertion failed: ${msg}`);
    }
  };

  initDatabase();
  await startKdsServer();

  try {
    const port = getKdsPort();
    const db = getDatabase();
    const bcrypt = require('bcryptjs');
    const hashedPass = bcrypt.hashSync('KitchenPass123!', 10);

    // Seed kitchen staff (chef) and non-kitchen staff (waiter)
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active)
      VALUES ('user-chef-1', 'Chef User', 'chef@flo.local', ?, 'chef', 1)
    `).run(hashedPass);

    db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)')
      .run('kds-category', 'Kitchen', 1);
    db.prepare('INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 1)')
      .run('kds-product', 'kds-category', 'KDS Burger', 10);
    db.prepare('UPDATE users SET category_ids = ? WHERE id = ?').run(JSON.stringify(['kds-category']), 'user-chef-1');
    db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
      VALUES ('kds-integration-station', 'Integration Station', '[]', 1, ?, ?)`)
      .run(now(), now());
    db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)')
      .run('user-chef-1', 'kds-integration-station', now());
    db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES (?, 'takeaway', 'pending', 10, 10, ?, ?)`)
      .run('KDS-WS-001', now(), now());
    const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('KDS-WS-001') as any).id;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'kds-product', 'KDS Burger', 10, 1, 10, 0, 10, 'pending', ?, ?)`)
      .run(orderId, now(), now());
    const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;
    db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)').run('kds-bar-category', 'Bar', 2);
    db.prepare('INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 1)').run('kds-bar-product', 'kds-bar-category', 'KDS Bar', 12);
    db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES (?, 'takeaway', 'pending', 12, 12, ?, ?)`).run('KDS-WS-BAR', now(), now());
    const barOrderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('KDS-WS-BAR') as any).id;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'kds-bar-product', 'KDS Bar', 12, 1, 12, 0, 12, 'pending', ?, ?)`).run(barOrderId, now(), now());

    db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
      VALUES ('kds-unrestricted-station', 'Unrestricted Station', NULL, 1, ?, ?)`).run(now(), now());
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, station_assignments_configured, created_at, updated_at)
      VALUES ('user-unrestricted-manager', 'Unrestricted Manager', 'unrestricted@flo.local', ?, 'manager', 1, 1, ?, ?)`).run(hashedPass, now(), now());
    db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)')
      .run('user-unrestricted-manager', 'kds-unrestricted-station', now());
    db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)')
      .run('kds-unrestricted-category', 'Unrestricted food', 3);
    db.prepare('INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 1)')
      .run('kds-unrestricted-product', 'kds-unrestricted-category', 'Unrestricted food', 10);
    db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES (?, 'takeaway', 'pending', 10, 10, ?, ?)`).run('KDS-UNRESTRICTED-001', now(), now());
    const unrestrictedOrderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('KDS-UNRESTRICTED-001') as any).id;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'kds-unrestricted-product', 'Unrestricted food', 10, 1, 10, 0, 10, 'pending', ?, ?)`).run(unrestrictedOrderId, now(), now());

    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active)
      VALUES ('user-waiter-1', 'Waiter User', 'waiter@flo.local', ?, 'waiter', 1)
    `).run(hashedPass);

    // 1. Missing credentials returns 400
    const res1 = await request(`http://127.0.0.1:${port}`).post('/api/auth/login');
    assert(res1.status === 400, 'Should return 400 for missing credentials');

    // 2. Invalid credentials returns 401
    const res2 = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/login')
      .send({ email: 'chef@flo.local', password: 'wrong' });
    assert(res2.status === 401, 'Should return 401 for invalid password');

    // 3. Non-kitchen staff role (waiter) returns 403 Forbidden
    const res3 = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/login')
      .send({ email: 'waiter@flo.local', password: 'KitchenPass123!' });
    assert(res3.status === 403, 'Should deny access (403) to non-kitchen roles');

    // 4. Kitchen staff role (chef) succeeds
    const chefLogin = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/login')
      .send({ email: 'chef@flo.local', password: 'KitchenPass123!' });
    assert(chefLogin.status === 200, 'Chef login succeeds on KDS API');
    assert(!!chefLogin.body.access_token, 'Chef login returns access_token');

    let token = chefLogin.body.access_token;

    const standaloneLogout = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    assert(standaloneLogout.status === 200, 'Standalone KDS logout succeeds');
    const rejectedAfterLogout = await request(`http://127.0.0.1:${port}`)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    assert(rejectedAfterLogout.status === 401, 'Standalone KDS logout revokes the token');

    const relogin = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/login')
      .send({ email: 'chef@flo.local', password: 'KitchenPass123!' });
    assert(relogin.status === 200, 'Chef can log in again after standalone logout');
    token = relogin.body.access_token;

    // A credential cutoff must invalidate this token on every standalone KDS route.
    db.prepare('UPDATE users SET tokens_valid_after = ? WHERE id = ?').run('2099-01-01 00:00:00', 'user-chef-1');
    const staleMe = await request(`http://127.0.0.1:${port}`)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    assert(staleMe.status === 401, 'Standalone KDS rejects a token older than tokens_valid_after');
    db.prepare('UPDATE users SET tokens_valid_after = NULL WHERE id = ?').run('user-chef-1');

    // 5. Unauthenticated request to /api/kds/orders fails with 401
    const unauthedOrders = await request(`http://127.0.0.1:${port}`).get('/api/kds/orders');
    assert(unauthedOrders.status === 401, 'Unauthenticated KDS orders request returns 401');

    // 6. Authenticated request with chef token succeeds
    const authedOrders = await request(`http://127.0.0.1:${port}`)
      .get('/api/kds/orders')
      .set('Authorization', `Bearer ${token}`);
    assert(authedOrders.status === 200, 'Authenticated KDS orders request returns 200');
    assert(Array.isArray(authedOrders.body.orders), 'KDS orders returns an orders array');
    assert(!('unit_price' in (authedOrders.body.orders[0]?.items?.[0] || {})), 'Station-only standalone chef receives redacted item pricing');

    const unrestrictedLogin = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/login')
      .send({ email: 'unrestricted@flo.local', password: 'KitchenPass123!' });
    assert(unrestrictedLogin.status === 200, 'Unrestricted manager can log in to standalone KDS');
    const unrestrictedOrders = await request(`http://127.0.0.1:${port}`)
      .get('/api/kds/orders')
      .set('Authorization', `Bearer ${unrestrictedLogin.body.access_token}`);
    assert(unrestrictedOrders.body.orders.some((order: any) => order.id === unrestrictedOrderId), 'Standalone unrestricted station receives tableless orders');
    const categoriesRes = await request(`http://127.0.0.1:${port}`)
      .get('/api/categories')
      .set('Authorization', `Bearer ${token}`);
    assert(categoriesRes.status === 200, 'Standalone categories request succeeds');
    assert(categoriesRes.body.categories.every((category: any) => category.id === 'kds-category'), 'Station-only chef receives only permitted categories');

    // Query-count regression (#226): the standalone poll must fetch order
    // items in a single IN(...) query, not one query per active order.
    const originalPrepare = db.prepare.bind(db) as typeof db.prepare;
    let batchedItemQueries = 0;
    (db as any).prepare = (sql: string, ...rest: unknown[]) => {
      if (typeof sql === 'string' && /FROM order_items oi/.test(sql) && /oi\.order_id IN/.test(sql)) {
        batchedItemQueries += 1;
      }
      return (originalPrepare as any)(sql, ...rest);
    };
    const qcOrders = await request(`http://127.0.0.1:${port}`)
      .get('/api/kds/orders')
      .set('Authorization', `Bearer ${token}`);
    assert(qcOrders.status === 200, 'Query-count KDS orders request returns 200');
    assert(batchedItemQueries === 1, `standalone KDS poll batches item lookups into one query (got ${batchedItemQueries})`);
    (db as any).prepare = originalPrepare;

    // 7. The real WebSocket channel authenticates and receives mutation broadcasts.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const nextMessage = createMessageQueue(ws);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'auth', token }));
    const authMessage = await nextMessage('auth_success');
    assert(authMessage.user.role === 'chef', 'WebSocket authenticates kitchen staff');
    const initialData = await nextMessage('initial_data');
    assert(!('unit_price' in (initialData.orders[0]?.items?.[0] || {})), 'Station-only WebSocket chef receives redacted item pricing');
    assert(initialData.counts.pending === 1, 'WebSocket counts exclude unauthorized station categories');

    const unrestrictedWs = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const nextUnrestrictedMessage = createMessageQueue(unrestrictedWs);
    await once(unrestrictedWs, 'open');
    unrestrictedWs.send(JSON.stringify({ type: 'auth', token: unrestrictedLogin.body.access_token }));
    await nextUnrestrictedMessage('auth_success');
    const unrestrictedInitialData = await nextUnrestrictedMessage('initial_data');
    assert(unrestrictedInitialData.orders.some((order: any) => order.id === unrestrictedOrderId), 'WebSocket unrestricted station receives tableless orders');
    unrestrictedWs.close();
    await once(unrestrictedWs, 'close');

    const updatePromise = nextMessage('initial_data');
    const statusRes = await request(`http://127.0.0.1:${port}`)
      .patch(`/api/kds/items/${itemId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ready' });
    assert(statusRes.status === 200, 'KDS item status update succeeds');
    await updatePromise;
    assert((db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemId) as any).status === 'ready', 'WebSocket broadcast follows item mutation');
    db.prepare("UPDATE order_items SET status = 'voided', voided_at = ? WHERE id = ?").run(now(), itemId);
    const terminalStatusRes = await request(`http://127.0.0.1:${port}`)
      .patch(`/api/kds/items/${itemId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'preparing' });
    assert(terminalStatusRes.status === 400, 'Standalone KDS cannot overwrite a voided item');
    ws.close();
    await once(ws, 'close');

    // 8. Public KDS info endpoint responds
    const infoRes = await request(`http://127.0.0.1:${port}`).get('/api/kds/info');
    assert(infoRes.status === 200, 'Public info endpoint returns 200');

    console.log('✅ KDS Integration & Auth Role Contract tests passed!');
  } finally {
    stopKdsServer();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch { }
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
