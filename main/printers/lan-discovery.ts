/**
 * Finds receipt printers on the local network without a typed IP.
 *
 * Two paths run at the same time: a TCP probe of port 9100 (AppSocket, the
 * path almost every cheap thermal printer answers) and an mDNS browse for
 * printers that advertise themselves. The probe sends no bytes and closes the
 * connection at once, because cheap printers accept one connection at a time.
 */
import * as os from 'os';
import { Bonjour } from 'bonjour-service';

import { openSocket } from './escpos-status';
import { isKnownDriverOnlyPrinter } from './thermal';

const SOCKET_PORT = 9100;
const MDNS_TYPES = ['pdl-datastream', 'ipp', 'printer'] as const;
const MAX_NETWORKS = 4;
const VIRTUAL_IFACE = [
  'docker',
  'veth',
  'vmnet',
  'vboxnet',
  'utun',
  'tailscale',
  'zt',
  'br-',
  'virbr',
  'wg',
];

export type MdnsServiceType = (typeof MDNS_TYPES)[number];
export type PrinterSource = 'mdns' | 'port-scan' | 'both';

export interface MdnsPrinter {
  name: string;
  host: string;
  address: string;
  port: number;
  type?: MdnsServiceType;
  txt?: Record<string, unknown>;
}

export interface LanPrinter {
  address: string;
  port: number;
  name: string;
  source: PrinterSource;
  model?: string;
}

export interface ScanOptions {
  concurrency?: number;
  timeoutMs?: number;
  port?: number;
  signal?: AbortSignal;
  probe?: (host: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;
}

export interface BrowseOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  bonjourFactory?: () => BonjourLike;
}

export interface DiscoverOptions extends ScanOptions, BrowseOptions {
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  hosts?: string[];
  totalTimeoutMs?: number;
  browse?: (options: BrowseOptions) => Promise<MdnsPrinter[]>;
}

type ServiceLike = {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
  referer?: { address?: string };
};

type BrowserLike = { stop?: () => void; destroy?: () => void };

export type BonjourLike = {
  find: (options: { type: string }, onUp: (service: ServiceLike) => void) => BrowserLike;
  destroy: () => void;
};

function isIpv4(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

function netmaskPrefix(netmask: string): number {
  return netmask.split('.').reduce((bits, octet) => {
    let value = Number(octet) & 0xff;
    let setBits = 0;
    for (let i = 0; i < 8; i++) {
      if (value & 0x80) setBits++;
      value = (value << 1) & 0xff;
    }
    return bits + setBits;
  }, 0);
}

function ipv4ToInt(address: string): number {
  const [a, b, c, d] = address.split('.').map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function intToIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    '.',
  );
}

/** Host list of every private interface (exact range for /24../30, /24 slice for wider), without this machine's own addresses. */
export function localScanTargets(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const own = new Set<string>();
  const ranges: Array<{ key: string; start: number; end: number }> = [];
  const seenKeys = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4') own.add(entry.address);
    }
  }
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_IFACE.some((virtual) => name.toLowerCase().includes(virtual))) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      if (!isPrivateIpv4(entry.address)) continue;
      const prefix = netmaskPrefix(entry.netmask);
      if (prefix > 30) continue;

      let start: number;
      let end: number;
      let key: string;
      if (prefix >= 24) {
        const maskInt = (0xffffffff << (32 - prefix)) >>> 0;
        const networkInt = (ipv4ToInt(entry.address) & maskInt) >>> 0;
        const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
        start = networkInt + 1;
        end = broadcastInt - 1;
        key = `${networkInt}/${prefix}`;
      } else {
        const network24Int = (ipv4ToInt(entry.address) & 0xffffff00) >>> 0;
        start = network24Int + 1;
        end = network24Int + 254;
        key = `${network24Int}/24`;
      }

      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        ranges.push({ key, start, end });
      }
      if (ranges.length === MAX_NETWORKS) break;
    }
    if (ranges.length === MAX_NETWORKS) break;
  }
  const targets: string[] = [];
  for (const range of ranges) {
    for (let addr = range.start; addr <= range.end; addr++) {
      const address = intToIpv4(addr);
      if (!own.has(address)) targets.push(address);
    }
  }
  return targets;
}

/** True when a TCP connection opens. Sends nothing and closes the socket at once. */
export function probePort(
  host: string,
  port: number,
  timeoutMs = 400,
  signal?: AbortSignal,
): Promise<boolean> {
  return openSocket(host, port, timeoutMs, signal).then(
    (socket) => {
      socket.destroy();
      return true;
    },
    () => false,
  );
}

/** Probes the hosts with a concurrency limit and returns the ones that answered. */
export async function scanPort9100(hosts: string[], options: ScanOptions = {}): Promise<string[]> {
  const {
    concurrency = 64,
    timeoutMs = 400,
    port = SOCKET_PORT,
    signal,
    probe = probePort,
  } = options;
  const found: string[] = [];
  let next = 0;
  const worker = async () => {
    while (!signal?.aborted) {
      const index = next++;
      if (index >= hosts.length) return;
      const host = hosts[index];
      if (await probe(host, port, timeoutMs, signal)) found.push(host);
    }
  };
  const workers = Math.min(Math.max(concurrency, 1), hosts.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return found.sort(compareAddress);
}

function serviceAddress(service: ServiceLike): string | undefined {
  const candidates = [...(service.addresses ?? []), service.referer?.address, service.host];
  return candidates.find(isIpv4);
}

function textValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'string') return raw.trim() || undefined;
  if (typeof raw === 'number') return String(raw);
  return undefined;
}

/** Browses the printer mDNS types for the timeout, then tears down every handle. */
export function browseMdns(options: BrowseOptions = {}): Promise<MdnsPrinter[]> {
  const {
    timeoutMs = 2500,
    signal,
    bonjourFactory = () => new Bonjour() as unknown as BonjourLike,
  } = options;
  const found = new Map<string, MdnsPrinter>();
  let bonjour: BonjourLike | undefined;
  const browsers: BrowserLike[] = [];
  return new Promise<MdnsPrinter[]>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      for (const browser of browsers) {
        browser.stop?.();
        browser.destroy?.();
      }
      bonjour?.destroy();
      resolve([...found.values()]);
    };

    if (signal?.aborted) {
      finish();
      return;
    }

    try {
      bonjour = bonjourFactory();
      for (const type of MDNS_TYPES) {
        browsers.push(
          bonjour.find({ type }, (service) => {
            const address = serviceAddress(service);
            if (!address) return;
            const port =
              service.port && service.port > 0
                ? service.port
                : type === 'pdl-datastream'
                  ? SOCKET_PORT
                  : 0;
            found.set(`${type}:${address}:${port}`, {
              name: service.name || `Network printer (${address})`,
              host: service.host || address,
              address,
              port,
              type,
              ...(service.txt ? { txt: service.txt } : {}),
            });
          }),
        );
      }
    } catch {
      // A missing mDNS socket must not fail discovery: the port scan still runs.
    }

    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener('abort', finish, { once: true });
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}

function compareAddress(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function modelOf(txt: Record<string, unknown> | undefined): string | undefined {
  if (!txt) return undefined;
  return textValue(txt.ty) ?? textValue(txt.product);
}

function isPdlRecord(record: MdnsPrinter): boolean {
  if (record.type) return record.type === 'pdl-datastream';
  return record.port !== 631 && record.port !== 515;
}

async function mergePrinters(
  openHosts: string[],
  mdnsPrinters: MdnsPrinter[],
  scannedHosts: Set<string>,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
  probe: NonNullable<ScanOptions['probe']>,
): Promise<LanPrinter[]> {
  const openHostSet = new Set(openHosts);
  const byAddress = new Map<string, MdnsPrinter[]>();
  for (const printer of mdnsPrinters) {
    const group = byAddress.get(printer.address);
    if (group) group.push(printer);
    else byAddress.set(printer.address, [printer]);
  }

  const merged = new Map<string, LanPrinter>();
  const excludedHosts = new Set<string>();

  await Promise.all(
    [...byAddress.entries()].map(async ([address, records]) => {
      const pdlRecord = records.find(isPdlRecord);
      const primary = pdlRecord ?? records[0];
      const name = primary.name;
      const model =
        modelOf(pdlRecord?.txt) ??
        records.map((record) => modelOf(record.txt)).find((value) => value !== undefined);

      if (isKnownDriverOnlyPrinter({ name, model })) {
        excludedHosts.add(address);
        return;
      }

      if (openHostSet.has(address)) {
        merged.set(address, {
          address,
          port,
          name,
          source: 'both',
          ...(model ? { model } : {}),
        });
        return;
      }

      if (pdlRecord) {
        const pdlPort = pdlRecord.port || port;
        // Skip re-probing port 9100 if the host scan already tested it and found it closed.
        const alreadyProbedClosed =
          pdlPort === port && scannedHosts.has(address) && !signal.aborted;
        if (
          !alreadyProbedClosed &&
          !signal.aborted &&
          (await probe(address, pdlPort, timeoutMs, signal))
        ) {
          merged.set(address, {
            address,
            port: pdlPort,
            name,
            source: 'mdns',
            ...(model ? { model } : {}),
          });
        }
        return;
      }

      // IPP/LPD-only mDNS entries are only included when raw port 9100 is confirmed open.
      if (
        !scannedHosts.has(address) &&
        !signal.aborted &&
        (await probe(address, port, timeoutMs, signal))
      ) {
        merged.set(address, {
          address,
          port,
          name,
          source: 'mdns',
          ...(model ? { model } : {}),
        });
      }
    }),
  );

  for (const host of openHosts) {
    if (merged.has(host) || excludedHosts.has(host)) continue;
    merged.set(host, {
      address: host,
      port,
      name: `Network printer (${host})`,
      source: 'port-scan',
    });
  }
  return [...merged.values()].sort((a, b) => compareAddress(a.address, b.address));
}

/** Runs the port scan and the mDNS browse together and merges them by IPv4 address. */
export async function discoverLanPrinters(options: DiscoverOptions = {}): Promise<LanPrinter[]> {
  const {
    port = SOCKET_PORT,
    concurrency = 64,
    totalTimeoutMs = 3000,
    interfaces = os.networkInterfaces(),
    probe = probePort,
    browse = browseMdns,
  } = options;
  const hosts = options.hosts ?? localScanTargets(interfaces);
  // Keep the whole scan inside the deadline: every concurrent wave gets its share.
  const waves = Math.max(1, Math.ceil(hosts.length / Math.max(concurrency, 1)));
  const timeoutMs =
    options.timeoutMs ?? Math.min(400, Math.max(60, Math.floor(totalTimeoutMs / waves)));

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, totalTimeoutMs);
  deadline.unref?.();
  try {
    const [openHosts, mdnsPrinters] = await Promise.all([
      scanPort9100(hosts, { concurrency, timeoutMs, port, probe, signal: controller.signal }),
      browse({ timeoutMs: Math.min(2500, totalTimeoutMs), signal: controller.signal }),
    ]);
    return await mergePrinters(
      openHosts,
      mdnsPrinters,
      new Set(hosts),
      port,
      timeoutMs,
      controller.signal,
      probe,
    );
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
  }
}
