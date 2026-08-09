/**
 * Test suite for Area F: KDS WebSocket Authorization & Revalidation
 * Verifies WebSocket token expiry, revocation, active-user status revalidation,
 * and privilege checks during long-lived socket operations.
 */

import request from 'supertest';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kds-ws-test-'));

Module._load = function (requestName: string, parent: unknown, isMain: boolean) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startKdsServer, stopKdsServer, getKdsPort } from '../main/kds-server';
import { initDatabase, closeDatabase, getDatabase, now } from '../main/db';
import { revokeToken, clearRevokedTokens, invalidateUserAuthCache } from '../main/middleware/security';
import { notifyKdsUpdate } from '../main/services/kds';
import { getJWTSecret } from '../main/routes/auth';
import { WebSocket } from 'ws';
import * as jwt from 'jsonwebtoken';
const { assert, assertEqual } = require('./helpers/test-setup');

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
      }, 10000);
      waiter.resolve = (message: any) => { clearTimeout(timeout); resolve(message); };
      waiters.push(waiter);
    });
  };
}

async function run() {
  console.log('Testing KDS WebSocket Session Revalidation (Area F)...');
  console.log('='.repeat(60));

  clearRevokedTokens();
  initDatabase();
  await startKdsServer();

  try {
    const port = getKdsPort();
    const db = getDatabase();
    const bcrypt = require('bcryptjs');

    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active)
      VALUES ('kds-ws-chef-1', 'WS Chef', 'wschef@flo.local', ?, 'chef', 1)
    `).run(bcrypt.hashSync('Pass123!', 10));

    db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)')
      .run('ws-cat-1', 'WS Category', 1);
    db.prepare('INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 1)')
      .run('ws-prod-1', 'ws-cat-1', 'WS Burger', 15);
    db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES (?, 'takeaway', 'pending', 15, 15, ?, ?)`)
      .run('WS-REVAL-001', now(), now());
    const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('WS-REVAL-001') as any).id;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'ws-prod-1', 'WS Burger', 15, 1, 15, 0, 15, 'pending', ?, ?)`)
      .run(orderId, now(), now());
    const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId) as any).id;

    const validToken = jwt.sign({ userId: 'kds-ws-chef-1', role: 'chef', jti: 'test-valid-1' }, getJWTSecret(), { expiresIn: '1h' });

    // Unauthenticated sockets must not remain open indefinitely.
    const idleWs = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const idleQueue = createMessageQueue(idleWs);
    await once(idleWs, 'open');
    const idleAuthError = await idleQueue('auth_error');
    assert(idleAuthError.type === 'auth_error', 'Idle unauthenticated socket receives an auth error');
    await once(idleWs, 'close');

    // Test 1: Revoked token fails WebSocket auth
    const revokedToken = jwt.sign({ userId: 'kds-ws-chef-1', role: 'chef', jti: 'test-revoked-1' }, getJWTSecret(), { expiresIn: '1h' });
    revokeToken(revokedToken);

    const wsRev = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const qRev = createMessageQueue(wsRev);
    await once(wsRev, 'open');
    wsRev.send(JSON.stringify({ type: 'auth', token: revokedToken }));
    const revAuthMsg = await qRev('auth_error');
    assert(revAuthMsg.type === 'auth_error', 'Revoked token rejected at WS auth');
    wsRev.close();
    await once(wsRev, 'close');

    // Test 2: Status update with revoked token on active socket fails
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const q1 = createMessageQueue(ws1);
    await once(ws1, 'open');
    ws1.send(JSON.stringify({ type: 'auth', token: validToken }));
    await q1('auth_success');
    await q1('initial_data');

    // Revoke the token while connection is live. A broadcast must not expose
    // another order snapshot to the stale session; the server should close it.
    revokeToken(validToken);
    const closePromise1 = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('revoked KDS socket stayed open')), 2500);
      ws1.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    notifyKdsUpdate();
    await closePromise1;

    // Test 3: Status update after user deactivation fails
    clearRevokedTokens();
    const freshToken = jwt.sign({ userId: 'kds-ws-chef-1', role: 'chef', jti: 'test-fresh-1' }, getJWTSecret(), { expiresIn: '1h' });
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const q2 = createMessageQueue(ws2);
    await once(ws2, 'open');
    ws2.send(JSON.stringify({ type: 'auth', token: freshToken }));
    await q2('auth_success');
    await q2('initial_data');

    // Deactivate user in DB & invalidate cache
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run('kds-ws-chef-1');
    invalidateUserAuthCache('kds-ws-chef-1');

    ws2.send(JSON.stringify({ type: 'status_update', order_item_id: itemId, status: 'preparing' }));
    const errRes2 = await q2('auth_error');
    assert(errRes2.message.includes('revoked') || errRes2.message.includes('expired'), 'Deactivated user status update blocked');
    await once(ws2, 'close');

    console.log('✅ KDS WebSocket session revalidation tests passed!');
  } finally {
    stopKdsServer();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch { }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
