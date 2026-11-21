/**
 * LAN printer discovery: the /24 target list, the port 9100 probe, the mDNS browse and the
 * merge of both. Every network call is injected here so the suite never scans a real network.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/lan-discovery.test.ts
 */
import * as net from 'net';

import { probeNetworkPrinterStatus, statusToFailureCause } from '../main/printers/escpos-status';
import {
  browseMdns,
  discoverLanPrinters,
  localScanTargets,
  probePort,
  scanPort9100,
} from '../main/printers/lan-discovery';
import * as networkPortLock from '../main/printers/network-port-lock';
import { printViaNetwork } from '../main/printers/thermal';
import { getServerPort, setServerPort } from '../main/server-state';
import { start } from './helpers/fake-escpos-printer';

const { assertEqualOrThrow, assertOrThrow } = require('./helpers/test-setup');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await delay(10);
}

function iface(address: string, netmask = '255.255.255.0', internal = false) {
  return [{ address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null }];
}

function scanTargetsTest() {
  const targets = localScanTargets({ eth0: iface('192.168.1.10') } as any);
  assertEqualOrThrow(targets.length, 253, 'a private /24 gives 253 hosts');
  assertOrThrow(!targets.includes('192.168.1.10'), 'the machine own address is left out');
  assertOrThrow(targets.includes('192.168.1.1'), 'the list starts at .1');
  assertOrThrow(targets.includes('192.168.1.254'), 'the list ends at .254');

  assertEqualOrThrow(
    localScanTargets({ eth0: iface('8.8.8.10') } as any).length,
    0,
    'a public address is never scanned',
  );

  const skipped = localScanTargets({
    docker0: iface('172.17.0.1'),
    'br-abc123def456': iface('172.18.0.1'),
    virbr0: iface('192.168.122.1'),
    wg0: iface('10.8.0.1'),
    linklocal: iface('169.254.3.4'),
    wlan0: iface('192.168.5.20'),
  } as any);
  assertOrThrow(
    skipped.every((host) => host.startsWith('192.168.5.')),
    'docker0, br-*, virbr*, wg*, and 169.254 are skipped',
  );
  assertEqualOrThrow(skipped.length, 253, 'only the private interface is scanned');

  // /25../30 subnets compute exact usable host ranges; /31 and /32 are skipped.
  const slash25Low = localScanTargets({
    eth0: iface('192.168.1.10', '255.255.255.128'),
  } as any);
  assertEqualOrThrow(slash25Low.length, 125, 'a /25 gives 125 usable hosts');
  assertOrThrow(slash25Low.includes('192.168.1.1'), '/25 low half starts at .1');
  assertOrThrow(slash25Low.includes('192.168.1.126'), '/25 low half ends at .126');
  assertOrThrow(!slash25Low.includes('192.168.1.127'), '/25 low half excludes broadcast .127');

  const slash25High = localScanTargets({
    eth0: iface('192.168.1.200', '255.255.255.128'),
  } as any);
  assertEqualOrThrow(slash25High.length, 125, '/25 high half gives 125 usable hosts');
  assertOrThrow(slash25High.includes('192.168.1.129'), '/25 high half starts at .129');
  assertOrThrow(slash25High.includes('192.168.1.254'), '/25 high half ends at .254');

  const slash26 = localScanTargets({
    eth0: iface('192.168.1.70', '255.255.255.192'),
  } as any);
  assertEqualOrThrow(slash26.length, 61, 'a /26 gives 61 usable hosts');
  assertOrThrow(slash26.includes('192.168.1.65'), '/26 starts at .65');
  assertOrThrow(slash26.includes('192.168.1.126'), '/26 ends at .126');

  const slash30 = localScanTargets({
    eth0: iface('192.168.1.5', '255.255.255.252'),
  } as any);
  assertEqualOrThrow(slash30.join(','), '192.168.1.6', 'a /30 gives the single peer host');

  assertEqualOrThrow(
    localScanTargets({ eth0: iface('192.168.1.1', '255.255.255.254') } as any).length,
    0,
    'a /31 is skipped',
  );
  assertEqualOrThrow(
    localScanTargets({ eth0: iface('192.168.1.1', '255.255.255.255') } as any).length,
    0,
    'a /32 is skipped',
  );

  const capped = localScanTargets({
    a: iface('10.1.0.10'),
    b: iface('10.2.0.10'),
    c: iface('10.3.0.10'),
    d: iface('10.4.0.10'),
    e: iface('10.5.0.10'),
    f: iface('10.6.0.10'),
  } as any);
  const networks = new Set(capped.map((host) => host.split('.').slice(0, 3).join('.')));
  assertEqualOrThrow(networks.size, 4, 'six private interfaces are capped to four networks');
  assertEqualOrThrow(capped.length, 4 * 253, 'the cap keeps 4 x 253 hosts');
}

async function probePortTest() {
  let received = 0;
  let closed = false;
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      received += chunk.length;
    });
    socket.on('close', () => {
      closed = true;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  assertEqualOrThrow(await probePort('127.0.0.1', port, 500), true, 'an open port answers true');
  await waitFor(() => closed, 1000);
  assertOrThrow(closed, 'the probe closes the connection at once');
  assertEqualOrThrow(received, 0, 'the probe sends no bytes');
  await new Promise<void>((resolve) => server.close(() => resolve()));

  assertEqualOrThrow(await probePort('127.0.0.1', port, 500), false, 'a closed port answers false');

  const abortedController = new AbortController();
  abortedController.abort();
  assertEqualOrThrow(
    await probePort('127.0.0.1', port, 500, abortedController.signal),
    false,
    'an aborted signal makes probePort answer false',
  );
}

async function scanPort9100Test() {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const found = await scanPort9100(['127.0.0.1', '127.0.0.9'], { port, timeoutMs: 400 });
  assertEqualOrThrow(found.length, 1, 'only the live host is returned');
  assertEqualOrThrow(found[0], '127.0.0.1', 'the live host is the one that answered');
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const controller = new AbortController();
  const hosts = Array.from({ length: 200 }, (_, index) => `10.0.0.${index}`);
  const pending = scanPort9100(hosts, {
    concurrency: 2,
    signal: controller.signal,
    probe: async () => {
      await delay(5);
      return true;
    },
  });
  await delay(20);
  controller.abort();
  const aborted = await pending;
  assertOrThrow(aborted.length < hosts.length, 'an aborted signal stops the scan');
}

async function browseMdnsTest() {
  const services: any[] = [];
  let stopped = 0;
  let destroyed = 0;
  const printers = await browseMdns({
    timeoutMs: 30,
    bonjourFactory: () => ({
      find: (_options: { type: string }, onUp: (service: any) => void) => {
        services.push(onUp);
        return {
          stop: () => {
            stopped++;
          },
          destroy: () => {
            destroyed++;
          },
        };
      },
      destroy: () => {
        destroyed++;
      },
    }),
  });
  assertEqualOrThrow(services.length, 3, 'the three printer mDNS types are browsed');
  const withHit = await browseMdns({
    timeoutMs: 30,
    bonjourFactory: () => ({
      find: (options: { type: string }, onUp: (service: any) => void) => {
        setTimeout(
          () =>
            onUp({
              name: 'Back Office',
              host: 'printer.local',
              addresses: ['192.168.1.70'],
              port: options.type === 'pdl-datastream' ? 9101 : 631,
              txt: { ty: ['Brother QL-820NWB'] },
            }),
          0,
        );
        return { stop: () => undefined };
      },
      destroy: () => undefined,
    }),
  });
  assertEqualOrThrow(
    withHit.map((hit) => hit.port).join(','),
    '9101,631',
    'pdl-datastream keeps its raw port and IPP keeps its advertised port 631',
  );
  assertEqualOrThrow(withHit[0].address, '192.168.1.70', 'the printer IPv4 address is read');
  assertEqualOrThrow(withHit[0].name, 'Back Office', 'the friendly name is kept');

  assertEqualOrThrow(printers.length, 0, 'no answer gives no printer');
  assertEqualOrThrow(stopped, 3, 'each browser is stopped');
  assertEqualOrThrow(destroyed, 4, 'every browser and the Bonjour instance are destroyed');

  // AbortSignal stops browseMdns immediately and tears down browsers/bonjour.
  const abortController = new AbortController();
  let abortDestroyed = 0;
  const startedAt = Date.now();
  const browsePending = browseMdns({
    timeoutMs: 5000,
    signal: abortController.signal,
    bonjourFactory: () => ({
      find: () => ({
        stop: () => undefined,
        destroy: () => {
          abortDestroyed++;
        },
      }),
      destroy: () => {
        abortDestroyed++;
      },
    }),
  });
  await delay(10);
  abortController.abort();
  await browsePending;
  const elapsed = Date.now() - startedAt;
  assertOrThrow(elapsed < 500, `aborted browseMdns settles promptly (${elapsed}ms)`);
  assertEqualOrThrow(abortDestroyed, 4, 'aborted browseMdns destroys all browsers and Bonjour');
}

async function discoverLanPrintersTest() {
  const printers = await discoverLanPrinters({
    hosts: ['192.168.1.50', '192.168.1.60', '192.168.1.70', '192.168.1.71', '192.168.1.72'],
    probe: async (host, port) => {
      if (host === '192.168.1.50' && port === 9100) return true;
      if (host === '192.168.1.60' && port === 9100) return true;
      // 192.168.1.70: 9100 closed, custom pdl-datastream port 9101 open
      if (host === '192.168.1.70' && port === 9101) return true;
      // 192.168.1.71: IPP-only office printer with 9100 closed -> must be rejected
      // 192.168.1.72: HP LaserJet with 9100 open (JetDirect) -> driver_only must be rejected
      if (host === '192.168.1.72' && port === 9100) return true;
      return false;
    },
    browse: async () => [
      {
        type: 'pdl-datastream',
        name: 'Front Desk XP-80',
        host: 'printer.local',
        address: '192.168.1.50',
        port: 9101,
        txt: { ty: ['XPrinter XP-80'] },
      },
      {
        type: 'pdl-datastream',
        name: 'Custom Port Receipt',
        host: 'custom.local',
        address: '192.168.1.70',
        port: 9101,
      },
      {
        type: 'ipp',
        name: 'Custom Port Receipt',
        host: 'custom.local',
        address: '192.168.1.70',
        port: 631,
        txt: { ty: ['EPSON TM-T88V'] },
      },
      {
        type: 'ipp',
        name: 'Office AirPrint Inkjet',
        host: 'office.local',
        address: '192.168.1.71',
        port: 631,
        txt: { product: ['Brother QL-820NWB'] },
      },
      {
        type: 'pdl-datastream',
        name: 'HP LaserJet Pro M404',
        host: 'laser.local',
        address: '192.168.1.72',
        port: 9100,
        txt: { ty: ['HP LaserJet Pro'] },
      },
    ],
  });

  assertEqualOrThrow(
    printers.map((printer) => printer.address).join(','),
    '192.168.1.50,192.168.1.60,192.168.1.70',
    'IPP-only closed-9100 and driver-only office printers are excluded',
  );
  const [both, portOnly, customPdl] = printers;
  assertEqualOrThrow(both.source, 'both', 'an address seen both ways is marked both');
  assertEqualOrThrow(both.name, 'Front Desk XP-80', 'the mDNS name wins over the generic name');
  assertEqualOrThrow(both.model, 'XPrinter XP-80', 'the model comes from the ty TXT record');
  assertEqualOrThrow(both.port, 9100, 'a port that answered the scan wins over the mDNS port');
  assertEqualOrThrow(portOnly.source, 'port-scan', 'a port-only hit is marked port-scan');
  assertEqualOrThrow(
    portOnly.name,
    'Network printer (192.168.1.60)',
    'a port-only hit gets the generic name',
  );
  assertEqualOrThrow(portOnly.port, 9100, 'a port-only hit reports the probed port');
  assertEqualOrThrow(customPdl.source, 'mdns', 'pdl-datastream custom port hit is marked mdns');
  assertEqualOrThrow(
    customPdl.port,
    9101,
    'dual-service pdl-datastream + ipp preserves raw port 9101 when 9100 is closed',
  );
  assertEqualOrThrow(
    customPdl.model,
    'EPSON TM-T88V',
    'model metadata enriches from companion IPP TXT when pdl-datastream lacks TXT',
  );

  // An _ipp._tcp thermal printer that was not in the host scan list is probed on 9100.
  const ippWith9100Open = await discoverLanPrinters({
    hosts: [],
    probe: async (host, port) => host === '192.168.1.80' && port === 9100,
    browse: async () => [
      {
        type: 'ipp',
        name: 'Counter Thermal',
        host: 'counter.local',
        address: '192.168.1.80',
        port: 631,
      },
      {
        type: 'ipp',
        name: 'Upstairs Office Printer',
        host: 'upstairs.local',
        address: '192.168.1.81',
        port: 631,
      },
    ],
  });
  assertEqualOrThrow(
    ippWith9100Open.map((p) => `${p.address}:${p.port}`).join(','),
    '192.168.1.80:9100',
    'IPP mDNS entry is included on 9100 only when 9100 is confirmed open',
  );
}

async function networkPortLockWaiterAbortTest() {
  const events: string[] = [];
  let releaseOp1!: () => void;
  const op1Hold = new Promise<void>((resolve) => {
    releaseOp1 = resolve;
  });

  const op1 = networkPortLock.withNetworkPortLock('127.0.0.1', 19100, async () => {
    events.push('op1:start');
    await op1Hold;
    events.push('op1:end');
    return 'op1';
  });

  await waitFor(() => events.includes('op1:start'), 500);

  const op2Controller = new AbortController();
  let op2Ran = false;
  const op2 = networkPortLock
    .withNetworkPortLock(
      '127.0.0.1',
      19100,
      async () => {
        op2Ran = true;
      },
      op2Controller.signal,
    )
    .catch((error: Error) => error.message);

  await delay(10);
  op2Controller.abort();
  assertEqualOrThrow(await op2, 'aborted', 'aborted waiter rejects immediately');
  assertEqualOrThrow(op2Ran, false, 'aborted waiter never invokes callback');

  let op3StartedWhileOp1Held = false;
  const op3 = networkPortLock.withNetworkPortLock('127.0.0.1', 19100, async () => {
    if (!events.includes('op1:end')) {
      op3StartedWhileOp1Held = true;
    }
    events.push('op3:start');
    await delay(10);
    events.push('op3:end');
    return 'op3';
  });

  await delay(30);
  assertEqualOrThrow(
    op3StartedWhileOp1Held,
    false,
    'Op 3 must not enter the lock while Op 1 still holds it after Op 2 aborts',
  );
  assertEqualOrThrow(events.includes('op3:start'), false, 'Op 3 stays queued until Op 1 finishes');

  releaseOp1();
  const [r1, r3] = await Promise.all([op1, op3]);
  assertEqualOrThrow(r1, 'op1', 'Op 1 resolves cleanly');
  assertEqualOrThrow(r3, 'op3', 'Op 3 resolves after Op 1');
  assertEqualOrThrow(
    events.join(','),
    'op1:start,op1:end,op3:start,op3:end',
    'FIFO exclusion holds across aborted waiters',
  );

  // Chained waiter aborts with no trailing caller must still clean up endpointChains once Op A settles.
  let releaseOpA!: () => void;
  const opAHold = new Promise<void>((resolve) => {
    releaseOpA = resolve;
  });
  const opA = networkPortLock.withNetworkPortLock('127.0.0.1', 19101, () => opAHold);
  const ctrlB = new AbortController();
  const ctrlC = new AbortController();
  const opB = networkPortLock
    .withNetworkPortLock('127.0.0.1', 19101, async () => undefined, ctrlB.signal)
    .catch(() => 'aborted');
  const opC = networkPortLock
    .withNetworkPortLock('127.0.0.1', 19101, async () => undefined, ctrlC.signal)
    .catch(() => 'aborted');
  await delay(10);
  ctrlB.abort();
  ctrlC.abort();
  await Promise.all([opB, opC]);
  releaseOpA();
  await opA;
  await delay(10);

  const pendingCountFn = (networkPortLock as { pendingNetworkEndpointCount?: () => number })
    .pendingNetworkEndpointCount;
  assertEqualOrThrow(
    typeof pendingCountFn === 'function' ? pendingCountFn() : -1,
    0,
    'endpoint lock map has zero leaked entries once all chains settle',
  );
}

async function singleConnectionPrintProbeAndDiscoveryTest() {
  const printer = await start({ state: {}, singleConnection: true });
  try {
    // 64 KB forces multi-chunk TCP streaming (~240 ms) so discovery and status arrive mid-print.
    const payload = Buffer.alloc(64 * 1024, 0x41);
    const printPromise = printViaNetwork('127.0.0.1', printer.port, payload);
    await waitFor(() => printer.connections >= 1, 1000);

    // Discovery's per-socket connect timeout (100 ms) is shorter than the remaining print time,
    // proving probePort waits for the endpoint lock before starting its connect timeout.
    const statusPromise = probeNetworkPrinterStatus('127.0.0.1', printer.port, { timeoutMs: 600 });
    const scanPromise = scanPort9100(['127.0.0.1'], { port: printer.port, timeoutMs: 100 });

    const [printResult, statusResult, discovered] = await Promise.all([
      printPromise,
      statusPromise,
      scanPromise,
    ]);

    assertEqualOrThrow(printResult.ok, true, 'concurrent receipt/KOT print job succeeds');
    assertEqualOrThrow(
      printer.printed.length,
      payload.length,
      'single-connection printer keeps every receipt byte intact',
    );
    assertEqualOrThrow(statusResult.reachable, true, 'concurrent status probe stays reachable');
    assertEqualOrThrow(statusResult.answered, true, 'concurrent status probe gets DLE EOT reply');
    assertEqualOrThrow(
      statusToFailureCause(statusResult),
      null,
      'concurrent status probe reports no false fault',
    );
    assertEqualOrThrow(
      discovered.join(','),
      '127.0.0.1',
      'scanPort9100 still discovers the busy single-connection printer',
    );
    assertEqualOrThrow(
      printer.rejectedConnections,
      0,
      'single-connection printer saw zero colliding TCP connections',
    );
    assertEqualOrThrow(
      printer.maxConcurrentConnections,
      1,
      'print, status probe, and LAN discovery never overlapped on the socket',
    );
  } finally {
    await printer.close();
  }
}

async function targetValidationTest() {
  const connectCalls: string[] = [];
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const first = args[0];
    if (first && typeof first === 'object') {
      connectCalls.push(`${first.host ?? ''}:${first.port ?? ''}`);
    } else {
      connectCalls.push(`${args[1] ?? ''}:${args[0] ?? ''}`);
    }
    return origConnect.apply(this, args as any);
  } as typeof net.Socket.prototype.connect;

  let releaseHeldLock!: () => void;
  const heldLockPromise = new Promise<void>((resolve) => {
    releaseHeldLock = resolve;
  });
  let lockStarted = false;
  const heldLock = networkPortLock.withNetworkPortLock('169.254.169.254', 80, async () => {
    lockStarted = true;
    await heldLockPromise;
  });

  const apiMockServer = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => apiMockServer.listen(0, '127.0.0.1', resolve));
  const apiMockPort = (apiMockServer.address() as net.AddressInfo).port;
  let apiMockConnections = 0;
  apiMockServer.on('connection', () => {
    apiMockConnections++;
  });
  const previousServerPort = getServerPort();

  try {
    await waitFor(() => lockStarted, 500);
    // Rejecting before withNetworkPortLock avoids waiting on a held lock for a disallowed target.
    assertEqualOrThrow(
      await probePort('169.254.169.254', 80, 500),
      false,
      'probePort rejects 169.254.169.254:80 without acquiring lock or opening a socket',
    );
    assertEqualOrThrow(
      await probePort('127.0.0.1', 3001, 500),
      false,
      'probePort rejects local FloCafe API port 127.0.0.1:3001',
    );
    assertEqualOrThrow(
      await probePort('0.0.0.0', 9100, 500),
      false,
      'probePort rejects unspecified address 0.0.0.0:9100',
    );
    assertEqualOrThrow(await probePort('192.168.1.50', 0, 500), false, 'probePort rejects port 0');
    assertEqualOrThrow(
      await probePort('192.168.1.50', 70000, 500),
      false,
      'probePort rejects out-of-range port 70000',
    );

    setServerPort(apiMockPort);
    assertEqualOrThrow(
      await probePort('127.0.0.1', apiMockPort, 500),
      false,
      'probePort rejects active FloCafe server port even when listening on 127.0.0.1',
    );
    assertEqualOrThrow(
      apiMockConnections,
      0,
      'listening server on active FloCafe port receives zero probe connections',
    );
    assertEqualOrThrow(
      connectCalls.length,
      0,
      'production probePort never opens a socket for disallowed targets',
    );
  } finally {
    setServerPort(previousServerPort);
    releaseHeldLock();
    await heldLock;
    net.Socket.prototype.connect = origConnect;
    await new Promise<void>((resolve) => apiMockServer.close(() => resolve()));
  }

  const probedTargets: string[] = [];
  const discovered = await discoverLanPrinters({
    hosts: ['169.254.169.254', '0.0.0.0', '192.168.1.50', '192.168.1.51'],
    probe: async (host, port) => {
      probedTargets.push(`${host}:${port}`);
      return true;
    },
    browse: async () => [
      {
        type: 'pdl-datastream',
        name: 'Cloud Metadata SSRF',
        host: 'metadata.local',
        address: '169.254.169.254',
        port: 80,
      },
      {
        type: 'ipp',
        name: 'Cloud Metadata IPP',
        host: 'metadata-ipp.local',
        address: '169.254.169.254',
        port: 631,
      },
      {
        type: 'pdl-datastream',
        name: 'FloCafe API Port',
        host: 'localhost',
        address: '127.0.0.1',
        port: 3001,
      },
      {
        type: 'pdl-datastream',
        name: 'Unspecified Address',
        host: 'unspec.local',
        address: '0.0.0.0',
        port: 9100,
      },
      {
        type: 'pdl-datastream',
        name: 'Invalid Port Printer',
        host: 'badport.local',
        address: '192.168.1.55',
        port: 70000,
      },
      {
        type: 'pdl-datastream',
        name: 'Loopback Simulator',
        host: 'sim.local',
        address: '127.0.0.1',
        port: 9100,
      },
      {
        type: 'pdl-datastream',
        name: 'Front Counter',
        host: 'counter.local',
        address: '192.168.1.50',
        port: 9100,
      },
      {
        type: 'pdl-datastream',
        name: 'Kitchen Printer',
        host: 'kitchen.local',
        address: '192.168.1.52',
        port: 9101,
      },
    ],
  });

  for (const disallowed of [
    '169.254.169.254:80',
    '169.254.169.254:9100',
    '127.0.0.1:3001',
    '0.0.0.0:9100',
    '192.168.1.55:70000',
  ]) {
    assertOrThrow(
      !probedTargets.includes(disallowed),
      `discoverLanPrinters never invokes probe for disallowed target ${disallowed}`,
    );
  }

  assertEqualOrThrow(
    discovered.map((p) => `${p.address}:${p.port}:${p.source}`).join(','),
    '127.0.0.1:9100:mdns,192.168.1.50:9100:both,192.168.1.51:9100:port-scan,192.168.1.52:9101:mdns',
    'discoverLanPrinters filters disallowed targets while preserving valid LAN and non-FloCafe 127.0.0.1:9100 printers',
  );

  const blockedLocalApiScan = await discoverLanPrinters({
    hosts: ['127.0.0.1'],
    port: 3001,
    probe: async () => true,
    browse: async () => [
      {
        type: 'ipp',
        name: 'Local API IPP',
        host: 'localhost',
        address: '127.0.0.1',
        port: 631,
      },
    ],
  });
  assertEqualOrThrow(
    blockedLocalApiScan.length,
    0,
    'discoverLanPrinters blocks 127.0.0.1:3001 across port-scan, both, and IPP fallback even when custom probe returns true',
  );

  const blockedLocalApiPdl = await discoverLanPrinters({
    hosts: [],
    probe: async () => true,
    browse: async () => [
      {
        type: 'pdl-datastream',
        name: 'FloCafe API Port Only',
        host: 'localhost',
        address: '127.0.0.1',
        port: 3001,
      },
      {
        type: 'ipp',
        name: 'FloCafe API Port IPP',
        host: 'localhost',
        address: '127.0.0.1',
        port: 631,
      },
    ],
  });
  assertEqualOrThrow(
    blockedLocalApiPdl.length,
    0,
    'discoverLanPrinters blocks standalone 127.0.0.1:3001 pdl-datastream without falling back to IPP',
  );
}

async function main() {
  scanTargetsTest();
  await probePortTest();
  await scanPort9100Test();
  await networkPortLockWaiterAbortTest();
  await singleConnectionPrintProbeAndDiscoveryTest();
  await targetValidationTest();
  await browseMdnsTest();
  await discoverLanPrintersTest();
  console.log('\nAll assertions passed');
}

main().then(
  () => process.exit(0),
  (error: any) => {
    console.error('FAILED:', error?.message ?? error);
    process.exit(1);
  },
);
