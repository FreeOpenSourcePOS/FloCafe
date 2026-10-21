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
    console.log('kds-broadcast-grouping tests passed');
  } finally {
    await stopKdsServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
