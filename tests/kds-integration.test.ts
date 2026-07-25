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
    db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES (?, 'takeaway', 'pending', 10, 10, ?, ?)`)
      .run('KDS-WS-001', now(), now());
    const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('KDS-WS-001') as any).id;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'kds-product', 'KDS Burger', 10, 1, 10, 0, 10, 'pending', ?, ?)`)
      .run(orderId, now(), now());
    const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;

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

    const token = chefLogin.body.access_token;

    // 5. Unauthenticated request to /api/kds/orders fails with 401
    const unauthedOrders = await request(`http://127.0.0.1:${port}`).get('/api/kds/orders');
    assert(unauthedOrders.status === 401, 'Unauthenticated KDS orders request returns 401');

    // 6. Authenticated request with chef token succeeds
    const authedOrders = await request(`http://127.0.0.1:${port}`)
      .get('/api/kds/orders')
      .set('Authorization', `Bearer ${token}`);
    assert(authedOrders.status === 200, 'Authenticated KDS orders request returns 200');
    assert(Array.isArray(authedOrders.body.orders), 'KDS orders returns an orders array');

    // 7. The real WebSocket channel authenticates and receives mutation broadcasts.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const nextMessage = createMessageQueue(ws);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'auth', token }));
    const authMessage = await nextMessage('auth_success');
    assert(authMessage.user.role === 'chef', 'WebSocket authenticates kitchen staff');
    await nextMessage('initial_data');

    const updatePromise = nextMessage('initial_data');
    const statusRes = await request(`http://127.0.0.1:${port}`)
      .patch(`/api/kds/items/${itemId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ready' });
    assert(statusRes.status === 200, 'KDS item status update succeeds');
    await updatePromise;
    assert((db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemId) as any).status === 'ready', 'WebSocket broadcast follows item mutation');
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
