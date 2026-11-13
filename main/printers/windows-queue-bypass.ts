import type { DispatchResult } from './thermal';

/** TCP/IP port behind a Windows print queue, as reported by the raw-print helper. */
export type WindowsTcpPort = {
  host: string;
  port: number;
  /** 1 = RAW, 2 = LPR (Win32_TCPIPPrinterPort.Protocol). */
  protocol: number;
  snmpEnabled: boolean;
};

export type WindowsQueueBypassOptions = {
  printerName?: string;
  signal?: AbortSignal;
  printViaNetwork: (
    host: string,
    port: number,
    data: Buffer,
    signal?: AbortSignal,
  ) => Promise<DispatchResult>;
};

const PORT_LINE_PREFIX = 'FLO_PRINTER_PORT=';

/**
 * Queue refusals that happen before StartDocPrinter, so no job is waiting in the
 * spool and a direct print cannot duplicate the ticket. Keep this list exact.
 */
export const PRE_SPOOL_REFUSALS = [
  "printer is set to 'Use Printer Offline' in Windows",
  'printer is offline',
  'printer is not available',
] as const;

export const SNMP_DETAIL_SUFFIX = ' (SNMP status is enabled on this printer port)';

export function parseWindowsTcpPort(stdout: unknown): WindowsTcpPort | undefined {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(PORT_LINE_PREFIX));
  if (!line) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(PORT_LINE_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;

  const info = raw as {
    HostAddress?: unknown;
    PortNumber?: unknown;
    Protocol?: unknown;
    SNMPEnabled?: unknown;
  };
  const host = typeof info.HostAddress === 'string' ? info.HostAddress.trim() : '';
  if (!host) return undefined;

  const port = Number(info.PortNumber);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;

  const protocol = Number(info.Protocol);
  return {
    host,
    port,
    protocol: Number.isSafeInteger(protocol) ? protocol : 0,
    snmpEnabled: info.SNMPEnabled === true,
  };
}

// PowerShell wraps the helper's message in a localized "Exception calling ...: "<msg>"" line.
export function isPreSpoolRefusal(detail: string | undefined): boolean {
  if (!detail) return false;
  const text = detail.trim();
  return PRE_SPOOL_REFUSALS.some((refusal) => text === refusal || text.endsWith(`"${refusal}"`));
}

export function canBypassWindowsQueue(
  detail: string | undefined,
  tcpPort: WindowsTcpPort | undefined,
): boolean {
  if (!tcpPort || !isPreSpoolRefusal(detail)) return false;
  return tcpPort.protocol === 1 && !!tcpPort.host;
}

/**
 * Prints once to the queue's own TCP/IP port when the Windows queue refused the job
 * before spooling it. Any other failure comes back unchanged.
 */
export async function withWindowsQueueBypass(
  failure: DispatchResult,
  stdout: unknown,
  data: Buffer,
  options: WindowsQueueBypassOptions,
): Promise<DispatchResult> {
  const tcpPort = parseWindowsTcpPort(stdout);
  const refused = isPreSpoolRefusal(failure.detail);
  const withSnmpNote = (original: DispatchResult): DispatchResult => {
    if (!refused || !tcpPort || !tcpPort.snmpEnabled || !original.detail) return original;
    if (original.detail.includes(SNMP_DETAIL_SUFFIX.trim())) return original;
    return { ...original, detail: `${original.detail}${SNMP_DETAIL_SUFFIX}` };
  };

  if (!tcpPort || !canBypassWindowsQueue(failure.detail, tcpPort)) return withSnmpNote(failure);

  const direct = await options
    .printViaNetwork(tcpPort.host, tcpPort.port, data, options.signal)
    .catch(() => ({ ok: false }) as DispatchResult);
  if (direct.ok) {
    console.log(
      `[Printer] Windows queue "${options.printerName || 'printer'}" refused (${failure.detail}); printed directly to its TCP/IP port`,
    );
    return {
      ok: true,
      transport: 'direct_tcp_fallback',
      detail: failure.detail,
      queuePort: failure.queuePort,
    };
  }
  return withSnmpNote(failure);
}
