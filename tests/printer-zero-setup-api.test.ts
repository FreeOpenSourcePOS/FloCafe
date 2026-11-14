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

let usbTestPrintResult: { ok: boolean; detail?: string } = { ok: true };
let usbDetectQueueStatus: 'idle' | 'offline' = 'offline';
let usbDetectCalls = 0;
let usbDetectDelayMs = 0;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  const loaded = originalLoad.apply(this, arguments as any);
  if (request === '../printers/thermal' || request === '../main/printers/thermal') {
    return new Proxy(loaded, {
      get(target, prop, receiver) {
        if (prop === 'printViaUSB') {
          return async () => usbTestPrintResult;
        }
        if (prop === 'detectConnectedPrinters') {
          return async () => {
            usbDetectCalls++;
            if (usbDetectDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, usbDetectDelayMs));
            }
            return [
              {
                name: 'Cached Usb Queue',
                make: 'Epson',
                model: 'TM-T20',
                connectionType: 'usb',
                deviceUri: 'usb://EPSON/TM-T20',
                status: usbDetectQueueStatus,
                isDefault: false,
              },
            ];
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
  return loaded;
};

const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const express = require('express');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { printerRoutes } = require('../main/routes/printers');
const { getPrinterStatus, setDiscoverScan } = require('../main/routes/printer-diagnostics');
const { guessPaperWidth, annotateProfile } = require('../main/printers/thermal');

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
      assertOrThrow(
        Buffer.from(paperOut.received).includes('Flo Printer Test') &&
          Buffer.from(paperOut.received).includes('Network / USB test print'),
        'the test page payload was sent before the probe',
      );
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

    // ── 6: Finding #1 single-connection test print + concurrent status probe ─
    console.log('\n6: single-connection test print + concurrent status');
    {
      const single = await start({ state: {}, singleConnection: true });
      fakes.push(single);
      const id = await addNetworkPrinter('SingleSocketTest', single.port);

      const [testRes, statusRes] = await Promise.all([
        request(app).post(`/api/printers/${id}/test`).send({ rasterProbe: true }),
        request(app).get(`/api/printers/${id}/status`),
      ]);
      assertEqualOrThrow(testRes.status, 200, 'single-connection test print succeeds');
      assertEqualOrThrow(statusRes.status, 200, 'concurrent status request succeeds');
      assertEqualOrThrow(
        statusRes.body.cause,
        null,
        'concurrent status never reports false unreachable',
      );
      assertEqualOrThrow(
        single.rejectedConnections,
        0,
        'single-connection printer saw zero rejected concurrent connections',
      );
      assertEqualOrThrow(
        single.maxConcurrentConnections,
        1,
        'single-connection printer saw at most 1 connection at a time',
      );
    }

    // ── 7: Finding #4 model/profile/paper_width auto-resolution ─────────────
    console.log('\n7: model + escpos-printer-db width/profile resolution');
    {
      assertEqualOrThrow(
        guessPaperWidth('Kitchen', 'Citizen CT-S651'),
        'cols-48',
        'guessPaperWidth falls back to findDbProfile for Citizen CT-S651',
      );
      const annotatedCitizen = annotateProfile({
        name: 'Kitchen',
        make: 'Citizen',
        model: 'CT-S651',
        connectionType: 'usb',
        deviceUri: 'usb://Citizen/CT-S651',
        status: 'idle',
        isDefault: false,
      });
      assertEqualOrThrow(
        annotatedCitizen.paperWidth,
        'cols-48',
        'annotateProfile preserves DB defaultPaperWidth for CT-S651',
      );
      assertEqualOrThrow(
        annotatedCitizen.profileId,
        'escpos-db-ct-s651',
        'annotateProfile attaches matched DB profileId',
      );
      assertEqualOrThrow(
        annotatedCitizen.compatibility,
        'escpos_thermal',
        'annotateProfile classifies DB thermal printer as escpos_thermal',
      );

      const lan58Res = await request(app).post('/api/printers').send({
        name: 'Front Counter',
        model: 'POS-5890',
        connection_type: 'network',
        ip_address: '192.168.1.90',
        port: 9100,
      });
      assertEqualOrThrow(lan58Res.status, 201, 'LAN quick-add with model creates printer');
      assertEqualOrThrow(
        lan58Res.body.printer.paper_width,
        'cols-32',
        'POS-5890 resolves cols-32 instead of cols-42',
      );
      assertEqualOrThrow(
        lan58Res.body.printer.configured_profile_id,
        'escpos-db-pos-5890',
        'matched DB profile_id is persisted when generic name alone would not match',
      );
      assertEqualOrThrow(
        lan58Res.body.printer.profile_id,
        'escpos-db-pos-5890',
        'printerShape keeps persisted DB profile_id',
      );

      const editRes = await request(app)
        .put(`/api/printers/${lan58Res.body.printer.id}`)
        .send({ port: 9101, profile_id: 'escpos-db-pos-5890' });
      assertEqualOrThrow(
        editRes.status,
        200,
        'editing port on a printer with persisted DB profile_id succeeds',
      );
      assertEqualOrThrow(
        editRes.body.printer.configured_profile_id,
        'escpos-db-pos-5890',
        'persisted DB profile_id is retained on edit',
      );
    }

    // ── 8: Finding #7 USB detect cache invalidation + fresh=1 ───────────────
    console.log('\n8: USB status cache invalidation after test print / detect / fresh=1');
    {
      const usbRes = await request(app)
        .post('/api/printers')
        .send({ name: 'Cached Usb Queue', connection_type: 'usb' });
      assertEqualOrThrow(usbRes.status, 201, 'cached USB fixture printer is created');
      const usbId = usbRes.body.printer.id as string;

      usbDetectQueueStatus = 'offline';
      const initialStatus = await request(app).get(`/api/printers/${usbId}/status`);
      assertEqualOrThrow(
        initialStatus.body.cause,
        'queue_offline',
        'initial status is queue_offline',
      );

      // Queue comes back online within 5 seconds; concurrent ?fresh=1 requests coalesce onto one scan.
      usbDetectQueueStatus = 'idle';
      usbDetectDelayMs = 60;
      const callsBeforeFresh = usbDetectCalls;
      const [freshStatus, coalescedFreshStatus] = await Promise.all([
        request(app).get(`/api/printers/${usbId}/status?fresh=1`),
        request(app).get(`/api/printers/${usbId}/status?fresh=1`),
      ]);
      usbDetectDelayMs = 0;
      assertEqualOrThrow(
        freshStatus.body.cause,
        null,
        '?fresh=1 bypasses the 5s cache and immediately sees idle',
      );
      assertEqualOrThrow(
        coalescedFreshStatus.body.cause,
        null,
        'concurrent ?fresh=1 request also receives idle',
      );
      assertEqualOrThrow(
        usbDetectCalls - callsBeforeFresh,
        1,
        'concurrent ?fresh=1 requests coalesce onto a single OS detection',
      );

      // Re-populate cache with offline, then verify POST /:id/test invalidates it.
      await request(app).get(`/api/printers/${usbId}/status?fresh=1`);
      usbDetectQueueStatus = 'offline';
      await request(app).get(`/api/printers/${usbId}/status?fresh=1`);
      usbDetectQueueStatus = 'idle';
      usbTestPrintResult = { ok: true };
      const testRes = await request(app).post(`/api/printers/${usbId}/test`).send({});
      assertEqualOrThrow(testRes.status, 200, 'USB test print succeeds');
      const afterTestStatus = await request(app).get(`/api/printers/${usbId}/status`);
      assertEqualOrThrow(
        afterTestStatus.body.cause,
        null,
        'status immediately reflects idle after USB test print invalidates cache',
      );

      // Re-populate cache with offline, then verify GET /detect invalidates it.
      usbDetectQueueStatus = 'offline';
      await request(app).get(`/api/printers/${usbId}/status?fresh=1`);
      usbDetectQueueStatus = 'idle';
      const detectRes = await request(app).get('/api/printers/detect');
      assertEqualOrThrow(detectRes.status, 200, 'GET /detect succeeds');
      const afterDetectStatus = await request(app).get(`/api/printers/${usbId}/status`);
      assertEqualOrThrow(
        afterDetectStatus.body.cause,
        null,
        'status immediately reflects idle after GET /detect invalidates cache',
      );
    }

    // ── 9: Finding #9b ip_address trim/cleanup & isSaved consistency ────────
    console.log('\n9: ip_address trim, cleanup on USB switch, and isSaved');
    {
      const paddedNet = await request(app).post('/api/printers').send({
        name: 'Padded IP Printer',
        connection_type: 'network',
        ip_address: ' 192.168.1.91 ',
        port: 9100,
      });
      assertEqualOrThrow(paddedNet.status, 201, 'padded IP printer is created');
      assertEqualOrThrow(
        paddedNet.body.printer.ip_address,
        '192.168.1.91',
        'POST trims ip_address before saving',
      );

      const switchToUsb = await request(app)
        .put(`/api/printers/${paddedNet.body.printer.id}`)
        .send({ connection_type: 'usb' });
      assertEqualOrThrow(switchToUsb.status, 200, 'switching network printer to usb succeeds');
      assertEqualOrThrow(
        switchToUsb.body.printer.ip_address,
        null,
        'switching to usb clears stale ip_address',
      );

      setDiscoverScan(async () => [
        { address: '192.168.1.91', port: 9100, name: 'LAN 91', source: 'port-scan' },
      ]);
      const discRes = await request(app).get('/api/printers/discover');
      assertEqualOrThrow(
        discRes.body.printers[0].saved,
        false,
        'cleared USB printer no longer marks 192.168.1.91 as saved',
      );
    }

    // ── 10: Finding #8 delivery slip 502 includes connection_type ───────────
    console.log('\n10: POST /print-delivery-slip 502 includes connection_type');
    {
      const closed = await closedPort();
      const netRes = await request(app).post('/api/printers').send({
        name: 'Delivery Slip Net',
        connection_type: 'network',
        ip_address: '127.0.0.1',
        port: closed,
        is_default: true,
      });
      assertEqualOrThrow(netRes.status, 201, 'default network printer created');
      db.prepare('UPDATE printers SET is_default = 0 WHERE id != ?').run(netRes.body.printer.id);

      const orderInfo = db
        .prepare(
          `INSERT INTO orders (order_number, status, type, subtotal, total, delivery_address, created_at, updated_at)
           VALUES ('ORD-DEL-502', 'pending', 'delivery', 10, 10, '10 Main St', ?, ?)`,
        )
        .run(now(), now());

      const slipRes = await request(app)
        .post('/api/printers/print-delivery-slip')
        .send({ orderId: Number(orderInfo.lastInsertRowid) });
      assertEqualOrThrow(slipRes.status, 502, 'delivery slip to closed port returns 502');
      assertEqualOrThrow(
        slipRes.body.connection_type,
        'network',
        'delivery slip 502 payload includes connection_type',
      );
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
