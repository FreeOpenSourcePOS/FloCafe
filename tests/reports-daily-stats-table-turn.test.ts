/**
 * GET /api/reports/daily-stats — Avg Table Turn / Avg Current Occupancy (#595)
 *
 * Verifies avgTableTurnMinutes (avg duration of dine-in orders completed
 * today) and avgCurrentOccupancyMinutes (avg elapsed time of tables
 * currently occupied), including the "no qualifying rows -> null" case.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/reports-daily-stats-table-turn.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-daily-stats-table-turn-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-daily-stats-table-turn';

const express = require('express');
const expressRateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { reportRoutes } = require('../main/routes/reports');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  total++;
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

function dbTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

function minutesAgo(minutes: number): string {
  return dbTimestamp(new Date(Date.now() - minutes * 60 * 1000));
}

async function main() {
  console.log('GET /api/reports/daily-stats — avg table turn / occupancy');
  console.log('='.repeat(50));

  try {
    initDatabase();
  } catch (error: any) {
    if (isNativeAbiMismatch(error)) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77);
    }
    throw error;
  }

  const db = getDatabase();

  const ownerId = 'owner-daily-stats-turn';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(ownerId, 'Owner', 'owner-daily-stats-turn@test.local', bcrypt.hashSync('pw', 10), 'owner', now(), now());
  const waiterId = 'server-daily-stats-turn';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(waiterId, 'Server', 'server-daily-stats-turn@test.local', bcrypt.hashSync('pw', 10), 'server', now(), now());

  const app = express();
  app.use(express.json());
  // Uses express-rate-limit (rather than the app's in-memory rateLimit()) so
  // CodeQL recognizes this authorization route as rate-limited, mirroring
  // main/middleware/security.ts's staticRouteRateLimit() precedent.
  app.use(expressRateLimit({ windowMs: 60 * 1000, limit: 1000 }));
  app.use((req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
  app.use('/api/reports', reportRoutes);

  const ownerToken = jwt.sign({ userId: ownerId, email: 'owner-daily-stats-turn@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const waiterToken = jwt.sign({ userId: waiterId, email: 'server-daily-stats-turn@test.local', role: 'server' }, getJWTSecret(), { expiresIn: '1h' });

  try {
    console.log('\n1. Role gating');
    {
      const forbidden = await request(app).get('/api/reports/daily-stats').set('Authorization', `Bearer ${waiterToken}`);
      assertEqual(forbidden.status, 403, `server is forbidden (got ${forbidden.status})`);
    }

    console.log('\n2. Empty database: both metrics are null');
    {
      const res = await request(app).get('/api/reports/daily-stats').set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(res.status, 200, `owner gets 200 (got ${res.status})`);
      assertEqual(res.body.avgTableTurnMinutes, null, 'avgTableTurnMinutes is null with no completed dine-in orders today');
      assertEqual(res.body.avgCurrentOccupancyMinutes, null, 'avgCurrentOccupancyMinutes is null with no occupied tables');
    }

    console.log('\n3. Avg table turn: two completed dine-in orders today, 10 and 20 minutes long');
    {
      db.prepare(`INSERT INTO tables (id, number, capacity, status, created_at, updated_at) VALUES (?, ?, ?, 'available', ?, ?)`)
        .run('tbl-turn-1', 'TT1', 4, now(), now());

      // Anchor to noon of the store-local (Asia/Kolkata) day so fixtures fall
      // inside the report bounds no matter what UTC time the suite runs at.
      const kolkataParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const part = (type: string) => Number(kolkataParts.find((p) => p.type === type)?.value);
      const todayBase = new Date(Date.UTC(part('year'), part('month') - 1, part('day'), 6, 30)); // 12:00 IST
      const order1CreatedAt = dbTimestamp(new Date(todayBase.getTime()));
      const order1CompletedAt = dbTimestamp(new Date(todayBase.getTime() + 10 * 60 * 1000)); // 10 minutes
      db.prepare(`
        INSERT INTO orders (order_number, table_id, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, 'dine_in', 'completed', 100, 100, ?, ?, ?)
      `).run('ORD-TURN-1', 'tbl-turn-1', ownerId, order1CreatedAt, order1CompletedAt, order1CompletedAt);

      const order2CreatedAt = dbTimestamp(new Date(todayBase.getTime() + 20 * 60 * 1000));
      const order2CompletedAt = dbTimestamp(new Date(todayBase.getTime() + 40 * 60 * 1000)); // 20 minutes
      db.prepare(`
        INSERT INTO orders (order_number, table_id, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, 'dine_in', 'completed', 100, 100, ?, ?, ?)
      `).run('ORD-TURN-2', 'tbl-turn-1', ownerId, order2CreatedAt, order2CompletedAt, order2CompletedAt);

      // A takeaway order and a cancelled dine-in order must not count.
      db.prepare(`
        INSERT INTO orders (order_number, table_id, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
        VALUES (?, NULL, ?, 'takeaway', 'completed', 100, 100, ?, ?, ?)
      `).run('ORD-TURN-TAKEAWAY', ownerId, dbTimestamp(new Date(todayBase.getTime() + 50 * 60 * 1000)), dbTimestamp(new Date(todayBase.getTime() + 55 * 60 * 1000)), dbTimestamp(new Date(todayBase.getTime() + 55 * 60 * 1000)));
      db.prepare(`
        INSERT INTO orders (order_number, table_id, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, 'dine_in', 'cancelled', 100, 100, ?, ?, ?)
      `).run('ORD-TURN-CANCELLED', 'tbl-turn-1', ownerId, dbTimestamp(new Date(todayBase.getTime())), dbTimestamp(new Date(todayBase.getTime() + 55 * 60 * 1000)), dbTimestamp(new Date(todayBase.getTime() + 55 * 60 * 1000)));

      const res = await request(app).get('/api/reports/daily-stats').set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(res.status, 200, `owner gets 200 (got ${res.status})`);
      assertEqual(res.body.avgTableTurnMinutes, 15, 'avg table turn is (10+20)/2 = 15 minutes, excluding takeaway/cancelled orders');
    }

    console.log('\n4. Avg current occupancy: one occupied table, seated ~12 minutes ago');
    {
      db.prepare(`INSERT INTO tables (id, number, capacity, status, created_at, updated_at) VALUES (?, ?, ?, 'occupied', ?, ?)`)
        .run('tbl-occ-1', 'TT2', 4, now(), now());
      db.prepare(`
        INSERT INTO orders (order_number, table_id, user_id, type, status, subtotal, total, created_at, updated_at)
        VALUES (?, ?, ?, 'dine_in', 'preparing', 100, 100, ?, ?)
      `).run('ORD-OCC-1', 'tbl-occ-1', ownerId, minutesAgo(12), minutesAgo(12));

      const res = await request(app).get('/api/reports/daily-stats').set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(res.status, 200, `owner gets 200 (got ${res.status})`);
      assert(res.body.avgCurrentOccupancyMinutes !== null, 'avgCurrentOccupancyMinutes is populated once a table is occupied');
      assert(
        Math.abs(res.body.avgCurrentOccupancyMinutes - 12) <= 1,
        `avgCurrentOccupancyMinutes is ~12 (got ${res.body.avgCurrentOccupancyMinutes})`,
      );
      assertEqual(res.body.tablesOccupied, 1, 'tablesOccupied still counts the occupied table as before');
    }

  } finally {
    closeDatabase();
  }

  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
