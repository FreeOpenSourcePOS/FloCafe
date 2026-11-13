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

const SOCKET_PORT = 9100;
const MDNS_TYPES = ['pdl-datastream', 'ipp', 'printer'];
const MAX_NETWORKS = 4;
const VIRTUAL_IFACE = ['docker', 'veth', 'vmnet', 'vboxnet', 'utun', 'tailscale', 'zt'];

export type PrinterSource = 'mdns' | 'port-scan' | 'both';

export interface MdnsPrinter {
  name: string;
  host: string;
  address: string;
  port: number;
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
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export interface BrowseOptions {
  timeoutMs?: number;
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

/** The /24 host list of every private interface, without this machine's own addresses. */
export function localScanTargets(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const own = new Set<string>();
  const networks: string[] = [];
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
      // A netmask narrower than /24 covers fewer hosts than the /24 list we build.
      if (netmaskPrefix(entry.netmask) > 24) continue;
      const network = entry.address.split('.').slice(0, 3).join('.');
      if (!networks.includes(network)) networks.push(network);
      if (networks.length === MAX_NETWORKS) break;
    }
    if (networks.length === MAX_NETWORKS) break;
  }
  const targets: string[] = [];
  for (const network of networks) {
    for (let host = 1; host <= 254; host++) {
      const address = `${network}.${host}`;
      if (!own.has(address)) targets.push(address);
    }
  }
  return targets;
}

/** True when a TCP connection opens. Sends nothing and closes the socket at once. */
export function probePort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return openSocket(host, port, timeoutMs).then(
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
      if (await probe(host, port, timeoutMs)) found.push(host);
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
  const { timeoutMs = 2500, bonjourFactory = () => new Bonjour() as unknown as BonjourLike } =
    options;
  const found = new Map<string, MdnsPrinter>();
  let bonjour: BonjourLike | undefined;
  const browsers: BrowserLike[] = [];
  return new Promise<MdnsPrinter[]>((resolve) => {
    try {
      bonjour = bonjourFactory();
      for (const type of MDNS_TYPES) {
        browsers.push(
          bonjour.find({ type }, (service) => {
            const address = serviceAddress(service);
            if (!address) return;
            // Only pdl-datastream names a raw socket port; IPP (631) and LPD (515) cannot take ESC/POS bytes.
            const port = type === 'pdl-datastream' && service.port ? service.port : SOCKET_PORT;
            found.set(`${address}:${port}`, {
              name: service.name || `Network printer (${address})`,
              host: service.host || address,
              address,
              port,
              ...(service.txt ? { txt: service.txt } : {}),
            });
          }),
        );
      }
    } catch {
      // A missing mDNS socket must not fail discovery: the port scan still runs.
    }
    setTimeout(() => {
      for (const browser of browsers) {
        browser.stop?.();
        browser.destroy?.();
      }
      bonjour?.destroy();
      resolve([...found.values()]);
    }, timeoutMs);
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

function mergePrinters(
  openHosts: string[],
  mdnsPrinters: MdnsPrinter[],
  port: number,
): LanPrinter[] {
  const merged = new Map<string, LanPrinter>();
  for (const printer of mdnsPrinters) {
    const model = modelOf(printer.txt);
    merged.set(printer.address, {
      address: printer.address,
      port: printer.port || port,
      name: printer.name,
      source: 'mdns',
      ...(model ? { model } : {}),
    });
  }
  for (const host of openHosts) {
    const existing = merged.get(host);
    if (existing) {
      merged.set(host, { ...existing, port, source: 'both' });
    } else {
      merged.set(host, {
        address: host,
        port,
        name: `Network printer (${host})`,
        source: 'port-scan',
      });
    }
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
  try {
    const [openHosts, mdnsPrinters] = await Promise.all([
      scanPort9100(hosts, { concurrency, timeoutMs, port, probe, signal: controller.signal }),
      browse({ timeoutMs: Math.min(2500, totalTimeoutMs) }),
    ]);
    return mergePrinters(openHosts, mdnsPrinters, port);
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
  }
}
