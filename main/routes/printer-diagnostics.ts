// Route glue for printer diagnostics: the DLE EOT status probe and LAN discovery.
import type { Request, Response } from 'express';

import { getDatabase } from '../db';
import {
  probeNetworkPrinterStatus,
  statusToFailureCause,
  type PrinterFailureCause,
  type PrinterStatusResult,
} from '../printers/escpos-status';
import {
  discoverLanPrinters,
  type DiscoverOptions,
  type LanPrinter,
} from '../printers/lan-discovery';
import {
  detectConnectedPrinters,
  validateNetworkPrinterTarget,
  type PrinterInfo,
} from '../printers/thermal';
import { getHttpRequestSignal } from '../shutdown';

export interface PrinterRow {
  id: string;
  name: string;
  connection_type: 'network' | 'usb' | 'webusb';
  ip_address: string | null;
  port: number | null;
}

export type QueueStatus = 'idle' | 'printing' | 'offline' | 'missing';
export type DetectPrinters = (signal?: AbortSignal) => Promise<PrinterInfo[]>;

export type PrinterStatusBody =
  | ({
      connection_type: 'network';
      cause: PrinterFailureCause | null;
    } & PrinterStatusResult)
  | {
      connection_type: 'usb';
      queue_status: QueueStatus;
      cause: 'queue_offline' | 'queue_missing' | null;
    }
  | { connection_type: 'webusb'; cause: null };

/** True when the printer answered with a fault that drops the bytes it receives. */
export function isPhysicalFault(cause: PrinterStatusBody['cause']): boolean {
  return cause === 'paper_out' || cause === 'cover_open' || cause === 'printer_error';
}

/** A network printer that answers with a physical fault dropped the bytes it was sent. */
export async function testPrintCause(
  printer: PrinterRow,
  signal?: AbortSignal,
): Promise<PrinterStatusBody['cause']> {
  if (printer.connection_type !== 'network') return null;
  return (await getPrinterStatus(printer, signal)).cause;
}

export async function getPrinterStatus(
  printer: PrinterRow,
  signal?: AbortSignal,
  detect: DetectPrinters = detectConnectedPrinters,
): Promise<PrinterStatusBody> {
  if (printer.connection_type === 'network') {
    // Rows written before target validation existed are checked again before any probe.
    if (
      !printer.ip_address ||
      validateNetworkPrinterTarget(printer.ip_address, printer.port || 9100)
    ) {
      return {
        connection_type: 'network',
        reachable: false,
        answered: false,
        cause: 'unreachable',
      };
    }
    // Same host normalization as printViaNetwork: trim, then drop IPv6 brackets.
    const host = printer.ip_address
      .trim()
      .replace(/^\[(.*)\]$/, '$1')
      .trim();
    const result = await probeNetworkPrinterStatus(host, printer.port || 9100, {
      timeoutMs: 600,
      signal,
    });
    return {
      connection_type: 'network',
      ...result,
      cause: statusToFailureCause(result),
    };
  }

  if (printer.connection_type === 'usb') {
    const queue = (await detect(signal)).find((info) => info.name === printer.name);
    const queueStatus: QueueStatus = queue?.status ?? 'missing';
    return {
      connection_type: 'usb',
      queue_status: queueStatus,
      cause:
        queueStatus === 'missing'
          ? 'queue_missing'
          : queueStatus === 'offline'
            ? 'queue_offline'
            : null,
    };
  }

  return { connection_type: 'webusb', cause: null };
}

export type DiscoverScan = (options: DiscoverOptions) => Promise<LanPrinter[]>;
export type LanPrinterWithSaved = LanPrinter & { saved: boolean };

type Database = { prepare: (sql: string) => { get: (address: string) => unknown } };

let scan: DiscoverScan = discoverLanPrinters;
let detectCache: { at: number; printers: Promise<PrinterInfo[]> } | null = null;

// One OS enumeration (a PowerShell spawn on Windows) serves every badge on the page.
function detectShared(): Promise<PrinterInfo[]> {
  if (!detectCache || Date.now() - detectCache.at > 5000) {
    const printers = detectConnectedPrinters();
    detectCache = { at: Date.now(), printers };
    printers.catch(() => {
      if (detectCache?.printers === printers) detectCache = null;
    });
  }
  return detectCache.printers;
}
let inFlight: Promise<LanPrinter[]> | null = null;

/** Test-only: replace the scanner and drop the shared scan. */
export function setDiscoverScan(next: DiscoverScan): void {
  scan = next;
  inFlight = null;
  detectCache = null;
}

function isSaved(db: Database, address: string): boolean {
  return !!db.prepare('SELECT 1 FROM printers WHERE ip_address = ? LIMIT 1').get(address);
}

/**
 * Every caller that arrives while a scan runs gets that same scan, so two tabs or a
 * double click never double the LAN traffic.
 */
export function discoverPrinters(db: Database): Promise<LanPrinterWithSaved[]> {
  // The shared scan ignores any one caller's abort: it is time-boxed, and other callers wait on it.
  if (!inFlight) {
    inFlight = scan({}).finally(() => {
      inFlight = null;
    });
  }
  return inFlight.then((printers) =>
    printers.map((printer) => ({
      ...printer,
      saved: isSaved(db, printer.address),
    })),
  );
}

function sendError(req: Request, res: Response, error: unknown, label: string): void {
  res.locals.postHogError = error;
  if (getHttpRequestSignal(req)?.aborted) {
    if (!res.headersSent) res.status(503).end();
    else if (!res.writableEnded) res.destroy();
    return;
  }
  console.error(`[Printer] ${label} error:`, error);
  res.status(500).json({ error: 'Internal server error' });
}

export async function discoverHandler(req: Request, res: Response): Promise<void> {
  try {
    const printers = await discoverPrinters(getDatabase());
    res.json({ printers });
  } catch (error) {
    sendError(req, res, error, 'Discovery');
  }
}

export async function printerStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const printer = getDatabase()
      .prepare('SELECT * FROM printers WHERE id = ?')
      .get(req.params.id) as PrinterRow | undefined;
    if (!printer) {
      res.status(404).json({ error: 'Printer not found' });
      return;
    }
    res.json(await getPrinterStatus(printer, getHttpRequestSignal(req), detectShared));
  } catch (error) {
    sendError(req, res, error, 'Status');
  }
}
