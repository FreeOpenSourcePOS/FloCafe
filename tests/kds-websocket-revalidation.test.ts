/**
 * Test suite for Area F: KDS WebSocket Authorization & Revalidation
 * Verifies WebSocket token expiry, revocation, active-user status revalidation,
 * and privilege checks during long-lived socket operations, plus the
 * connect-to-auth grace window that a broadcast must not cut short.
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
import { notifyKdsUpdate, KDS_AUTH_TIMEOUT_MS } from '../main/services/kds';
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
      server.resolve = (message: any) => { clearTimeout(timeout); resolve(message); };
      servers.push(server);
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
    assertOrThrow(idleAuthError.type === 'auth_error', 'Idle unauthenticated socket receives an auth error');
    await once(idleWs, 'close');

    // Test 1: Revoked token fails WebSocket auth
    const revokedToken = jwt.sign({ userId: 'kds-ws-chef-1', role: 'chef', jti: 'test-revoked-1' }, getJWTSecret(), { expiresIn: '1h' });
    revokeToken(revokedToken);

    const wsRev = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const qRev = createMessageQueue(wsRev);
    await once(wsRev, 'open');
    wsRev.send(JSON.stringify({ type: 'auth', token: revokedToken }));
    const revAuthMsg = await qRev('auth_error');
    assertOrThrow(revAuthMsg.type === 'auth_error', 'Revoked token rejected at WS auth');
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
    assertOrThrow(errRes2.message.includes('revoked') || errRes2.message.includes('expired'), 'Deactivated user status update blocked');
    await once(ws2, 'close');

    // Test 4: A broadcast must not terminate a socket that is still inside its
    // connect-to-auth grace window. isKdsClientAuthorized() reports false for a
    // socket with no userId yet, so treating that as "revoked" closed
    // reconnecting KDS displays mid-handshake and handed them a misleading
    // "Session expired or revoked". Their lifecycle belongs to the
    // KDS_AUTH_TIMEOUT_MS timer alone.
    clearRevokedTokens();
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run('kds-ws-chef-1');
    invalidateUserAuthCache('kds-ws-chef-1');
    const graceToken = jwt.sign({ userId: 'kds-ws-chef-1', role: 'chef', jti: 'test-grace-1' }, getJWTSecret(), { expiresIn: '1h' });

    // A second, fully authenticated socket so the broadcast has an authorized
    // client to serve while the pre-auth one is connected. It authenticates
    // with its own token so revoking the token under test does not close it.
    const authedToken = jwt.sign({ userId: 'kds-ws-chef-1', role: 'chef', jti: 'test-authed-1' }, getJWTSecret(), { expiresIn: '1h' });
    const wsAuthed = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const qAuthed = createMessageQueue(wsAuthed);
    await once(wsAuthed, 'open');
    wsAuthed.send(JSON.stringify({ type: 'auth', token: authedToken }));
    await qAuthed('auth_success');
    await qAuthed('initial_data');

    const wsPreAuth = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const qPreAuth = createMessageQueue(wsPreAuth);
    await once(wsPreAuth, 'open');
    const messagesDuringWindow: string[] = [];
    wsPreAuth.on('message', (raw: WebSocket.RawData) => {
      messagesDuringWindow.push(JSON.parse(raw.toString()).type);
    });
    let closedEarly: string | null = null;
    wsPreAuth.once('close', (_code: number, reason: Buffer) => { closedEarly = reason.toString(); });

    // Fire several broadcasts inside the grace window.
    for (let i = 0; i < 5; i++) {
      notifyKdsUpdate();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assertOrThrow(wsPreAuth.readyState === WebSocket.OPEN,
      `Unauthenticated socket survives broadcasts inside its grace window (closed: ${closedEarly})`);
    assertOrThrow(!messagesDuringWindow.includes('auth_error'),
      'Unauthenticated socket receives no auth_error from a broadcast');
    assertOrThrow(!messagesDuringWindow.includes('initial_data'),
      'Unauthenticated socket receives no order snapshot from a broadcast');

    // The grace window itself still owns the socket: it is closed on its own
    // schedule, with the authentication-required reason rather than a
    // revocation.
    const windowDeadline = KDS_AUTH_TIMEOUT_MS + 4000;
    const windowClose = await Promise.race([
      once(wsPreAuth, 'close').then(([code, reason]: any) => ({ closed: true, code, reason: reason.toString() })),
      new Promise((resolve) => setTimeout(() => resolve({ closed: false }), windowDeadline)),
    ]);
    assertOrThrow(windowClose.closed, 'An unauthenticated socket is still closed once its grace window expires');
    assertOrThrow(String(windowClose.reason).includes('Authentication required'),
      `Grace-window close reports authentication, not revocation (got: ${windowClose.reason})`);

    // Test 5: an authenticated-but-revoked socket is still closed by a broadcast.
    const revokedGraceToken = jwt.sign({ userId: 'kds-ws-chef-1', role: 'chef', jti: 'test-grace-2' }, getJWTSecret(), { expiresIn: '1h' });
    const wsRevoked = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    const qRevoked = createMessageQueue(wsRevoked);
    await once(wsRevoked, 'open');
    wsRevoked.send(JSON.stringify({ type: 'auth', token: revokedGraceToken }));
    await qRevoked('auth_success');
    await qRevoked('initial_data');
    revokeToken(revokedGraceToken);
    const revokedClose = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('revoked KDS socket survived the broadcast')), 2500);
      wsRevoked.once('close', () => { clearTimeout(deadline); resolve(); });
    });
    notifyKdsUpdate();
    await revokedClose;

    if (wsAuthed.readyState === WebSocket.OPEN) wsAuthed.close();
    if (wsAuthed.readyState !== WebSocket.CLOSED) await once(wsAuthed, 'close');

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
