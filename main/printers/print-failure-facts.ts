/**
 * Enum-only facts for a failed print, so support can tell a real USB queue from a network printer
 * behind one, and which sub-case a `printer.queue_failed` is. Never a queue name, host, IP, GUID,
 * or path: every value here is a closed set or a number.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPreSpoolRefusal, parseWindowsTcpPort, SNMP_DETAIL_SUFFIX } from './windows-queue-bypass';

import {
  BYPASS_OUTCOMES,
  DRIVER_KINDS,
  FAILURE_STEPS,
  PORT_KINDS,
  QUEUE_REFUSALS,
  SNMP_STATES,
  WIN32_ERROR_MAX,
} from '../../shared/print/printer-facts';

export type PortKind = (typeof PORT_KINDS)[number];
export type QueueRefusal = (typeof QUEUE_REFUSALS)[number];
export type FailureStep = (typeof FAILURE_STEPS)[number];

/** Registered on every printer capture point; all optional, so an old payload still serializes. */
export const PRINTER_DIAGNOSTIC_FACT_RULES = {
  port_kind: { type: 'enum', values: PORT_KINDS },
  queue_refusal: { type: 'enum', values: QUEUE_REFUSALS },
  failure_step: { type: 'enum', values: FAILURE_STEPS },
  win32_error: { type: 'integer', min: 0, max: WIN32_ERROR_MAX },
  snmp_enabled: { type: 'enum', values: SNMP_STATES },
  driver_kind: { type: 'enum', values: DRIVER_KINDS },
  bypass: { type: 'enum', values: BYPASS_OUTCOMES },
} as const;

/** Where a queue really points; URL-free, so it can travel. */
export type QueuePort = { kind: PortKind; snmpEnabled?: boolean };

const PRINTER_INFO_PREFIX = 'FLO_PRINTER_INFO=';

const WINDOWS_PORT_KINDS: Array<[RegExp, PortKind]> = [
  [/^USB\d+/i, 'usb'],
  [/^WSD-/i, 'wsd'],
  [/^\\\\/, 'shared'],
  [/^(COM|LPT)\d+/i, 'serial'],
  [/^(FILE:|PORTPROMPT:|nul:)/i, 'file'],
  [/^[A-Za-z]:[\\/]/, 'file'],
];

function windowsPortName(stdout: unknown): string {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(PRINTER_INFO_PREFIX));
  if (!line) return '';
  try {
    const info = JSON.parse(line.slice(PRINTER_INFO_PREFIX.length)) as { PortName?: unknown };
    return typeof info.PortName === 'string' ? info.PortName.trim() : '';
  } catch {
    return '';
  }
}

/**
 * A Windows queue's real port, from the raw-print helper's own two lines. A TCP/IP port record
 * wins: the queue is then a network printer, whatever the profile says.
 */
export function windowsQueuePort(stdout: unknown): QueuePort {
  const tcpPort = parseWindowsTcpPort(stdout);
  if (tcpPort) {
    return {
      kind: tcpPort.protocol === 2 ? 'tcp_lpr' : 'tcp_raw',
      snmpEnabled: tcpPort.snmpEnabled,
    };
  }
  const portName = windowsPortName(stdout);
  if (!portName) return { kind: 'unknown' };
  for (const [pattern, kind] of WINDOWS_PORT_KINDS) {
    if (pattern.test(portName)) return { kind };
  }
  return { kind: 'other' };
}

const CUPS_PORT_KINDS: Record<string, PortKind> = {
  usb: 'usb',
  socket: 'tcp_raw',
  lpd: 'tcp_lpr',
  ipp: 'ipp',
  ipps: 'ipp',
  dnssd: 'ipp',
  http: 'ipp',
  smb: 'shared',
  serial: 'serial',
  parallel: 'serial',
};

/** The scheme of the CUPS device URI for a queue name, or `unknown`. */
export function cupsDevicePortKind(lpstatOutput: unknown, printerName: string): PortKind {
  const line = String(lpstatOutput || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`device for ${printerName}:`));
  if (!line) return 'unknown';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(
    line.slice(`device for ${printerName}:`.length).trim(),
  );
  if (!scheme) return 'unknown';
  return CUPS_PORT_KINDS[scheme[1].toLowerCase()] ?? 'other';
}

type ExecFileLike = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: unknown }>;

const execFileAsync = promisify(execFile) as unknown as ExecFileLike;

/** Best effort, on failure only: `lpstat -v` names the device behind a CUPS queue. */
export async function cupsQueuePort(
  printerName: string | undefined,
  options: { signal?: AbortSignal; isMas?: boolean; run?: ExecFileLike } = {},
): Promise<QueuePort> {
  if (!printerName || options.isMas) return { kind: 'unknown' };
  try {
    const run = options.run ?? execFileAsync;
    const { stdout } = await run('lpstat', ['-v', printerName], {
      encoding: 'utf8',
      timeout: 2000,
      signal: options.signal,
      // `lpstat` translates "device for"; the parser reads the C locale text.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    return { kind: cupsDevicePortKind(stdout, printerName) };
  } catch {
    return { kind: 'unknown' };
  }
}

// The C# helper's refusal text, matched inside PowerShell's localized "Exception calling ..." line.
const REFUSAL_TEXTS: Array<[string, QueueRefusal]> = [
  ["printer is set to 'Use Printer Offline' in Windows", 'work_offline'],
  ['printer is offline', 'offline'],
  ['printer is not available', 'not_available'],
  ['printer is out of paper', 'paper_out'],
  ['printer has a paper jam', 'paper_jam'],
  ['printer cover is open', 'cover_open'],
  ['printer needs attention', 'attention'],
  ['printer reported an error', 'error'],
];

function withoutSnmpNote(detail: string): string {
  const text = detail.trim();
  return text.endsWith(SNMP_DETAIL_SUFFIX.trim())
    ? text.slice(0, -SNMP_DETAIL_SUFFIX.trim().length).trim()
    : text;
}

export function queueRefusalFromDetail(detail: string | undefined): QueueRefusal | undefined {
  if (!detail) return undefined;
  const text = withoutSnmpNote(detail);
  for (const [refusalText, refusal] of REFUSAL_TEXTS) {
    if (text === refusalText || text.endsWith(`"${refusalText}"`)) return refusal;
  }
  return undefined;
}

export function failureStepFromDetail(
  detail: string | undefined,
  refusal: QueueRefusal | undefined,
): FailureStep | undefined {
  if (!detail) return undefined;
  if (refusal) return 'pre_spool';
  if (/Windows print command timed out/i.test(detail)) return 'timeout';
  if (/Windows print command was cancelled/i.test(detail)) return 'cancelled';
  if (/Could not start the Windows print helper/i.test(detail)) return 'helper_start';
  if (/cannot open printer/i.test(detail)) return 'open';
  if (/StartDocPrinter failed/i.test(detail)) return 'startdoc';
  if (/StartPagePrinter failed/i.test(detail)) return 'startpage';
  if (/WritePrinter accepted \d+ of \d+ bytes/i.test(detail)) return 'short_write';
  if (/WritePrinter failed/i.test(detail)) return 'write';
  return undefined;
}

export function driverKindFromName(driverName: string | undefined): string {
  const name = String(driverName || '').trim();
  if (!name) return 'unknown';
  if (/generic.*text/i.test(name)) return 'generic_text';
  if (/microsoft|ms publisher|ipp class|universal print/i.test(name)) return 'ms_class';
  return 'vendor';
}

export type PrintFailureFactsInput = {
  detail?: string;
  connectionType?: string;
  platformErrorCode?: number;
  driverName?: string;
  queuePort?: QueuePort;
};

/** The enum-only facts of one failed print, keeping only what is known. */
export function printFailureFacts(input: PrintFailureFactsInput): Record<string, string | number> {
  const queuePort = input.queuePort;
  const portKind: PortKind =
    queuePort?.kind ?? (input.connectionType === 'network' ? 'tcp_raw' : 'unknown');
  const refusal = queueRefusalFromDetail(input.detail);
  const step = failureStepFromDetail(input.detail, refusal);
  const facts: Record<string, string | number> = { port_kind: portKind };
  if (queuePort?.snmpEnabled !== undefined)
    facts.snmp_enabled = queuePort.snmpEnabled ? 'yes' : 'no';
  if (refusal) facts.queue_refusal = refusal;
  if (step) facts.failure_step = step;
  // The bypass runs only for the 3 pre-spool refusals on a RAW TCP/IP port.
  if (refusal) {
    const eligible =
      portKind === 'tcp_raw' && isPreSpoolRefusal(withoutSnmpNote(input.detail || ''));
    facts.bypass = eligible ? 'failed' : 'not_eligible';
  }
  const win32Error = input.platformErrorCode;
  if (
    typeof win32Error === 'number' &&
    Number.isSafeInteger(win32Error) &&
    win32Error >= 0 &&
    win32Error <= WIN32_ERROR_MAX
  )
    facts.win32_error = win32Error;
  const driverKind = driverKindFromName(input.driverName);
  if (driverKind !== 'unknown') facts.driver_kind = driverKind;
  return facts;
}

/** Spread on a successful dispatch, so a recovered print keeps what the adjoining failure knew. */
export function recoveredFacts(dispatch: {
  transport?: 'direct_tcp_fallback';
  detail?: string;
  queuePort?: QueuePort;
}): { transport?: 'direct_tcp_fallback'; detail?: string; queuePort?: QueuePort } {
  if (dispatch.transport !== 'direct_tcp_fallback') return {};
  return {
    transport: dispatch.transport,
    ...(dispatch.detail ? { detail: dispatch.detail } : {}),
    ...(dispatch.queuePort ? { queuePort: dispatch.queuePort } : {}),
  };
}
