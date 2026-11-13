/**
 * LAN printer discovery: the /24 target list, the port 9100 probe, the mDNS browse and the
 * merge of both. Every network call is injected here so the suite never scans a real network.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/lan-discovery.test.ts
 */
import * as net from 'net';

import {
  browseMdns,
  discoverLanPrinters,
  localScanTargets,
  probePort,
  scanPort9100,
} from '../main/printers/lan-discovery';

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
    linklocal: iface('169.254.3.4'),
    wlan0: iface('192.168.5.20'),
  } as any);
  assertOrThrow(
    skipped.every((host) => host.startsWith('192.168.5.')),
    'docker0 and 169.254 are skipped',
  );
  assertEqualOrThrow(skipped.length, 253, 'only the private interface is scanned');

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
      find: (_options: { type: string }, onUp: (service: any) => void) => {
        setTimeout(
          () =>
            onUp({
              name: 'Back Office',
              host: 'printer.local',
              addresses: ['192.168.1.70'],
              port: 631,
              txt: { ty: ['Brother QL-820NWB'] },
            }),
          0,
        );
        return { stop: () => undefined };
      },
      destroy: () => undefined,
    }),
  });
  assertEqualOrThrow(withHit.length, 1, 'the same printer seen on three types is listed once');
  assertEqualOrThrow(withHit[0].address, '192.168.1.70', 'the printer IPv4 address is read');
  assertEqualOrThrow(withHit[0].port, 631, 'the advertised port is kept');
  assertEqualOrThrow(withHit[0].name, 'Back Office', 'the friendly name is kept');

  assertEqualOrThrow(printers.length, 0, 'no answer gives no printer');
  assertEqualOrThrow(stopped, 3, 'each browser is stopped');
  assertEqualOrThrow(destroyed, 4, 'every browser and the Bonjour instance are destroyed');
}

async function discoverLanPrintersTest() {
  const printers = await discoverLanPrinters({
    hosts: ['192.168.1.50', '192.168.1.60'],
    probe: async (host) => host === '192.168.1.50' || host === '192.168.1.60',
    browse: async () => [
      {
        name: 'Front Desk XP-80',
        host: 'printer.local',
        address: '192.168.1.50',
        port: 9100,
        txt: { ty: ['XPrinter XP-80'] },
      },
      {
        name: 'Back Office',
        host: 'back.local',
        address: '192.168.1.70',
        port: 631,
        txt: { product: ['Brother QL-820NWB'] },
      },
    ],
  });

  assertEqualOrThrow(printers.length, 3, 'the merged list holds every address');
  assertEqualOrThrow(
    printers.map((printer) => printer.address).join(','),
    '192.168.1.50,192.168.1.60,192.168.1.70',
    'the list is sorted by address',
  );
  const [both, portOnly, mdnsOnly] = printers;
  assertEqualOrThrow(both.source, 'both', 'an address seen both ways is marked both');
  assertEqualOrThrow(both.name, 'Front Desk XP-80', 'the mDNS name wins over the generic name');
  assertEqualOrThrow(both.model, 'XPrinter XP-80', 'the model comes from the ty TXT record');
  assertEqualOrThrow(portOnly.source, 'port-scan', 'a port-only hit is marked port-scan');
  assertEqualOrThrow(
    portOnly.name,
    'Network printer (192.168.1.60)',
    'a port-only hit gets the generic name',
  );
  assertEqualOrThrow(portOnly.port, 9100, 'a port-only hit reports the probed port');
  assertEqualOrThrow(mdnsOnly.source, 'mdns', 'an mDNS-only hit is marked mdns');
  assertEqualOrThrow(mdnsOnly.port, 631, 'an mDNS-only hit keeps its advertised port');
  assertEqualOrThrow(
    mdnsOnly.model,
    'Brother QL-820NWB',
    'the model falls back to the product TXT record',
  );
}

async function main() {
  scanTargetsTest();
  await probePortTest();
  await scanPort9100Test();
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
