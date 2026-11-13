/**
 * Printer zero-setup API (supertest): status probe, LAN discovery, test-print cause.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/printer-zero-setup-api.test.ts
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { start, type FakeEscposPrinter } from './helpers/fake-escpos-printer';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-zero-setup-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const express = require('express');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { printerRoutes } = require('../main/routes/printers');
const { getPrinterStatus, setDiscoverScan } = require('../main/routes/printer-diagnostics');

let currentUserId = 'owner-1';

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

/** A port nothing listens on: bind it, learn the number, close it. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function runTests() {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('owner-1', 'Owner', 'owner@flo.local', 'unused', 'owner', 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('server-1', 'Server', 'server@flo.local', 'unused', 'server', 1, ?, ?)`,
  ).run(now(), now());
  for (const [key, value] of [
    ['country', 'IN'],
    ['currency', 'INR'],
    ['timezone', 'Asia/Kolkata'],
  ]) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(key, value, now());
  }

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = {
      userId: currentUserId,
      email: currentUserId === 'server-1' ? 'server@flo.local' : 'owner@flo.local',
      role: currentUserId === 'server-1' ? 'server' : 'owner',
    };
    next();
  });
  app.use('/api/printers', printerRoutes);

  async function addNetworkPrinter(name: string, port: number) {
    const res = await request(app).post('/api/printers').send({
      name,
      connection_type: 'network',
      ip_address: '127.0.0.1',
      port,
    });
    assertEqualOrThrow(res.status, 201, `fixture printer "${name}" is created`);
    return res.body.printer.id as string;
  }

  const fakes: FakeEscposPrinter[] = [];
  try {
    console.log('Printer zero-setup API tests (supertest)');
    console.log('='.repeat(50));

    // ── 1: network status probe ────────────────────────────────────────────
    console.log('\n1: GET /:id/status for network printers');
    {
      const online = await start({});
      const paperOut = await start({ state: { paper: 'out' } });
      const coverOpen = await start({ state: { coverOpen: true } });
      const silent = await start({ silent: true });
      fakes.push(online, paperOut, coverOpen, silent);

      const onlineId = await addNetworkPrinter('Online', online.port);
      const paperOutId = await addNetworkPrinter('PaperOut', paperOut.port);
      const coverOpenId = await addNetworkPrinter('CoverOpen', coverOpen.port);
      const silentId = await addNetworkPrinter('Silent', silent.port);
      const closedPortId = await addNetworkPrinter('ClosedPort', await closedPort());

      const onlineRes = await request(app).get(`/api/printers/${onlineId}/status`);
      assertEqualOrThrow(onlineRes.status, 200, 'an online printer answers 200');
      assertEqualOrThrow(onlineRes.body.connection_type, 'network', 'it reports the network type');
      assertEqualOrThrow(onlineRes.body.answered, true, 'it answered the status queries');
      assertEqualOrThrow(onlineRes.body.reachable, true, 'its socket was reachable');
      assertEqualOrThrow(onlineRes.body.cause, null, 'an online printer has no cause');
      assertEqualOrThrow(onlineRes.body.paperOut, false, 'its paper sensor is clear');

      const paperRes = await request(app).get(`/api/printers/${paperOutId}/status`);
      assertEqualOrThrow(paperRes.body.cause, 'paper_out', 'paper out is reported as paper_out');

      const coverRes = await request(app).get(`/api/printers/${coverOpenId}/status`);
      assertEqualOrThrow(coverRes.body.cause, 'cover_open', 'an open cover is cover_open');

      const silentRes = await request(app).get(`/api/printers/${silentId}/status`);
      assertEqualOrThrow(silentRes.body.answered, false, 'a silent clone never answers');
      assertEqualOrThrow(silentRes.body.cause, null, 'a silent clone has no detectable cause');

      const closedRes = await request(app).get(`/api/printers/${closedPortId}/status`);
      assertEqualOrThrow(closedRes.body.reachable, false, 'a closed port is not reachable');
      assertEqualOrThrow(closedRes.body.cause, 'unreachable', 'a closed port is unreachable');

      const padded = await getPrinterStatus({
        connection_type: 'network',
        ip_address: ' 127.0.0.1 ',
        port: online.port,
      });
      assertEqualOrThrow(
        padded.reachable,
        true,
        'a stored address with spaces is probed like print',
      );

      const missingRes = await request(app).get('/api/printers/does-not-exist/status');
      assertEqualOrThrow(missingRes.status, 404, 'an unknown printer id answers 404');
    }

    // ── 2: usb queue status ────────────────────────────────────────────────
    console.log('\n2: usb queue status');
    {
      const usbRes = await request(app)
        .post('/api/printers')
        .send({ name: 'Kitchen Queue', connection_type: 'usb' });
      assertEqualOrThrow(usbRes.status, 201, 'usb fixture printer is created');
      const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(usbRes.body.printer.id);

      const offline = await getPrinterStatus(printer, undefined, async () => [
        { name: 'Kitchen Queue', status: 'offline' },
      ]);
      assertEqualOrThrow(offline.queue_status, 'offline', 'a matching offline queue is offline');
      assertEqualOrThrow(offline.cause, 'queue_offline', 'an offline queue reports queue_offline');

      const missing = await getPrinterStatus(printer, undefined, async () => [
        { name: 'Other Queue', status: 'idle' },
      ]);
      assertEqualOrThrow(missing.queue_status, 'missing', 'an absent queue is missing');
      assertEqualOrThrow(missing.cause, 'queue_missing', 'an absent queue reports queue_missing');

      const idle = await getPrinterStatus(printer, undefined, async () => [
        { name: 'Kitchen Queue', status: 'idle' },
      ]);
      assertEqualOrThrow(idle.cause, null, 'a ready queue has no cause');

      const netModule = require('net');
      const realConnect = netModule.connect;
      let connects = 0;
      netModule.connect = (...args: any[]) => {
        connects++;
        return realConnect(...args);
      };
      try {
        const metadata = await getPrinterStatus({
          ...printer,
          connection_type: 'network',
          ip_address: '169.254.169.254',
          port: 80,
        });
        assertEqualOrThrow(metadata.cause, 'unreachable', 'a blocked stored target is unreachable');
      } finally {
        netModule.connect = realConnect;
      }
      assertEqualOrThrow(connects, 0, 'a blocked stored target is never probed');
    }

    // ── 3: test print with paper out ───────────────────────────────────────
    console.log('\n3: POST /:id/test with paper out');
    {
      const paperOut = await start({ state: { paper: 'out' } });
      fakes.push(paperOut);
      const id = await addNetworkPrinter('PaperOutTest', paperOut.port);

      const res = await request(app).post(`/api/printers/${id}/test`).send({});
      assertEqualOrThrow(res.status, 502, 'a test print to a paper-out printer answers 502');
      assertEqualOrThrow(res.body.cause, 'paper_out', 'the failure carries cause paper_out');
      assertOrThrow(
        typeof res.body.failure_class === 'string' && res.body.failure_class.length > 0,
        'the failure carries a failure_class',
      );
      await new Promise((resolve) => setImmediate(resolve));
      assertEqualOrThrow(paperOut.printed.length, 0, 'the printer kept no printed bytes');
      assertOrThrow(paperOut.received.length > 0, 'the test page was sent before the probe');
    }

    // ── 4: LAN discovery ───────────────────────────────────────────────────
    console.log('\n4: GET /discover');
    {
      const savedId = await addNetworkPrinter('SavedLan', 9100);
      db.prepare('UPDATE printers SET ip_address = ? WHERE id = ?').run('192.168.1.50', savedId);

      let scans = 0;
      setDiscoverScan(async () => {
        scans++;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return [
          {
            address: '192.168.1.50',
            port: 9100,
            name: 'Saved Lan',
            source: 'both',
          },
          {
            address: '192.168.1.51',
            port: 9100,
            name: 'New Lan',
            source: 'port-scan',
          },
        ];
      });

      const [first, second] = await Promise.all([
        request(app).get('/api/printers/discover'),
        request(app).get('/api/printers/discover'),
      ]);
      assertEqualOrThrow(first.status, 200, 'discover answers 200');
      assertEqualOrThrow(second.status, 200, 'the concurrent discover also answers 200');
      assertEqualOrThrow(scans, 1, 'two concurrent requests share one scan');
      assertEqualOrThrow(first.body.printers.length, 2, 'both LAN printers are returned');
      assertEqualOrThrow(
        first.body.printers.find((p: any) => p.address === '192.168.1.50').saved,
        true,
        'a saved printer address is marked saved',
      );
      assertEqualOrThrow(
        first.body.printers.find((p: any) => p.address === '192.168.1.51').saved,
        false,
        'an unsaved printer address is not saved',
      );
    }

    // ── 5: permission ──────────────────────────────────────────────────────
    console.log('\n5: printers.manage permission');
    {
      currentUserId = 'server-1';
      const discoverDenied = await request(app).get('/api/printers/discover');
      assertEqualOrThrow(discoverDenied.status, 403, 'discover needs printers.manage');
      const statusDenied = await request(app).get('/api/printers/anything/status');
      assertEqualOrThrow(statusDenied.status, 403, 'the status probe needs printers.manage');
      currentUserId = 'owner-1';
    }
  } finally {
    setDiscoverScan(require('../main/printers/lan-discovery').discoverLanPrinters);
    for (const fake of fakes) await fake.close();
  }
}

try {
  initDatabase();
} catch (error: any) {
  if (isNativeAbiMismatch(error)) {
    console.log('  ⚠ Skipping: better-sqlite3 is not built for this shell Node ABI.');
    process.exit(77);
  }
  throw error;
}

runTests()
  .then(() => {
    closeDatabase();
    console.log('\nAll printer zero-setup API checks passed.');
    process.exit(0);
  })
  .catch((error: any) => {
    console.error('\n✗ FAILED:', error?.message || error);
    process.exit(1);
  });
