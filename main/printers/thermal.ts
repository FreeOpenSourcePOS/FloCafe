import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { getDatabase, getSettingValue, parseDbTimestamp } from '../db';
import { PrinterCutMode, resolvePrinterProfile, matchSupportedPrinterProfile, getPrinterCapabilities, SupportedPrinterProfile } from './profiles';
import { getCountryByCode, getCurrencyFractionDigits } from '../countries';
import { resolveTaxComponents } from '../services/tax-components';
import { loadInstalledPrintTemplate, parseBillTemplateSelection } from '../services/print-templates';
import { renderMerchantReceiptViaDocument } from './document-merchant';
import { correlationId, type FloErrorCode } from '../errors';
import { sendEvent } from '../services/telemetry';
import { cloudSync } from '../services/cloud-sync';
import { randomUUID } from 'crypto';
import CodepageEncoder from '@point-of-sale/codepage-encoder';
import { printLabel, isGeneratedPrintLanguage } from '../print/print-labels.generated';
import type { PrintConceptId } from '../print/print-labels.generated';
import {
  declaredTemplateChargeRows,
  fitTemplateLabel,
  resolveTemplateLabel,
  sanitizeTemplateLabelText,
  type TemplateChargeRowId,
} from '../print/template-labels';
import { renderClassicReceiptViaDocument } from './document-classic';
import { renderCompactReceiptViaDocument } from './document-compact';
import { renderKotViaDocument } from './document-kot';
import {
  GENERIC_THERMAL_CAPABILITIES,
  normalizeThermalText as normalizeThermalTextByCapabilities,
  selectThermalCodePage,
  escPosCodePageId,
  mergeThermalCapabilities,
  type ThermalCodePage,
  type ThermalPrinterCapabilities,
} from '../../shared/print/thermal-capabilities';

export type PrintResult = {
  ok: boolean;
  code?: FloErrorCode;
  correlationId: string;
  stage: 'prepare' | 'dispatch';
  detail?: string;
  failureClass?: PrintFailureClass;
  platformErrorCode?: number;
  jobId?: number;
  driverName?: string;
  printerStatus?: number;
  warnings?: PrintWarning[];
};

export type PrintWarning = {
  field: string;
  text: string;
  message: string;
  kind?: 'line' | 'financial' | 'configuration';
};

export function hasFinancialPrintWarning(warnings: readonly PrintWarning[]): boolean {
  return warnings.some((warning) => warning.kind === 'financial');
}

export function makeFinancialPrintRefusalMessage(warnings: readonly PrintWarning[]): string {
  const row = warnings.find((warning) => warning.kind === 'financial');
  return `Receipt not printed: a financial row contains unsupported printer text${row?.text ? `: ${row.text}` : '.'} Use a supported printer profile or system/browser printing.`;
}

const FINANCIAL_PRINT_REFUSAL_DIAGNOSTIC = 'Receipt not printed: unsupported financial row';

/** Low-level dispatch result — carries the actual OS/driver reason, not just ok/fail. */
export type DispatchResult = {
  ok: boolean;
  detail?: string;
  failureClass?: PrintFailureClass;
  platformErrorCode?: number;
  jobId?: number;
  driverName?: string;
  printerStatus?: number;
  warnings?: PrintWarning[];
};

export type PrintFailureClass =
  | 'not_configured'
  | 'offline'
  | 'queue_unavailable'
  | 'spooler_error'
  | 'driver_error'
  | 'permission_denied'
  | 'timeout'
  | 'write_error'
  | 'unsupported'
  | 'unknown';

/** Stable, privacy-safe classification for fleet telemetry. */
export function classifyPrintFailure(detail?: string): PrintFailureClass {
  const value = String(detail || '').toLowerCase();
  if (!value) return 'unknown';
  if (value.includes('no printer configured') || value.includes('no windows printer configured')) return 'not_configured';
  if (value.includes('offline') || value.includes('use printer offline') || value.includes('disconnected')) return 'offline';
  if (value.includes('not accepting') || value.includes('queue') && value.includes('unavailable') || value.includes('cannot open printer')) return 'queue_unavailable';
  if (value.includes('spool') || value.includes('startdocprinter') || value.includes('startpageprinter')) return 'spooler_error';
  if (value.includes('driver') || value.includes('no driver')) return 'driver_error';
  if (value.includes('access denied') || value.includes('permission')) return 'permission_denied';
  if (value.includes('timed out') || value.includes('timeout')) return 'timeout';
  if (value.includes('writeprinter') || value.includes('accepted') && value.includes('of')) return 'write_error';
  if (value.includes('not supported') || value.includes('unsupported')) return 'unsupported';
  return 'unknown';
}

function extractPlatformErrorCode(detail?: string): number | undefined {
  const match = String(detail || '').match(/\b(?:win32 error|error)\s+(\d+)\b/i);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : undefined;
}

const isMasBuild =
  process.env.MAS_BUILD === '1' ||
  (process as NodeJS.Process & { mas?: boolean }).mas === true;
const PRINTER_DETECTION_TIMEOUT_MS = 10_000;

const RECEIPT_BRANDING_NAME = 'Powered by FloPOS';
const RECEIPT_BRANDING_URL = 'https://flopos.com';
export type PrinterColumnWidth = 36 | 42 | 48;

export interface PrinterInfo {
  name: string;
  make: string;
  model: string;
  connectionType: 'usb' | 'network' | 'bluetooth';
  deviceUri: string;
  driver?: string;
  status: 'idle' | 'printing' | 'offline';
  isDefault: boolean;
  ipAddress?: string;
  port?: number;
  paperWidth?: string;
  profileId?: string;
}

function guessPaperWidth(name: string, model: string): string {
  const profile = matchSupportedPrinterProfile(name, model);
  if (profile) return profile.defaultPaperWidth;
  const s = (name + ' ' + model).toLowerCase();
  if (s.includes('58')) return 'cols-32';
  return 'cols-42';
}

function annotateProfile(info: Omit<PrinterInfo, 'profileId'>): PrinterInfo {
  const profile = matchSupportedPrinterProfile(info.name, info.make, info.model);
  return profile ? { ...info, profileId: profile.id, paperWidth: info.paperWidth || profile.defaultPaperWidth } : info;
}

function parseDeviceUri(uri: string): { ip?: string; port?: number } {
  const m = uri.match(/(?:socket|ipp|ipps|http|https|lpd):\/\/([^:\/\s]+)(?::(\d+))?/i);
  if (!m) return {};
  const host = m[1];
  const port = m[2] ? parseInt(m[2], 10) : undefined;
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  return { ip: isIp ? host : host, port };
}

export async function detectConnectedPrinters(signal?: AbortSignal): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  if (isMasBuild || signal?.aborted) {
    return printers;
  }

  if (process.platform === 'darwin') {
    return await detectMacOSPrinters(signal);
  }

  if (process.platform === 'win32') {
    return detectWindowsPrinters(signal);
  }

  if (process.platform === 'linux') {
    return detectLinuxPrinters(signal);
  }

  return printers;
}

async function detectMacOSPrinters(signal?: AbortSignal): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    const { stdout: lpStatOutput } = await execFileAsync('lpstat', ['-v'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = lpStatOutput.split('\n');

    const printerNames = new Set<string>();

    for (const line of lines) {
      const match = line.match(/device for (\S+):\s*(.+)/);
      if (match) {
        if (signal?.aborted) return printers;
        const name = match[1];
        const uri = match[2].trim();

        if (!printerNames.has(name)) {
          printerNames.add(name);

          const makeModel = await getMacOSPrinterDetails(name, signal);
          const isDefault = await isMacOSDefaultPrinter(name, signal);
          const status = await getMacOSPrinterStatus(name, signal);
          if (signal?.aborted) return printers;
          const isNetwork = /^(socket|ipp|ipps|http|https|lpd):\/\//i.test(uri);
          const { ip, port } = isNetwork ? parseDeviceUri(uri) : {};

          printers.push(annotateProfile({
            name,
            make: makeModel.make,
            model: makeModel.model,
            connectionType: isNetwork ? 'network' : 'usb',
            deviceUri: uri,
            status,
            isDefault,
            ipAddress: ip,
            port: port || (isNetwork ? 9100 : undefined),
            paperWidth: guessPaperWidth(name, makeModel.model),
          }));
        }
      }
    }
  } catch (err) {
    console.log('[Printer] Could not detect macOS printers:', err);
  }

  return printers;
}

async function getMacOSPrinterStatus(name: string, signal?: AbortSignal): Promise<'idle' | 'printing' | 'offline'> {
  try {
    const { stdout } = await execFileAsync('lpstat', ['-p', name], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = stdout.toLowerCase();
    if (out.includes('disabled')) return 'offline';
    if (out.includes('printing') || out.includes('now printing')) return 'printing';
    return 'idle';
  } catch {
    return 'offline';
  }
}

async function getMacOSPrinterDetails(name: string, signal?: AbortSignal): Promise<{ make: string; model: string }> {
  let make = 'Unknown';
  let model = 'Thermal Printer';

  try {
    const { stdout: info } = await execFileAsync('lpoptions', ['-p', name, '-l'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });

    const lower = info.toLowerCase();

    if (lower.includes('epson') || name.toLowerCase().includes('tm-')) {
      make = 'Epson';
      model = extractEpsonModel(name, info);
    } else if (lower.includes('xprinter') || name.toLowerCase().includes('xprinter')) {
      make = 'Xprinter';
      model = name.includes('80') ? 'Xprinter 80mm' : 'Xprinter 58mm';
    } else if (lower.includes('star') || name.toLowerCase().includes('tsp')) {
      make = 'Star';
      model = 'TSP Thermal';
    } else if (lower.includes('zjiang') || name.toLowerCase().includes('zj')) {
      make = 'Zjiang';
      model = '58mm Thermal';
    } else if (lower.includes('zebra')) {
      make = 'Zebra';
      model = 'Zebra Thermal';
    } else if (lower.includes('brother')) {
      make = 'Brother';
      model = 'Brother Thermal';
    } else if (lower.includes('canon')) {
      make = 'Canon';
      model = 'Canon Printer';
    } else if (lower.includes('hp') || lower.includes('hewlett')) {
      make = 'HP';
      model = 'HP Printer';
    } else {
      const nameLower = name.toLowerCase();
      if (nameLower.includes('58') || nameLower.includes('thermal')) {
        make = 'Generic';
        model = '58mm Thermal Printer';
      } else if (nameLower.includes('80')) {
        make = 'Generic';
        model = '80mm Thermal Printer';
      }
    }
  } catch {
    const nameLower = name.toLowerCase();
    if (nameLower.includes('epson') || nameLower.includes('tm-')) {
      make = 'Epson';
      model = 'TM Series';
    } else if (nameLower.includes('xprinter')) {
      make = 'Xprinter';
      model = nameLower.includes('80') ? 'Xprinter 80mm' : 'Xprinter 58mm';
    }
  }

  return { make, model };
}

function extractEpsonModel(name: string, info: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('tm-m30')) return 'TM-m30';
  if (lower.includes('tm-t88')) return 'TM-T88';
  if (lower.includes('tm-t82')) return 'TM-T82';
  if (lower.includes('tm-t20')) return 'TM-T20';
  if (lower.includes('tm-t60')) return 'TM-T60';
  if (lower.includes('tm-l90')) return 'TM-L90';
  if (lower.includes('tm-h600')) return 'TM-H600';
  if (lower.includes('tm-u')) return 'TM-U Series';
  if (lower.includes('tm-')) return 'TM Series';
  return 'Epson Thermal';
}

async function isMacOSDefaultPrinter(name: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const { stdout: defaultPrinter } = await execFileAsync('lpstat', ['-d'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    return defaultPrinter.includes(name);
  } catch {
    return false;
  }
}

// wmic.exe was removed from Windows 11 24H2+, so it can no longer be relied
// on to enumerate printers. Get-CimInstance talks to the same WMI class
// (Win32_Printer) through the still-supported CIM cmdlets, and -EncodedCommand
// (rather than a .ps1) survives a GPO-locked ExecutionPolicy the same way the
// raw-print helper below does.
const DETECT_WINDOWS_PRINTERS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Get-CimInstance -ClassName Win32_Printer -Property Name,Default,PrinterStatus,DriverName |
    Select-Object Name,Default,PrinterStatus,DriverName |
    ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

// Win32_Printer.PrinterStatus: 1=Other, 2=Unknown, 3=Idle, 4=Printing, 5=Warming Up, 6=Stopped Printing, 7=Offline.
function mapWindowsPrinterStatus(printerStatus: unknown): 'idle' | 'printing' | 'offline' {
  if (printerStatus === 3 || printerStatus === 5) return 'idle';
  if (printerStatus === 4) return 'printing';
  return 'offline';
}

async function detectWindowsPrinters(signal?: AbortSignal): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    const encoded = Buffer.from(DETECT_WINDOWS_PRINTERS_SCRIPT, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: PRINTER_DETECTION_TIMEOUT_MS, signal, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    );

    const trimmed = stdout.trim();
    if (trimmed && trimmed !== 'null') {
      const parsed = JSON.parse(trimmed);
      const entries = Array.isArray(parsed) ? parsed : [parsed];

      for (const entry of entries) {
        const name = typeof entry?.Name === 'string' ? entry.Name.trim() : '';
        if (!name) continue;

        const driver = typeof entry.DriverName === 'string' ? entry.DriverName : '';
        const makeModel = detectWindowsMakeModel(name, driver);

        printers.push(annotateProfile({
          name,
          make: makeModel.make,
          model: makeModel.model,
          connectionType: 'usb',
          deviceUri: name,
          driver,
          status: mapWindowsPrinterStatus(entry.PrinterStatus),
          isDefault: entry.Default === true,
          paperWidth: guessPaperWidth(name, makeModel.model),
        }));
      }
    }
  } catch (err) {
    console.log('[Printer] Could not detect Windows printers via Get-CimInstance:', err);
  }

  return printers;
}

function detectWindowsMakeModel(name: string, driver: string): { make: string; model: string } {
  let make = 'Unknown';
  let model = 'Thermal Printer';

  const lower = (name + ' ' + driver).toLowerCase();

  if (lower.includes('epson') || name.toLowerCase().includes('tm-')) {
    make = 'Epson';
    model = name.includes('TM-m30') ? 'TM-m30' :
            name.includes('TM-T88') ? 'TM-T88' :
            name.includes('TM-T82') ? 'TM-T82' :
            name.includes('TM-T20') ? 'TM-T20' : 'TM Series';
  } else if (lower.includes('xprinter')) {
    make = 'Xprinter';
    model = lower.includes('80') ? 'Xprinter 80mm' : 'Xprinter 58mm';
  } else if (lower.includes('star') || lower.includes('tsp')) {
    make = 'Star';
    model = 'TSP Thermal';
  } else if (lower.includes('zjiang')) {
    make = 'Zjiang';
    model = '58mm Thermal';
  } else if (lower.includes('zebra')) {
    make = 'Zebra';
    model = 'Zebra Thermal';
  } else if (lower.includes('brother')) {
    make = 'Brother';
    model = 'Brother Thermal';
  } else if (lower.includes('58') || lower.includes('thermal')) {
    make = 'Generic';
    model = '58mm Thermal';
  } else if (lower.includes('80')) {
    make = 'Generic';
    model = '80mm Thermal';
  }

  return { make, model };
}

// USB vendor ID lookup for common thermal printer brands
const THERMAL_PRINTER_VENDORS: Record<string, string> = {
  '04b8': 'Epson',
  '0456': 'Xprinter',
  '0519': 'Star Micronics',
  '0525': 'Star Micronics',
  '0416': 'Zjiang',
  '0419': 'Bixolon',
  '1d90': 'Citizen',
  '04f9': 'Brother',
};

// Bridge chip vendor IDs (not printer brands — these identify the USB-to-serial chip)
const BRIDGE_CHIP_VENDORS = new Set(['1a86', '10c4', '0403']);

function parseCupsDeviceUri(uri: string): { make: string; model: string } | null {
  // USB URIs look like: usb://Epson/TM-T88V?serial=ABC123
  const usbMatch = uri.match(/usb:\/\/([^/?]+)\/([^?]+)/);
  if (usbMatch) {
    return { make: decodeURIComponent(usbMatch[1]), model: decodeURIComponent(usbMatch[2]) };
  }
  // Network URIs look like: socket://192.168.1.100:9100
  return null;
}

async function getMakeModelFromLpstat(signal?: AbortSignal): Promise<Map<string, { make: string; model: string }>> {
  const result = new Map<string, { make: string; model: string }>();
  try {
    const { stdout: output } = await execFileAsync('lpstat', ['-l', '-p'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    let currentName = '';
    for (const line of output.split('\n')) {
      const nameMatch = line.match(/^printer (\S+) is/);
      if (nameMatch) currentName = nameMatch[1];
      const uriMatch = line.match(/Device URI:\s*(.+)/);
      if (uriMatch && currentName) {
        const parsed = parseCupsDeviceUri(uriMatch[1].trim());
        if (parsed) result.set(currentName, parsed);
      }
    }
  } catch { /* CUPS not available */ }
  return result;
}

function getUsbPrinterVendorIds(): Map<string, { vendorId: string; manufacturer: string | null; product: string | null }> {
  const result = new Map<string, { vendorId: string; manufacturer: string | null; product: string | null }>();
  const devicesDir = '/sys/bus/usb/devices';
  try {
    const entries = fs.readdirSync(devicesDir);
    for (const entry of entries) {
      if (entry.includes(':')) continue; // skip interfaces
      const devPath = `${devicesDir}/${entry}`;
      try {
        const devClass = fs.readFileSync(`${devPath}/bDeviceClass`, 'utf8').trim();
        if (devClass !== '07') continue; // 07 = USB printer class
        const vendorId = fs.readFileSync(`${devPath}/idVendor`, 'utf8').trim();
        const manufacturer = readSysfsSafe(`${devPath}/manufacturer`);
        const product = readSysfsSafe(`${devPath}/product`);
        result.set(entry, { vendorId, manufacturer, product });
      } catch { /* skip device */ }
    }
  } catch { /* sysfs not available */ }
  return result;
}

function readSysfsSafe(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf8').trim(); }
  catch { return null; }
}

async function detectLinuxPrinters(signal?: AbortSignal): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    // Layer 1: Get make/model from CUPS Device URI (most reliable)
    const cupsMakeModel = await getMakeModelFromLpstat(signal);
    if (signal?.aborted) return printers;

    // Layer 2: Get USB vendor IDs from sysfs (works without CUPS)
    const usbVendors = getUsbPrinterVendorIds();

    // Get printer list from CUPS
    const { stdout: output } = await execFileAsync('lpstat', ['-v'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = output.split('\n');

    for (const line of lines) {
      if (signal?.aborted) return printers;
      const match = line.match(/device for (\S+):\s*(.+)/);
      if (match) {
        const name = match[1];
        const uri = match[2].trim();
        const isNetwork = /^(socket|ipp|ipps|http|https|lpd):\/\//i.test(uri);
        const { ip, port } = isNetwork ? parseDeviceUri(uri) : {};

        // Try CUPS Device URI first, then fall back to Generic
        const cupsInfo = cupsMakeModel.get(name);
        let make = cupsInfo?.make || 'Generic';
        let model = cupsInfo?.model || 'Thermal Printer';

        // For USB printers without CUPS info, try sysfs vendor ID lookup
        if (!cupsInfo && !isNetwork) {
          for (const [, vendorInfo] of usbVendors) {
            // Skip bridge chips — they identify the serial adapter, not the printer
            if (BRIDGE_CHIP_VENDORS.has(vendorInfo.vendorId.toLowerCase())) {
              // But if sysfs has manufacturer/product strings, use those
              if (vendorInfo.manufacturer && vendorInfo.product) {
                make = vendorInfo.manufacturer;
                model = vendorInfo.product;
              }
              continue;
            }
            const vendorMake = THERMAL_PRINTER_VENDORS[vendorInfo.vendorId.toLowerCase()];
            if (vendorMake) {
              make = vendorMake;
              model = vendorInfo.product || 'Thermal Printer';
              break;
            }
          }
        }

        printers.push(annotateProfile({
          name,
          make,
          model,
          connectionType: isNetwork ? 'network' : 'usb',
          deviceUri: uri,
          status: 'idle',
          isDefault: false,
          ipAddress: ip,
          port: port || (isNetwork ? 9100 : undefined),
          paperWidth: guessPaperWidth(name, model),
        }));
      }
    }
  } catch {
    console.log('[Printer] Could not detect Linux printers');
  }

  return printers;
}

export async function initPrinter(): Promise<void> {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE is_default = 1').get() as any;
    if (printer) {
      console.log(`[Printer] Default printer: ${printer.name} (${printer.connection_type})`);
    } else {
      console.log('[Printer] No default printer configured');
    }
  } catch (error) {
    console.log('[Printer] Printer initialization skipped (database not ready)');
  }
}

export async function printReceipt(order: any, bill: any, business?: any, template: string = 'classic', useUnicode: boolean = false, isReprint: boolean = false, signal?: AbortSignal, arabicShapingOverride?: boolean, language?: string, additionalLanguage?: string): Promise<DispatchResult> {
  try {
    if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
    console.log('[Printer] printReceipt called, template:', template, 'useUnicode:', useUnicode, 'isReprint:', isReprint);
    const printer = getPrinterConfig();
    if (!printer) {
      console.log('[Printer] No printer configured');
      return { ok: false, detail: 'No printer configured' };
    }
    const { data, warnings, columns } = prepareReceipt(order, bill, business, template, useUnicode, isReprint, arabicShapingOverride, language, additionalLanguage);
    if (hasFinancialPrintWarning(warnings)) {
      return {
        ok: false,
        detail: makeFinancialPrintRefusalMessage(warnings),
        failureClass: 'unsupported',
        warnings,
      };
    }
    const receiptData = printer.cash_drawer_pulse_enabled === 1 ? appendCashDrawerPulse(data) : data;
    console.log('[Printer] Using printer:', printer.name, printer.connection_type, 'columns:', columns);
    console.log('[Printer] Receipt data length:', receiptData.length, 'bytes');
    console.log('[Printer] First 100 bytes:', Array.from(receiptData.slice(0, 100)).map(b => b.toString(16)).join(' '));

    const dispatch = await dispatchPrint(printer, receiptData, signal);
    return warnings.length > 0 ? { ...dispatch, warnings } : dispatch;
  } catch (error: any) {
    console.error('[Printer] Print error:', error);
    return { ok: false, detail: error?.message };
  }
}

export async function printKOT(order: any, items: any[], stationName: string, useUnicode: boolean = false, targetPrinter?: any, signal?: AbortSignal, arabicShapingOverride?: boolean, language?: string): Promise<DispatchResult> {
  try {
    if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
    console.log('[Printer] printKOT called, items count:', items?.length || 0, 'useUnicode:', useUnicode, 'station:', stationName);
    const printer = targetPrinter || getPrinterConfig();
    if (!printer) {
      console.log('[Printer] No printer configured');
      return { ok: false, detail: 'No printer configured' };
    }
    console.log('[Printer] Using printer:', printer.name, printer.connection_type);

    const profile = resolvePrinterProfile(printer);
    const cols = getColumnsForPrinter(printer, profile);

    const db = getDatabase();
    const biz = db.prepare('SELECT * FROM settings LIMIT 1').get() as any;
    const locale = biz?.country ? getCountryByCode(biz.country)?.locale ?? 'en-US' : 'en-US';
    const timezone = getSettingValue('timezone') || 'Asia/Kolkata';
    const tzOptions = { timeZone: timezone };

    const warnings: PrintWarning[] = [];
    // A request-body override (from the renderer's global shaping setting)
    // wins over the profile default so the merchant's explicit choice (#437)
    // applies even when the matched profile leaves the flag unset.
    const capabilities = getPrinterCapabilities(profile, arabicShapingOverride);
    const data = formatKOT(order, items, stationName, cols, useUnicode, profile.cutMode, locale, tzOptions, warnings, capabilities.shaping.arabic, normalizePrintLanguage(language ?? biz?.language), capabilities);
    console.log('[Printer] KOT data length:', data.length, 'bytes');
    const dispatch = await dispatchPrint(printer, data, signal);
    return warnings.length > 0 ? { ...dispatch, warnings } : dispatch;
  } catch (error: any) {
    console.error('[Printer] KOT print error:', error);
    return { ok: false, detail: error?.message };
  }
}

/**
 * Reports a print failure on both telemetry tiers: an anonymous, aggregate
 * Tier 1 event (specs/floadmin.md § 6.1) and, only where the merchant has
 * given the separate opt-in, a Tier 2 store-attributed diagnostic event
 * (§ 6.2). Both are best-effort and must never affect the caller's result —
 * a slow or unreachable telemetry endpoint cannot make checkout wait.
 */
function reportPrintFailure(kind: 'receipt' | 'kot', result: PrintResult): void {
  let connectionType = 'unknown';
  try {
    connectionType = getPrinterConfig()?.connection_type || 'unknown';
  } catch { /* best-effort only */ }

  const failureClass = result.failureClass || classifyPrintFailure(result.detail);
  void sendEvent('print_failed', {
    kind,
    code: result.code,
    stage: result.stage,
    connection_type: connectionType,
    correlation_id: result.correlationId,
    failure_class: failureClass,
    ...(result.platformErrorCode !== undefined ? { platform_error_code: result.platformErrorCode } : {}),
    ...(result.jobId !== undefined ? { job_id: result.jobId } : {}),
  });

  try {
    const message = hasFinancialPrintWarning(result.warnings || [])
      ? FINANCIAL_PRINT_REFUSAL_DIAGNOSTIC
      : (result.detail || `${kind} print failed at ${result.stage} stage`).slice(0, 300);
    cloudSync.reportDiagnostic({
      event_id: randomUUID(),
      event_code: result.code || `print.${kind}.failed`,
      severity: 'error',
      correlation_id: result.correlationId,
      message,
      metadata: {
        connection_type: connectionType,
        kind,
        os_platform: process.platform,
        failure_class: failureClass,
        ...(result.platformErrorCode !== undefined ? { platform_error_code: result.platformErrorCode } : {}),
        ...(result.jobId !== undefined ? { job_id: result.jobId } : {}),
        ...(result.driverName ? { driver_name: result.driverName.slice(0, 160) } : {}),
        ...(result.printerStatus !== undefined ? { printer_status: result.printerStatus } : {}),
      },
      occurred_at: new Date().toISOString(),
    });
  } catch (err) {
    // Never let a diagnostics-plumbing error (e.g. a mid-migration DB) turn a
    // printer failure into an unhandled rejection — the caller must still get
    // back the real PrintResult so the cashier sees the actual printer error.
    console.error('[Printer] reportDiagnostic failed (non-fatal):', err);
  }
}

/** Typed adapters used by API callers while legacy boolean callers migrate. */
export async function printReceiptDetailed(...args: Parameters<typeof printReceipt>): Promise<PrintResult> {
  const id = correlationId();
  try {
    const dispatch = await printReceipt(...args);
    const stage = !dispatch.ok && hasFinancialPrintWarning(dispatch.warnings || []) ? 'prepare' : 'dispatch';
    const result: PrintResult = dispatch.ok
      ? { ok: true, correlationId: id, stage: 'dispatch', warnings: dispatch.warnings }
      : {
        ok: false,
        code: 'print.receipt.failed',
        correlationId: id,
        stage,
        detail: dispatch.detail,
        failureClass: dispatch.failureClass || classifyPrintFailure(dispatch.detail),
        platformErrorCode: dispatch.platformErrorCode || extractPlatformErrorCode(dispatch.detail),
        jobId: dispatch.jobId,
        driverName: dispatch.driverName,
        printerStatus: dispatch.printerStatus,
        warnings: dispatch.warnings,
      };
    if (!result.ok) reportPrintFailure('receipt', result);
    return result;
  } catch (error) {
    const detail = (error as Error).message;
    const result: PrintResult = { ok: false, code: 'print.receipt.failed', correlationId: id, stage: 'dispatch', detail, failureClass: classifyPrintFailure(detail), platformErrorCode: extractPlatformErrorCode(detail) };
    reportPrintFailure('receipt', result);
    return result;
  }
}

export async function printKOTDetailed(...args: Parameters<typeof printKOT>): Promise<PrintResult> {
  const id = correlationId();
  try {
    const dispatch = await printKOT(...args);
    const result: PrintResult = dispatch.ok
      ? { ok: true, correlationId: id, stage: 'dispatch', warnings: dispatch.warnings }
      : {
        ok: false,
        code: 'print.kot.failed',
        correlationId: id,
        stage: 'dispatch',
        detail: dispatch.detail,
        failureClass: dispatch.failureClass || classifyPrintFailure(dispatch.detail),
        platformErrorCode: dispatch.platformErrorCode || extractPlatformErrorCode(dispatch.detail),
        jobId: dispatch.jobId,
        driverName: dispatch.driverName,
        printerStatus: dispatch.printerStatus,
        warnings: dispatch.warnings,
      };
    if (!result.ok) reportPrintFailure('kot', result);
    return result;
  } catch (error) {
    const detail = (error as Error).message;
    const result: PrintResult = { ok: false, code: 'print.kot.failed', correlationId: id, stage: 'dispatch', detail, failureClass: classifyPrintFailure(detail), platformErrorCode: extractPlatformErrorCode(detail) };
    reportPrintFailure('kot', result);
    return result;
  }
}

function getColumnsForPrinter(printer: any, profile: SupportedPrinterProfile): number {
  const paperWidth = printer.paper_width || profile.defaultPaperWidth || '80mm';
  const explicitColumns = columnsForPaperWidth(paperWidth);
  if (explicitColumns) return explicitColumns;
  return profile.fontAColumns || 48;
}

function columnsForPaperWidth(paperWidth: string): number | null {
  const colsMatch = String(paperWidth || '').match(/^cols-(3[2-9]|4[0-8])$/);
  if (colsMatch) return Number(colsMatch[1]);

  switch (paperWidth) {
    case '58mm':
      return 32;
    case '58mm-36':
      return 36;
    case '80mm-42':
      return 42;
    case '80mm':
      return null;
    default:
      return null;
  }
}

async function dispatchPrint(printer: any, data: Buffer, signal?: AbortSignal): Promise<DispatchResult> {
  switch (printer.connection_type) {
    case 'network':
      return await printViaNetwork(printer.ip_address, printer.port || 9100, data, signal);
    case 'usb':
      if (isMasBuild) {
        const detail = 'USB printers are not supported in the App Store build. Use a network printer.';
        console.log(`[Printer] ${detail}`);
        return { ok: false, detail };
      }
      return await printViaUSB(data, printer.name, signal);
    case 'webusb':
      console.log('[Printer] WebUSB printer — not supported in Electron');
      return { ok: false, detail: 'WebUSB printers are handled in the browser, not by the desktop app' };
    default:
      console.log(`[Printer] Unsupported connection type: ${printer.connection_type}`);
      return { ok: false, detail: `Unsupported connection type: ${printer.connection_type}` };
  }
}

function getPrinterConfig(): any {
  const db = getDatabase();
  return db.prepare(
    `SELECT * FROM printers
     WHERE connection_type != 'webusb'
     ORDER BY is_default DESC, name
     LIMIT 1`,
  ).get();
}

export function prepareReceipt(order: any, bill: any, business?: any, template: string = 'classic', useUnicode: boolean = false, isReprint: boolean = false, arabicShapingOverride?: boolean, language?: string, additionalLanguage?: string): {
  printer: any;
  data: Buffer;
  warnings: PrintWarning[];
  columns: number;
} {
  let printer = getPrinterConfig();
  if (!printer) {
    printer = {
      id: 0,
      name: 'Default 80mm Preview',
      paper_width: '80mm',
    };
  }

  const profile = resolvePrinterProfile(printer);
  const columns = getColumnsForPrinter(printer, profile);
  const warnings: PrintWarning[] = [];
  // A request-body override (from the renderer's global shaping setting)
  // wins over the profile default (#437); absent override keeps the
  // profile's declared capability.
  const capabilities = getPrinterCapabilities(profile, arabicShapingOverride);
  const data = formatReceipt(order, bill, business, template, columns, useUnicode, isReprint, profile.cutMode, warnings, capabilities.shaping.arabic, language, additionalLanguage, capabilities);
  return { printer, data, warnings, columns };
}

export function formatReceipt(order: any, bill: any, business?: any, template?: string, cols: number = 48, useUnicode: boolean = false, isReprint: boolean = false, cutMode: PrinterCutMode = 'full', warnings?: PrintWarning[], arabicShaping: boolean = false, language?: string, additionalLanguage?: string, capabilities?: ThermalPrinterCapabilities): Buffer {
  console.log('[Printer] formatReceipt - template:', template);
  console.log('[Printer] formatReceipt - order:', order?.order_number, 'bill:', bill?.bill_number);
  console.log('[Printer] formatReceipt - items count:', order?.items?.length || 0, 'cols:', cols);

  const lang = normalizePrintLanguage(language);
  const biz = business || { name: 'Store', address: '', phone: '', taxRegistrationNumber: '' };
  // Structured selection identity (#447): the persisted bill_template value
  // may be a structured { source, id } JSON string or any legacy bare value.
  // Merchant templates resolve through the document pipeline; pack templates
  // keep their compliance renderer; unknown values fall through to the core
  // classic/compact name matching below (unchanged behavior).
  const selection = parseBillTemplateSelection(template);
  if (selection?.source === 'pack') {
    return renderPluginReceipt(
      loadInstalledPrintTemplate(selection.id),
      order, bill, biz, cols, useUnicode, isReprint, cutMode, warnings, arabicShaping, lang,
      capabilities,
    );
  }
  if (selection?.source === 'merchant') {
    const result = renderMerchantReceiptViaDocument(order, bill, biz, selection.id, {
      columns: cols,
      language: lang,
      ...(additionalLanguage !== undefined ? { additionalLanguage: normalizePrintLanguage(additionalLanguage) } : {}),
      isReprint,
      useUnicode,
      arabicShaping,
      cutMode,
      capabilities,
    });
    if (warnings && result.warnings.length > 0) warnings.push(...result.warnings);
    return result.data;
  }
  const tpl = normalizeReceiptTemplate(selection?.source === 'core' ? selection.id : template);

  try {
    switch (tpl) {
      case 'classic':
        return formatClassicReceipt(order, bill, biz, cols, useUnicode, isReprint, cutMode, warnings, arabicShaping, lang, additionalLanguage, capabilities);
      default:
        return formatCompactReceipt(order, bill, biz, cols, useUnicode, isReprint, cutMode, warnings, arabicShaping, lang, additionalLanguage, capabilities);
    }
  } catch (err) {
    console.error('[Printer] formatReceipt error:', err);
    throw err;
  }
}

export function normalizeReceiptTemplate(template?: string): 'classic' | 'compact' {
  const normalized = String(template || 'classic').toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.includes('compact') || normalized.includes('minimal')) return 'compact';
  return 'classic';
}

function renderPluginReceipt(template: ReturnType<typeof loadInstalledPrintTemplate>, order: any, bill: any, biz: any, cols: number, useUnicode: boolean, isReprint: boolean, cutMode: PrinterCutMode, warnings?: PrintWarning[], arabicShaping: boolean = false, lang: string = 'en', capabilities?: ThermalPrinterCapabilities): Buffer {
  if (!template) return formatClassicReceipt(order, bill, biz, cols, useUnicode, isReprint, cutMode, warnings, arabicShaping, lang, undefined, capabilities);
  const renderer = parseJson(template.renderer_json, {}) as { id?: string; version?: number };
  const payload = parseJson(template.template_payload_json, {}) as any;
  if (renderer.id !== 'flocafe-thermal-receipt-template'
    || renderer.version !== 1
    || payload.format !== 'escpos-line-template-v1') {
    throw new Error(`Unsupported receipt plugin renderer for template ${template.template_id}`);
  }
  const profile = selectTemplateWidthProfile(payload, cols, warnings);
  return renderEscposLineTemplateV1(payload, profile, order, bill, biz, useUnicode, isReprint, cutMode, warnings, arabicShaping, lang, capabilities);
}

function parseJson(raw: string, fallback: unknown): unknown {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function selectTemplateWidthProfile(payload: any, printerColumns: number, warnings?: PrintWarning[]): { columns: number; layout: any } {
  const profiles = collectTemplateWidthProfiles(payload);
  const exact = profiles.find((profile) => profile.columns === printerColumns);
  if (exact) return exact;
  const smaller = profiles.filter((profile) => profile.columns < printerColumns).sort((a, b) => b.columns - a.columns)[0];
  if (smaller) return smaller;

  warnings?.push({
    field: 'bill_template_width',
    text: String(printerColumns),
    message: `Template has no ${printerColumns}-column profile; rendered with the printer width instead of squeezing a wider profile.`,
  });
  return { columns: printerColumns, layout: {} };
}

function collectTemplateWidthProfiles(payload: any): Array<{ columns: number; layout: any }> {
  if (!Array.isArray(payload?.widthProfiles)) return [];
  return payload.widthProfiles
    .map((profile: any) => ({
      columns: Number(profile?.columns),
      layout: profile?.layout && typeof profile.layout === 'object' ? profile.layout : {},
    }))
    .filter((profile: { columns: number }) => Number.isInteger(profile.columns) && profile.columns >= 32 && profile.columns <= 48)
    .sort((a: { columns: number }, b: { columns: number }) => a.columns - b.columns);
}

function renderEscposLineTemplateV1(payload: any, profile: { columns: number; layout: any }, order: any, bill: any, biz: any, useUnicode: boolean, isReprint: boolean, cutMode: PrinterCutMode, warnings?: PrintWarning[], arabicShaping: boolean = false, lang: string = 'en', capabilities?: ThermalPrinterCapabilities): Buffer {
  const lines: string[] = [];
  const cols = profile.columns;
  const layout = profile.layout || {};
  const date = parseDbTimestamp(order.created_at);
  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);
  const prefix = resolveCurrencyPrefix(biz.currency_symbol || '₹', useUnicode);
  const fractionDigits = getCurrencyFractionDigits(biz.currency || 'INR');
  const trimDecimals = biz.trim_decimals === true;
  const locale = getCountryByCode(biz.country)?.locale ?? 'en-US';
  const normalize = (text: string): string => normalizeThermalText(text, capabilities);
  const configuredTaxLabel = normalize(sanitizeTemplateLabelText(String(payload?.fields?.taxRegistrationNumberLabel || getCountryByCode(biz.country)?.taxIdLabel || 'Tax ID')));
  const taxComponents = resolveTaxComponents({ ...bill, items: order.items });
  const hasTax = Number(bill.tax_amount) !== 0
    || taxComponents.some((component) => component.amount !== 0);
  // Pack-supplied strings (#445 review): sanitized against reserved printer
  // tokens ({CUT}/{FEED}/{INIT} and styling braces) and clamped to the selected
  // width profile before they reach the receipt builder; the localized resolver
  // fallback applies the same treatment.
  const title = hasTax
    ? fitTemplateLabel(normalize(String(payload?.header?.taxTitleWhenTaxPresent || '')), cols) || fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, 'taxInvoice', lang)), cols)
    : fitTemplateLabel(normalize(String(payload?.header?.titleWhenTaxAbsent || '')), cols) || fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, 'invoice', lang)), cols);
  const tzOptions = biz.timezone ? { timeZone: biz.timezone } : undefined;

  lines.push('{INIT}');
  if (isReprint) lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + normalize(printLabel(lang, 'receipt.reprint')) + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  if (biz.show_name !== false && biz.name) {
    const name = payload?.header?.businessNameTransform === 'uppercase'
      ? String(biz.name).toUpperCase()
      : String(biz.name);
    lines.push('{STORE_NAME}{CENTER}{BOLD}' + truncateShapedLine(name, cols, arabicShaping, lang, capabilities) + '{/BOLD}{/CENTER}');
  }
  lines.push(bar);
  lines.push(`{CENTER}${title}{/CENTER}`);
  lines.push(bar);
  lines.push(normalize(printLabel(lang, 'print.invoiceNumber')) + ' ' + (bill.bill_number || order.order_number));
  lines.push(normalize(printLabel(lang, 'receipt.date')) + ': ' + date.toLocaleDateString(locale + '-u-nu-latn', tzOptions));
  lines.push(normalize(printLabel(lang, 'print.time')) + ': ' + date.toLocaleTimeString(locale + '-u-nu-latn', tzOptions));
  if (biz.show_table_number !== false && order.table?.name) lines.push(truncateShapedLine(formatTableLabel(order.table.name, lang), cols, arabicShaping, lang, capabilities));
  if (biz.show_customer_name !== false && biz.customer_name) lines.push(truncateShapedLine(printLabel(lang, 'pos.customer') + ': ' + biz.customer_name, cols, arabicShaping, lang, capabilities));
  if (biz.show_customer_phone !== false && biz.customer_phone) lines.push(normalize(printLabel(lang, 'print.numberShort')) + ': ' + biz.customer_phone);
  lines.push(dash);
  lines.push(pluginItemHeader(layout, cols, lang, capabilities));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      lines.push(...pluginItemRows(item, layout, cols, prefix, locale, trimDecimals, fractionDigits, lang, capabilities));
      if (pluginDetailLines(layout).includes('addons')) {
        for (const addon of parseAddons(item.addons)) {
          const addonLines: string[] = [];
          pushWrapped(addonLines, '  + ' + addon.name + (addon.price ? ' ' + formatCurrency(addon.price, prefix, locale, trimDecimals, fractionDigits) : ''), cols, lang, capabilities);
          lines.push(...addonLines.map((line) => addon.price ? '{FINANCIAL}' + line : line));
        }
      }
      if (pluginDetailLines(layout).includes('specialInstructions') && item.special_instructions) {
        pushWrapped(lines, '  ' + normalize(printLabel(lang, 'print.note')) + ': ' + item.special_instructions, cols, lang, capabilities);
      }
    }
  }

  lines.push(dash);
  // Row labels share their line with a right-aligned amount, so they are
  // clamped to the width profile minus the same 12-column amount reserve the
  // payment-method rows already use; title/footer labels clamp to the full
  // width (#445 review F2).
  const rowLabelWidth = Math.max(8, cols - 12);
  if (payload?.totals?.showSubtotal !== false) {
    const label = fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, 'subtotal', lang)), rowLabelWidth);
    lines.push(...financialRows(label, formatCurrency(bill.subtotal, prefix, locale, trimDecimals, fractionDigits), cols, lang, capabilities));
  }
  if (Number(bill.discount_amount) > 0 && payload?.totals?.showDiscount !== false) {
    const label = fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, 'discount', lang)), rowLabelWidth);
    lines.push(...financialRows(label, '-' + formatCurrency(bill.discount_amount, prefix, locale, trimDecimals, fractionDigits), cols, lang, capabilities));
  }
  if (biz.show_tax_breakdown !== false && taxComponents.length > 0) {
    for (const tax of taxComponents) {
      if (tax.amount === 0) continue;
      const rawLabel = tax.rate === null ? tax.title : `${tax.title} @${tax.rate}%`;
      lines.push(pluginSummaryRow(rawLabel, formatCurrency(tax.amount, prefix, locale, trimDecimals, fractionDigits), layout, cols, lang, capabilities));
    }
  } else if (Number(bill.tax_amount) !== 0) {
    const label = fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, 'tax', lang)), rowLabelWidth);
    lines.push(...financialRows(label, formatCurrency(bill.tax_amount, prefix, locale, trimDecimals, fractionDigits), cols, lang, capabilities));
  }
  // `chargeRows` is an explicit capability declaration. Its order is not
  // presentation authority: country/legal rows remain in this stable order,
  // and zero-valued persisted charges stay absent.
  const chargeAmounts: Record<TemplateChargeRowId, number> = {
    serviceCharge: Number(bill.service_charge) || 0,
    deliveryCharge: Number(bill.delivery_charge) || 0,
    packagingCharge: Number(bill.packaging_charge) || 0,
  };
  for (const row of declaredTemplateChargeRows(payload?.totals?.chargeRows)) {
    const amount = chargeAmounts[row];
    if (amount === 0) continue;
    const label = fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, row, lang)), rowLabelWidth);
    lines.push(...financialRows(label, formatCurrency(amount, prefix, locale, trimDecimals, fractionDigits), cols, lang, capabilities));
  }
  lines.push(bar);
  // Label precedence (#445): the author's structural literal (e.g.
  // totals.grandTotalLabel) is most specific and wins first; the additive
  // payload-root `labels` map overrides next; otherwise the built-in default
  // resolves localized through the canonical print-labels catalog (#440).
  const totalLabel = fitTemplateLabel(normalize(String(payload?.totals?.grandTotalLabel || '')), rowLabelWidth) || fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, 'total', lang)), rowLabelWidth);
  lines.push(...financialRows(totalLabel, formatCurrency(bill.total, prefix, locale, trimDecimals, fractionDigits), cols, lang, capabilities).map((line) => `{BOLD}${line}{/BOLD}`));

  if (bill.payment_details) {
    lines.push(dash);
    try {
      const payments = typeof bill.payment_details === 'string' ? JSON.parse(bill.payment_details) : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            const methodLabel = truncate(resolvePaymentMethodLabel(String(payment.method), lang), cols - 12, lang, capabilities);
            lines.push(...financialRows(methodLabel, formatCurrency(payment.amount, prefix, locale, trimDecimals, fractionDigits), cols, lang, capabilities));
          }
        }
      }
    } catch (err: any) {
      console.warn('[Printer] Failed to parse payment details JSON:', err.message);
    }
  }

  lines.push(bar);
  if (biz.show_address !== false && biz.address) pushWrapped(lines, normalize(printLabel(lang, 'print.address')) + ': ' + biz.address, cols, lang, capabilities);
  if (biz.show_phone !== false && biz.phone) pushWrapped(lines, normalize(printLabel(lang, 'print.phoneLong')) + ': ' + biz.phone, cols, lang, capabilities);
  const showTaxRegistration = payload?.totals?.showTaxRegistrationNumber === 'when_tax_present_or_enabled'
    ? (hasTax || biz.show_tax_id === true)
    : biz.show_tax_id === true;
  if (showTaxRegistration && biz.taxRegistrationNumber) pushWrapped(lines, configuredTaxLabel + ': ' + biz.taxRegistrationNumber, cols, lang, capabilities);
  if (payload?.footer?.useConfiguredFooterNote !== false && biz.footer_note) pushCenteredWrapped(lines, biz.footer_note, cols, lang, capabilities);
  else lines.push('{CENTER}' + (fitTemplateLabel(normalize(String(payload?.footer?.defaultMessage || '')), cols) || fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, 'footerThanks', lang)), cols)) + '{/CENTER}');
  if (payload?.footer?.includePoweredByFloPOS !== false) appendPoweredByFooter(lines);
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode, { cutMode, arabicShaping, columns: cols, language: lang, capabilities }, warnings);
}

export function appendPoweredByFooter(lines: string[]): void {
  lines.push('{CENTER}{FONT_B}' + RECEIPT_BRANDING_NAME + '{/FONT_B}{/CENTER}');
  lines.push('{CENTER}{FONT_B}' + RECEIPT_BRANDING_URL + '{/FONT_B}{/CENTER}');
}

/**
 * Compact thermal receipt (#443): builds a PrintDocument from normalized
 * print data and renders it through the document pipeline (document-compact).
 */
export function formatCompactReceipt(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false, isReprint: boolean = false, cutMode: PrinterCutMode = 'full', warnings?: PrintWarning[], arabicShaping: boolean = false, lang: string = 'en', additionalLanguage?: string, capabilities?: ThermalPrinterCapabilities): Buffer {
  const result = renderCompactReceiptViaDocument(order, bill, biz, {
    columns: cols,
    language: lang,
    ...(additionalLanguage !== undefined ? { additionalLanguage } : {}),
    isReprint,
    useUnicode,
    arabicShaping,
    cutMode,
    capabilities,
  });
  if (warnings && result.warnings.length > 0) warnings.push(...result.warnings);
  return result.data;
}

/**
 * Classic thermal receipt (#443): builds a PrintDocument from normalized
 * print data and renders it through the document pipeline (document-classic).
 * Token-line emission stays an implementation detail of the ESC/POS renderer.
 */
export function formatClassicReceipt(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false, isReprint: boolean = false, cutMode: PrinterCutMode = 'full', warnings?: PrintWarning[], arabicShaping: boolean = false, lang: string = 'en', additionalLanguage?: string, capabilities?: ThermalPrinterCapabilities): Buffer {
  const result = renderClassicReceiptViaDocument(order, bill, biz, {
    columns: cols,
    language: lang,
    ...(additionalLanguage !== undefined ? { additionalLanguage } : {}),
    isReprint,
    useUnicode,
    arabicShaping,
    cutMode,
    capabilities,
  });
  if (warnings && result.warnings.length > 0) warnings.push(...result.warnings);
  return result.data;
}

type PluginColumnAlign = 'left' | 'right' | 'center';
type PluginLineColumn = {
  key?: string;
  label?: string;
  width?: number;
  align?: PluginColumnAlign;
  wrap?: boolean;
  maxLines?: number;
  ellipsis?: boolean;
};

function pluginLineItemColumns(layout: any, cols: number, lang: string = 'en', capabilities?: ThermalPrinterCapabilities): PluginLineColumn[] {
  const configured = layout?.lineItems?.columns;
  if (Array.isArray(configured) && configured.length > 0) {
    const columns = configured
      .map((column: any) => ({
        key: typeof column?.key === 'string' ? column.key : undefined,
        label: typeof column?.label === 'string'
          ? normalizeThermalText(column.label, capabilities)
          : undefined,
        width: Number(column?.width),
        align: column?.align === 'right' || column?.align === 'center' ? column.align : 'left',
        wrap: column?.wrap === true,
        maxLines: Number.isInteger(column?.maxLines) && column.maxLines > 0 ? column.maxLines : undefined,
        ellipsis: column?.ellipsis !== false,
      }))
      .filter((column: PluginLineColumn) => column.key && Number.isInteger(column.width) && Number(column.width) > 0);
    if (columns.length > 0) return columns;
  }
  return [
    { key: 'item', label: normalizeThermalText(printLabel(lang, 'receipt.item'), capabilities), width: itemNameWidth(cols, 10), align: 'left', wrap: true, maxLines: 2, ellipsis: true },
    { key: 'quantity', label: normalizeThermalText(printLabel(lang, 'receipt.qty'), capabilities), width: 4, align: 'left' },
    { key: 'amount', label: normalizeThermalText(printLabel(lang, 'receipt.amount'), capabilities), width: 10, align: 'right' },
  ];
}

function pluginLineGap(layout: any): number {
  const gap = Number(layout?.lineItems?.gap);
  return Number.isInteger(gap) && gap >= 0 && gap <= 4 ? gap : 0;
}

function pluginDetailLines(layout: any): string[] {
  const detailLines = layout?.lineItems?.detailLines;
  if (!Array.isArray(detailLines)) return ['addons', 'specialInstructions'];
  return detailLines.filter((line: unknown) => typeof line === 'string');
}

function pluginItemHeader(layout: any, cols: number, lang: string = 'en', capabilities?: ThermalPrinterCapabilities): string {
  return composePluginColumns(
    pluginLineItemColumns(layout, cols, lang, capabilities).map((column) => ({
      ...column,
      value: column.label || column.key || '',
    })),
    pluginLineGap(layout),
    cols,
  );
}

function pluginItemRows(item: any, layout: any, cols: number, prefix: string, locale: string, trimDecimals: boolean, fractionDigits: number, lang: string = 'en', capabilities?: ThermalPrinterCapabilities): string[] {
  const columns = pluginLineItemColumns(layout, cols, lang, capabilities);
  const gap = pluginLineGap(layout);
  const values = columns.map((column) => ({
    ...column,
    value: normalizeThermalText(pluginItemColumnValue(column.key || '', item, prefix, locale, trimDecimals, fractionDigits), capabilities),
  }));
  const wrappedValues = values.map((column) => {
    if (!column.wrap) return [truncateCell(column.value, Number(column.width), column.ellipsis !== false)];
    const maxLines = column.maxLines || 2;
    const wrapped = wrapText(column.value, Number(column.width));
    const limited = wrapped.slice(0, maxLines);
    if (wrapped.length > maxLines && limited.length > 0 && column.ellipsis !== false) {
      limited[limited.length - 1] = truncateCell(limited[limited.length - 1], Number(column.width), true);
    }
    return limited.length > 0 ? limited : [''];
  });
  const lineCount = Math.max(1, ...wrappedValues.map((value) => value.length));
  const rows: string[] = [];
  for (let index = 0; index < lineCount; index++) {
    rows.push('{FINANCIAL}' + composePluginColumns(values.map((column, columnIndex) => ({
      ...column,
      value: wrappedValues[columnIndex][index] || '',
    })), gap, cols));
  }
  return rows;
}

function pluginItemColumnValue(key: string, item: any, prefix: string, locale: string, trimDecimals: boolean, fractionDigits: number): string {
  switch (key) {
    case 'item':
      return String(item.product_name || '');
    case 'quantity':
      return String(item.quantity ?? '');
    case 'rate': {
      const quantity = Number(item.quantity) || 0;
      const rate = Number(item.unit_price ?? item.price ?? (quantity ? Number(item.total) / quantity : 0));
      return formatCurrency(rate, prefix, locale, trimDecimals, fractionDigits);
    }
    case 'taxRate':
      return pluginItemTaxRate(item);
    case 'amount':
      return formatCurrency(item.total, prefix, locale, trimDecimals, fractionDigits);
    default:
      return '';
  }
}

function pluginItemTaxRate(item: any): string {
  const rates = new Set<string>();
  const breakdown = Array.isArray(item.tax_breakdown) ? item.tax_breakdown : [];
  for (const component of breakdown) {
    if (component?.rate !== null && component?.rate !== undefined) rates.add(String(component.rate));
  }
  return [...rates].join('+');
}

function pluginSummaryRow(label: string, amount: string, layout: any, cols: number, lang: string = 'en', capabilities?: ThermalPrinterCapabilities): string {
  const normalizedLabel = normalizeThermalText(label, capabilities);
  const labelWidth = Number(layout?.taxSummary?.labelWidth);
  const amountWidth = Number(layout?.taxSummary?.amountWidth);
  if (Number.isInteger(labelWidth) && Number.isInteger(amountWidth) && labelWidth > 0 && amountWidth > 0) {
    return '{FINANCIAL}' + composePluginColumns([
      { value: normalizedLabel, width: labelWidth, align: 'left', ellipsis: true },
      { value: amount, width: amountWidth, align: 'right', ellipsis: true },
    ], Math.max(0, cols - labelWidth - amountWidth), cols);
  }
  const safeLabel = truncate(normalizedLabel, cols - 12, lang, capabilities);
  return '{FINANCIAL}' + safeLabel + rightAlign(amount, cols - safeLabel.length);
}

function composePluginColumns(columns: Array<PluginLineColumn & { value: string }>, gap: number, cols: number): string {
  const separator = ' '.repeat(gap);
  const line = columns.map((column) => alignCell(
    truncateCell(column.value, Number(column.width), column.ellipsis !== false),
    Number(column.width),
    column.align || 'left',
  )).join(separator);
  return truncateCell(line, cols, false).padEnd(Math.min(cols, line.length));
}

function alignCell(value: string, width: number, align: PluginColumnAlign): string {
  const text = truncateCell(value, width, true);
  if (align === 'right') return text.padStart(width);
  if (align === 'center') {
    const left = Math.floor((width - text.length) / 2);
    return ' '.repeat(Math.max(0, left)) + text.padEnd(Math.max(0, width - left));
  }
  return text.padEnd(width);
}

function truncateCell(text: string, length: number, ellipsis: boolean): string {
  const value = String(text || '');
  if (length <= 0) return '';
  if (value.length <= length) return value;
  if (!ellipsis || length <= 2) return value.slice(0, length);
  return value.slice(0, length - 2) + '..';
}

// Item row layout: [ name (nameLen) ][ qty (4) ][ amount right-aligned (amtLen) ].
// Item rows keep [ name ][ qty ][ amount ] inline when the value fits; an
// oversized amount continues on full-width lines. Tax components belong in
// the document-level breakdown, not a redundant per-item column derived from
// deprecated product tax fields.
export function itemNameWidth(cols: number, amtLen: number): number {
  return Math.max(1, cols - 4 - amtLen);
}

export function itemAmountWidth(
  order: { items?: Array<{ total?: number; addons?: unknown }> } | null | undefined,
  prefix: string,
  locale: string,
  trimDecimals: boolean,
  cols: number,
  fractionDigits: number = 2,
): number {
  // rightAlign() keeps at least one separator before an amount, so reserve
  // that separator when a long currency prefix expands the amount column.
  let width = 10;
  for (const item of order?.items ?? []) {
    width = Math.max(width, formatCurrency(item.total ?? 0, prefix, locale, trimDecimals, fractionDigits).length + 1);
    for (const addon of parseAddons(item.addons)) {
      if (addon?.price) {
        width = Math.max(width, formatCurrency(addon.price, prefix, locale, trimDecimals, fractionDigits).length + 1);
      }
    }
  }
  return Math.min(width, Math.max(1, cols - 5));
}

export function itemRows(item: any, nameLen: number, amtLen: number, cols: number, prefix: string, locale: string = 'en-US', trimDecimals: boolean = false, language: string = 'en', fractionDigits: number = 2, capabilities?: ThermalPrinterCapabilities): string[] {
  const qtyW = 4;
  const productName = normalizeThermalText(item.product_name, capabilities);
  const name = truncate(productName, nameLen, language, capabilities).padEnd(nameLen);
  const qty = String(item.quantity).padEnd(qtyW);
  const label = name + qty;
  const amount = formatCurrency(item.total, prefix, locale, trimDecimals, fractionDigits);
  const inlineWidth = Math.max(1, cols - label.length - 1);
  if (amount.length <= inlineWidth) return ['{FINANCIAL}' + label + rightAlign(amount, cols - label.length)];
  return ['{FINANCIAL}' + label.trimEnd(), ...wrapValue(amount, cols).map((line) => '{FINANCIAL}' + line)];
}

export function addonRows(addon: any, nameLen: number, amtLen: number, cols: number, prefix: string, locale: string = 'en-US', trimDecimals: boolean = false, language: string = 'en', fractionDigits: number = 2, capabilities?: ThermalPrinterCapabilities): string[] {
  const addonName = normalizeThermalText(addon.name, capabilities);
  const quantity = typeof addon.quantity === 'number' && addon.quantity > 1 ? ` x${addon.quantity}` : '';
  const label = truncate('  + ' + addonName + quantity, nameLen, language, capabilities).padEnd(nameLen);
  if (!addon.price) return [label + ' '.repeat(Math.max(0, cols - label.length))];
  const price = formatCurrency(addon.price, prefix, locale, trimDecimals, fractionDigits);
  const inlineWidth = Math.max(1, cols - label.length - 1);
  if (price.length <= inlineWidth) return ['{FINANCIAL}' + label + rightAlign(price, cols - label.length)];
  return ['{FINANCIAL}' + label.trimEnd(), ...wrapValue(price, cols).map((line) => '{FINANCIAL}' + line)];
}

export function financialRows(label: string, value: string, cols: number, language: string = 'en', capabilities?: ThermalPrinterCapabilities): string[] {
  const normalizedLabel = normalizeThermalText(label, capabilities);
  const safeLabel = normalizedLabel.slice(0, Math.max(1, cols - 1));
  const inlineWidth = Math.max(1, cols - safeLabel.length - 1);
  if (value.length <= inlineWidth) {
    return ['{FINANCIAL}' + safeLabel + rightAlign(value, cols - safeLabel.length)];
  }
  return ['{FINANCIAL}' + safeLabel, ...wrapValue(value, cols).map((line) => '{FINANCIAL}' + line)];
}

function wrapValue(value: string, cols: number): string[] {
  const width = Math.max(1, cols);
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += width) {
    lines.push(value.slice(offset, offset + width));
  }
  return lines.length > 0 ? lines : [''];
}

function parseAddons(addons: any): any[] {
  return Array.isArray(addons) ? addons : [];
}

function getSafeLatnLocale(locale: string | undefined): string {
  if (!locale) return 'en-US-u-nu-latn';
  if (/-nu-[a-z0-9]+/i.test(locale)) {
    return locale.replace(/-nu-[a-z0-9]+/i, '-nu-latn');
  }
  if (locale.includes('-u-')) {
    return `${locale}-nu-latn`;
  }
  return `${locale}-u-nu-latn`;
}

export function formatCurrency(amount: number, prefix: string, locale: string = 'en-US', trimDecimals: boolean = false, fractionDigits: number = 2): string {
  const numeric = Number(amount) || 0;
  const factor = 10 ** fractionDigits;
  const hasDecimals = Math.round(numeric * factor) % factor !== 0;
  const safeLocale = getSafeLatnLocale(locale);
  const formattedNum = numeric.toLocaleString(safeLocale, {
    minimumFractionDigits: trimDecimals && !hasDecimals ? 0 : fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).replace(/[\u00A0\u202F]/g, ' ');
  return prefix + formattedNum;
}

export function rightAlign(text: string, width: number = 24): string {
  return ' '.repeat(Math.max(1, width - text.length)) + text;
}

export function truncate(text: string, length: number, language: string = 'en', capabilities?: ThermalPrinterCapabilities): string {
  const normalizedText = normalizeThermalText(text, capabilities);
  return normalizedText.length > length ? normalizedText.substring(0, length - 2) + '..' : normalizedText;
}

export function truncateShapedLine(text: string, length: number, arabicShaping: boolean, language: string = 'en', capabilities?: ThermalPrinterCapabilities): string {
  const normalizedText = normalizeThermalText(text, capabilities);
  return arabicShaping && hasArabicScript(normalizedText) ? truncate(normalizedText, Math.max(1, length), language, capabilities) : normalizedText;
}

/**
 * Receipt label language resolution (#440). Unknown or ungenerated languages
 * fall back to English so receipts always render real labels.
 */
export function normalizePrintLanguage(language?: string): string {
  return language && isGeneratedPrintLanguage(language) ? language : 'en';
}

const PAYMENT_METHOD_CONCEPTS: Record<string, PrintConceptId> = {
  cash: 'pos.methodCash',
  card: 'pos.methodCard',
  wallet: 'pos.methodWallet',
};

/** Ported from web-print.ts (#440): known methods localize; unknown keep the capitalize fallback. */
export function resolvePaymentMethodLabel(method: string, lang: string): string {
  const concept = PAYMENT_METHOD_CONCEPTS[String(method || '').toLowerCase()];
  if (concept) return printLabel(lang, concept);
  return capitalize(String(method || ''));
}

/** pos.tableLabel carries an ICU {name} placeholder; backend rendering swaps it inline. */
export function formatTableLabel(tableName: string, lang: string): string {
  return printLabel(lang, 'pos.tableLabel').replace('{name}', tableName);
}

function capitalize(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function wrapText(text: string, cols: number): string[] {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length > cols) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += cols) {
        lines.push(word.slice(i, i + cols));
      }
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= cols) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

export function pushWrapped(lines: string[], text: string, cols: number, language: string = 'en', capabilities?: ThermalPrinterCapabilities): void {
  const normalized = normalizeThermalText(text, capabilities);
  for (const line of wrapText(normalized, cols)) lines.push(line);
}

export function pushCenteredWrapped(lines: string[], text: string, cols: number, language: string = 'en', capabilities?: ThermalPrinterCapabilities): void {
  const normalized = normalizeThermalText(text, capabilities);
  for (const line of wrapText(normalized, cols)) lines.push('{CENTER}' + line + '{/CENTER}');
}

/**
 * Kitchen order ticket (#443): builds a KotDocument (single-language policy
 * resolved by the caller through the kernel) and renders it via the document
 * pipeline (document-kot).
 */
export function formatKOT(order: any, items: any[], stationName: string, cols: number = 48, useUnicode: boolean = false, cutMode: PrinterCutMode = 'full', locale: string = 'en-US', tzOptions?: any, warnings?: PrintWarning[], arabicShaping: boolean = false, language?: string, capabilities?: ThermalPrinterCapabilities): Buffer {
  const lang = normalizePrintLanguage(language);
  const result = renderKotViaDocument(order, items, stationName, {
    columns: cols,
    language: lang,
    ...(locale ? { locale } : {}),
    ...(tzOptions?.timeZone ? { timezone: String(tzOptions.timeZone) } : {}),
    useUnicode,
    arabicShaping,
    cutMode,
    capabilities,
  });
  if (warnings && result.warnings.length > 0) warnings.push(...result.warnings);
  return result.data;
}

export function buildTestPage(paperWidth: string = '80mm', cutMode: PrinterCutMode = 'full', language?: string, timezone?: string): Buffer {
  const width = columnsForPaperWidth(paperWidth) || 48;
  const lang = normalizePrintLanguage(language);
  const label = (concept: PrintConceptId): string => normalizeThermalText(printLabel(lang, concept));
  const bar = '='.repeat(width);
  const ruler = Array.from({ length: width }, (_, i) => String((i + 1) % 10)).join('');
  const edgeProbe = 'X'.repeat(width);
  const lines = [
    '{INIT}',
    '{CENTER}{BOLD}' + label('print.test.title') + '{/BOLD}{/CENTER}',
    '',
    bar,
    '{CENTER}' + label('print.test.networkUsb') + '{/CENTER}',
    bar,
    '',
    `${label('print.test.columns')}: ${width}`,
    ...wrapText(label('print.test.wrapHint'), width),
    ruler,
    edgeProbe,
    bar,
    `${label('print.time')}: ${new Date().toLocaleString('en-US-u-nu-latn', timezone ? { timeZone: timezone } : undefined)}`,
    '',
    bar,
    '{CENTER}' + label('print.test.success') + '{/CENTER}',
    bar,
    '{CUT}',
  ];
  return buildEscPos(lines, false, { cutMode, language: lang });
}

// Every ASCII fallback is no wider than 3 characters, so currency labels such
// as USD/EUR/INR have a stable reserved slot in receipt amount columns.
const CURRENCY_ASCII_MAP: Record<string, string> = {
  '₹': 'Rs', '₨': 'Rs', '€': 'EUR', '£': 'GBP', '¥': 'Yen',
  '₩': 'KRW', '₺': 'TRY', '₫': 'VND', '₪': 'ILS', '₽': 'RUB',
  '฿': 'THB', '₱': 'PHP', '₴': 'UAH', '₦': 'NGN', '₵': 'GHS',
  '₡': 'CRC', '₲': 'PYG', 'د.إ': 'AED', '﷼': 'SAR', 'ریال': 'IRR', '৳': 'BDT',
  'E£': 'EGP',
};

const CURRENCY_TOKEN_RE = new RegExp(
  Object.keys(CURRENCY_ASCII_MAP)
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);

export function normalizeThermalText(text: string, capabilities: ThermalPrinterCapabilities = GENERIC_THERMAL_CAPABILITIES): string {
  return normalizeThermalTextByCapabilities(text, capabilities);
}

function normalizeCurrencyToAscii(text: string): string {
  return Object.entries(CURRENCY_ASCII_MAP)
    .sort(([left], [right]) => right.length - left.length)
    .reduce((value, [symbol, fallback]) => value.split(symbol).join(fallback), text);
}

// Resolves the currency symbol into the exact text that will be printed,
// padded to a fixed 3-column slot (leading spaces for shorter symbols/codes).
// symbol). Must run BEFORE rightAlign() computes padding — swapping the
// symbol out afterwards (e.g. '₹' -> 'Rs') changes the string length and
// pushes trailing digits onto the next line.
export function resolveCurrencyPrefix(symbol: string, useUnicode: boolean): string {
  // fa-IR resolves IRR to the textual token "ریال". Generic ESC/POS printers
  // cannot shape that token, so normalize this known currency even when the
  // caller requests Unicode. Preserve the existing useUnicode behavior for
  // every other currency value.
  const normalizedSymbol = symbol === 'ریال' ? 'IRR' : symbol;
  const isAsciiSafe = /^[\x00-\x7F]+$/.test(normalizedSymbol);
  const rawPrefix = (useUnicode || isAsciiSafe)
    ? normalizedSymbol
    : (CURRENCY_ASCII_MAP[normalizedSymbol] || normalizedSymbol.slice(0, 3).toUpperCase() || 'Rs');
  const prefix = rawPrefix.length > 3 ? rawPrefix.slice(0, 3) : rawPrefix;
  return prefix.length >= 3 ? prefix : ' '.repeat(3 - prefix.length) + prefix;
}

// Arabic (incl. Persian) Unicode blocks: Arabic, Arabic Supplement, Arabic
// Extended-A, Arabic Presentation Forms-A/B. These scripts require contextual
// shaping and bidirectional ordering that generic ESC/POS firmware does not
// implement — a printer profile must declare `arabicShaping` before they are
// emitted as UTF-8 bytes.
const ARABIC_SCRIPT_GLOBAL_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const ARABIC_SHAPING_ALLOWED_GLOBAL_RE = /[\u200C\u200D\u200F\u2026]/g;
const ESCPOS_TEXT_CONTROL_RE = /[\x00-\x1F\x7F]/g;

function hasArabicScript(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

/** Precise warning that distinguishes Arabic shaping from generic unsupported chars. */
function makeUnsupportedLineWarning(isStoreName: boolean, text: string): string {
  const label = isStoreName ? 'Store name' : 'Receipt line';
  const why = hasArabicScript(text)
    ? 'it contains Persian/Arabic script and the printer does not declare Arabic shaping support'
    : 'it contains unsupported characters';
  return `${label} was not printed because ${why}: ${text}`;
}

export function appendCashDrawerPulse(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFA])]);
}

/**
 * Build ESC/POS bytes and classify unsupported financial rows for the receipt
 * transport guard. Receipt renderers mark amount-bearing lines with the
 * internal {FINANCIAL} token; it is stripped before bytes are emitted.
 */
export function buildEscPos(lines: string[], _useUnicode: boolean = false, options: { cutMode?: PrinterCutMode; arabicShaping?: boolean; columns?: number; language?: string; capabilities?: ThermalPrinterCapabilities } = {}, warnings?: PrintWarning[]): Buffer {
  const buf: number[] = [];
  const useLegacyUnicode = options.capabilities === undefined && _useUnicode;
  const capabilities = mergeThermalCapabilities(options.capabilities, options.arabicShaping);
  const hasNativeCodePage = capabilities.encoding.codePages.some((codePage) => codePage !== 'ascii');
  let activeCodePage = capabilities.encoding.preferredCodePage;

  const resetAllStyles = () => {
    buf.push(0x1B, 0x45, 0x00);
    buf.push(0x1B, 0x21, 0x00);
    buf.push(0x1B, 0x61, 0x00);
  };

  for (let line of lines) {
    if (line.includes('{INIT}')) {
      buf.push(0x1B, 0x40);
      resetAllStyles();
      if (!useLegacyUnicode && activeCodePage !== 'ascii') {
        buf.push(0x1B, 0x74, escPosCodePageId(activeCodePage));
      }
      continue;
    }

    if (line.includes('{FEED}')) {
      buf.push(0x1B, 0x64, 0x05);
      continue;
    }

    if (line.includes('{CUT}')) {
      buf.push(0x1B, 0x64, 0x05);
      if (options.cutMode === 'partial') {
        buf.push(0x1D, 0x56, 0x42, 0x00);
      } else {
        buf.push(0x1D, 0x56, 0x00);
      }
      continue;
    }

    if (!useLegacyUnicode && !hasNativeCodePage) line = normalizeCurrencyToAscii(line);
    line = normalizeThermalTextByCapabilities(line, capabilities);

    const isStoreName = line.includes('{STORE_NAME}');
    const isFinancial = line.includes('{FINANCIAL}');
    line = line.replace(/\{STORE_NAME\}/g, '');
    let printableLine = line.replace(/\{[A-Z_/]+\}/g, '');
    const lineBold = line.includes('{BOLD}');
    const lineDH = line.includes('{DOUBLE_HEIGHT}');
    const lineDW = line.includes('{DOUBLE_WIDTH}');
    const lineFontB = line.includes('{FONT_B}');
    const center = line.startsWith('{CENTER}') && line.includes('{/CENTER}');
    const textWithoutSupportedCurrency = printableLine.replace(CURRENCY_TOKEN_RE, '');
    const selectedCodePage = selectThermalCodePage(textWithoutSupportedCurrency, capabilities);
    if (/[^\x00-\x7F]/.test(textWithoutSupportedCurrency)) {
      // Allow Arabic/Persian script through only when the printer profile
      // explicitly declares Arabic shaping support AND the line contains no
      // other non-ASCII script. Otherwise skip it — never emit unshaped text.
      const arabicOnly = capabilities.shaping.arabic
        && hasArabicScript(printableLine)
        && !/[^\x00-\x7F]/.test(
          textWithoutSupportedCurrency
            .replace(ARABIC_SCRIPT_GLOBAL_RE, '')
            .replace(ARABIC_SHAPING_ALLOWED_GLOBAL_RE, '')
        );
      const codePageRepresentable = selectedCodePage !== null
        && capabilities.representability.scripts.includes('latin');
      if (!arabicOnly && !codePageRepresentable) {
        if (warnings) {
          const text = printableLine.trim();
          warnings.push({
            field: isFinancial ? 'financial row' : isStoreName ? 'store name' : 'receipt line',
            text,
            message: makeUnsupportedLineWarning(isStoreName, text),
            kind: isFinancial ? 'financial' : 'line',
          });
        }
        continue;
      }
      line = line.replace(ESCPOS_TEXT_CONTROL_RE, '');
      printableLine = line.replace(/\{[A-Z_/]+\}/g, '');
      if (Number.isInteger(options.columns) && (options.columns as number) > 0) {
        const maxCols = lineDW ? Math.floor((options.columns as number) / 2) : (options.columns as number);
        line = truncate(printableLine, Math.max(1, maxCols));
      }
    }

    // ESC/POS mode byte bit 0 selects the character font: 0 = Font A (12x24,
    // the default), 1 = Font B (9x17, condensed). No token means Font A.

    line = line.replace(/\{FINANCIAL\}/g, '');
    line = line.replace(/\{CENTER\}/g, '').replace(/\{\/CENTER\}/g, '');
    line = line.replace(/\{BOLD\}/g, '').replace(/\{\/BOLD\}/g, '');
    line = line.replace(/\{DOUBLE_HEIGHT\}/g, '').replace(/\{\/DOUBLE_HEIGHT\}/g, '');
    line = line.replace(/\{DOUBLE_WIDTH\}/g, '').replace(/\{\/DOUBLE_WIDTH\}/g, '');
    line = line.replace(/\{FONT_B\}/g, '').replace(/\{\/FONT_B\}/g, '');

    buf.push(0x1B, 0x61, center ? 0x01 : 0x00);

    let mode = 0;
    if (lineDH) mode |= 0x10;
    if (lineDW) mode |= 0x20;
    if (lineBold) mode |= 0x08;
    if (lineFontB) mode |= 0x01;
    buf.push(0x1B, 0x21, mode);
    if (selectedCodePage && selectedCodePage !== activeCodePage && !useLegacyUnicode) {
      buf.push(0x1B, 0x74, escPosCodePageId(selectedCodePage));
      activeCodePage = selectedCodePage;
    }

    if (lineBold) {
      buf.push(0x1B, 0x45, 0x01);
    }

    const encodedText = !useLegacyUnicode && selectedCodePage
      ? CodepageEncoder.encode(line, selectedCodePage)
      : Buffer.from(line, 'utf8');
    buf.push(...encodedText);
    buf.push(0x0A);
  }

  return Buffer.from(buf);
}

/** Convert the command subset emitted by buildEscPos() into a paperless text preview. */
export function escPosToText(data: Buffer | Uint8Array): string {
  const bytes = Buffer.from(data);
  const text: string[] = [];
  const lineBytes: number[] = [];
  let activeCodePage: ThermalCodePage | 'utf8' = 'utf8';

  const flushLine = (): void => {
    if (lineBytes.length === 0) return;
    text.push(decodeThermalPreviewBytes(lineBytes, activeCodePage));
    lineBytes.length = 0;
  };

  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i];
    if (byte === 0x1B) {
      const command = bytes[i + 1];
      if (command === 0x40) {
        flushLine();
        activeCodePage = 'utf8';
        i += 2;
      } else if (command === 0x74) {
        flushLine();
        activeCodePage = THERMAL_CODE_PAGE_BY_ID[bytes[i + 2]] ?? 'utf8';
        i += 3;
      } else if (command === 0x21 || command === 0x45 || command === 0x61) {
        i += 3;
      } else if (command === 0x64) {
        flushLine();
        const feedLines = bytes[i + 2] || 0;
        for (let line = 0; line < feedLines; line++) text.push('\n');
        i += 3;
      } else {
        i += Math.min(2, bytes.length - i);
      }
      continue;
    }
    if (byte === 0x1D && bytes[i + 1] === 0x56) {
      flushLine();
      const mode = bytes[i + 2];
      i += mode === 0x41 || mode === 0x42 ? 4 : 3;
      continue;
    }
    if (byte === 0x0A) {
      flushLine();
      text.push('\n');
      i += 1;
      continue;
    }
    if (byte === 0x0D) {
      i += 1;
      continue;
    }
    lineBytes.push(byte);
    i += 1;
  }

  flushLine();
  return text.join('').replace(/\n+$/, '');
}

const THERMAL_CODE_PAGE_HIGH_HALVES: Record<Exclude<ThermalCodePage, 'ascii'>, string> = {
  cp437: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
  cp850: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ",
  cp858: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ",
  windows1252: "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜š›œžŸÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ",
};
const THERMAL_CODE_PAGE_BY_ID: Record<number, ThermalCodePage> = {
  0: 'cp437',
  2: 'cp850',
  16: 'windows1252',
  19: 'cp858',
};

function decodeThermalPreviewBytes(bytes: number[], codePage: ThermalCodePage | 'utf8'): string {
  if (codePage === 'utf8') return Buffer.from(bytes).toString('utf8');
  if (codePage === 'ascii') return bytes.map((byte) => String.fromCharCode(byte)).join('');
  const highHalf = THERMAL_CODE_PAGE_HIGH_HALVES[codePage];
  return bytes.map((byte) => byte < 0x80 ? String.fromCharCode(byte) : highHalf[byte - 0x80] ?? '\uFFFD').join('');
}

export async function printViaNetwork(ip: string, port: number, data: Buffer, signal?: AbortSignal): Promise<DispatchResult> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let settled = false;
    const onAbort = (): void => {
      client.destroy();
      finish({ ok: false, detail: 'Print cancelled during shutdown' });
    };
    const finish = (result: DispatchResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    client.connect(port, ip, () => {
      client.write(data, () => {
        client.end();
        finish({ ok: true });
      });
    });

    client.on('error', (err) => {
      console.error(`[Printer] Network error: ${err.message}`);
      client.destroy();
      finish({ ok: false, detail: `Network error: ${err.message}` });
    });

    client.setTimeout(5000, () => {
      client.destroy();
      finish({ ok: false, detail: `Timed out connecting to ${ip}:${port}` });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function printViaUSB(data: Buffer, printerName?: string, signal?: AbortSignal): Promise<DispatchResult> {
  console.log('[Printer] printViaUSB called, platform:', process.platform, 'printer:', printerName);

  if (process.platform === 'darwin' || process.platform === 'linux') {
    return await printViaCups(data, printerName, signal);
  }

  if (process.platform === 'win32') {
    return await printViaUSBWindows(data, printerName, signal);
  }

  console.warn('[Printer] Unsupported platform:', process.platform);
  return { ok: false, detail: `Unsupported platform: ${process.platform}` };
}

// `lp` exits 0 as soon as CUPS accepts the job into the queue, so a queue that
// is disabled — which is what CUPS does once the backend fails, e.g. after the
// printer is unplugged — would otherwise be reported to the cashier as a
// successful print. Mirrors the GetPrinter pre-flight on the Windows path.
//
// Returns a human-readable problem, or null to proceed. Anything unexpected
// (no CUPS, unknown queue) returns null so `lp` still gets its chance: this
// check only ever turns a silent failure into a visible one.
async function describeCupsQueueProblem(printerName?: string, signal?: AbortSignal): Promise<string | null> {
  if (!printerName) return null;

  // LC_ALL=C — the state words below are matched in English, and lpstat is localised.
  const opts = { encoding: 'utf8' as const, timeout: 5000, signal, env: { ...process.env, LC_ALL: 'C' } };

  try {
    const { stdout } = await execFileAsync('lpstat', ['-p', printerName], opts);
    if (/\bdisabled\b/i.test(stdout)) {
      const since = stdout.match(/disabled since [^\n]*/i);
      return since ? since[0].trim().replace(/\s+-\s*$/, '') : 'print queue is disabled';
    }
  } catch {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('lpstat', ['-a', printerName], opts);
    if (/not accepting/i.test(stdout)) return 'print queue is not accepting jobs';
  } catch {
    return null;
  }

  return null;
}

async function printViaCups(data: Buffer, printerName?: string, signal?: AbortSignal): Promise<DispatchResult> {
  const label = printerName || 'default';

  const problem = await describeCupsQueueProblem(printerName, signal);
  if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
  if (problem) {
    console.error(`[Printer] CUPS print aborted for "${label}": ${problem}`);
    return { ok: false, detail: problem };
  }

  const tmpFile = path.join(os.tmpdir(), `flo_print_${process.pid}_${Date.now()}.bin`);

  try {
    fs.writeFileSync(tmpFile, data);

    const args = printerName
      ? ['-d', printerName, '-o', 'raw', tmpFile]
      : ['-o', 'raw', tmpFile];
    const { stdout } = await execFileAsync('lp', args, { encoding: 'utf8', timeout: 20000, signal });

    console.log(`[Printer] CUPS print queued for "${label}" (${stdout.trim()})`);
    return { ok: true };
  } catch (err: any) {
    const detail = String(err.stderr || err.message || '').trim();
    console.error(`[Printer] CUPS print failed for "${label}": ${detail}`);
    return { ok: false, detail: detail || `CUPS print failed for "${label}"` };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Raw ESC/POS on Windows has to bypass the print driver: node-thermal-printer's
// `printer:<name>` interface and PowerShell's `Start-Process -Verb PrintTo` both
// hand the document to a driver that must already understand it, and a thermal
// printer's driver does not. Writing to the spooler with datatype RAW is the
// documented way to get bytes through untouched.
//
// Kept as C# compiled at run time by Add-Type rather than a native addon so the
// app stays free of per-Electron-ABI prebuilds. Uses the *W entry points so
// printer names outside ASCII survive marshalling.
//
// NOTE: no backslash escapes, backticks, or `${` may appear in this source — it
// is embedded in a TS template literal and then in a single-quoted PowerShell
// here-string, and both would rewrite it.
const WINSPOOL_HELPER_SOURCE = `
using System;
using System.Runtime.InteropServices;

public static class FloRawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private class DOCINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PRINTER_INFO_2 {
        public IntPtr pServerName;
        public IntPtr pPrinterName;
        public IntPtr pShareName;
        public IntPtr pPortName;
        public IntPtr pDriverName;
        public IntPtr pComment;
        public IntPtr pLocation;
        public IntPtr pDevMode;
        public IntPtr pSepFile;
        public IntPtr pPrintProcessor;
        public IntPtr pDatatype;
        public IntPtr pParameters;
        public IntPtr pSecurityDescriptor;
        public uint Attributes;
        public uint Priority;
        public uint DefaultPriority;
        public uint StartTime;
        public uint UntilTime;
        public uint Status;
        public uint cJobs;
        public uint AveragePPM;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "GetPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool GetPrinter(IntPtr hPrinter, int Level, IntPtr pPrinter, uint cbBuf, out uint pcbNeeded);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint StartDocPrinter(IntPtr hPrinter, int Level, [In] DOCINFO pDocInfo);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    private const uint PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x00000400;

    private static string DescribeBlockingState(uint status, uint attributes) {
        if ((attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) != 0) return "printer is set to 'Use Printer Offline' in Windows";
        if ((status & 0x00000080) != 0) return "printer is offline";
        if ((status & 0x00001000) != 0) return "printer is not available";
        if ((status & 0x00000010) != 0) return "printer is out of paper";
        if ((status & 0x00000008) != 0) return "printer has a paper jam";
        if ((status & 0x00400000) != 0) return "printer cover is open";
        if ((status & 0x00100000) != 0) return "printer needs attention";
        if ((status & 0x00000002) != 0) return "printer reported an error";
        return null;
    }

    // OpenPrinter succeeds against the queue even when the device is unplugged,
    // so without this the job would silently spool and we would report success.
    private static void EnsureReady(IntPtr hPrinter) {
        uint needed = 0;
        GetPrinter(hPrinter, 2, IntPtr.Zero, 0, out needed);
        if (needed == 0) return;

        IntPtr buf = Marshal.AllocHGlobal((int)needed);
        try {
            uint unused = 0;
            if (!GetPrinter(hPrinter, 2, buf, needed, out unused)) return;
            PRINTER_INFO_2 info = (PRINTER_INFO_2)Marshal.PtrToStructure(buf, typeof(PRINTER_INFO_2));
            string problem = DescribeBlockingState(info.Status, info.Attributes);
            if (problem != null) throw new Exception(problem);
        } finally {
            Marshal.FreeHGlobal(buf);
        }
    }

    public static uint SendRaw(string printerName, byte[] bytes) {
        IntPtr hPrinter = IntPtr.Zero;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("cannot open printer '" + printerName + "' (Win32 error " + Marshal.GetLastWin32Error() + ")");

        try {
            EnsureReady(hPrinter);

            DOCINFO docInfo = new DOCINFO();
            docInfo.pDocName = "FloCafe Receipt";
            docInfo.pDataType = "RAW";

            uint jobId = StartDocPrinter(hPrinter, 1, docInfo);
            if (jobId == 0)
                throw new Exception("StartDocPrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")");

            try {
                if (!StartPagePrinter(hPrinter))
                    throw new Exception("StartPagePrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")");

                int written = 0;
                if (!WritePrinter(hPrinter, bytes, bytes.Length, out written))
                    throw new Exception("WritePrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
                if (written != bytes.Length)
                    throw new Exception("WritePrinter accepted " + written + " of " + bytes.Length + " bytes");

                EndPagePrinter(hPrinter);
            } finally {
                EndDocPrinter(hPrinter);
            }

            return jobId;
        } finally {
            ClosePrinter(hPrinter);
        }
    }
}
`;

// Delivered as -EncodedCommand rather than a .ps1: ExecutionPolicy governs script
// files only, and a GPO-set policy silently overrides -ExecutionPolicy Bypass, so
// a script file would fail on exactly the managed machines a POS runs on.
// The printer name and payload path travel in the child environment, so neither
// is ever parsed as script text.
const WINSPOOL_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $name = $env:FLO_PRINTER_NAME
  $file = $env:FLO_PRINT_FILE
  if ([string]::IsNullOrEmpty($name)) { throw 'no printer name supplied' }
  if ([string]::IsNullOrEmpty($file)) { throw 'no payload file supplied' }

  # Best-effort metadata for Tier-2 diagnostics. This is never included in the
  # anonymous telemetry payload and must not prevent the raw print attempt.
  try {
    $printerInfo = Get-CimInstance -ClassName Win32_Printer -Property Name,PrinterStatus,DriverName |
      Where-Object { $_.Name -eq $name } |
      Select-Object -First 1 Name,PrinterStatus,DriverName
    if ($printerInfo) {
      Write-Output ('FLO_PRINTER_INFO=' + ($printerInfo | ConvertTo-Json -Compress))
    }
  } catch { }

  Add-Type -TypeDefinition @'
${WINSPOOL_HELPER_SOURCE}
'@

  $bytes = [System.IO.File]::ReadAllBytes($file)
  $jobId = [FloRawPrinter]::SendRaw($name, $bytes)
  Write-Output ('FLO_JOB_ID=' + $jobId)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

const execFileAsync = promisify(execFile);

function parseWindowsPrintOutput(output: unknown): Pick<DispatchResult, 'jobId' | 'driverName' | 'printerStatus'> {
  const outputLines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jobLine = outputLines.find((line) => line.startsWith('FLO_JOB_ID='));
  const infoLine = outputLines.find((line) => line.startsWith('FLO_PRINTER_INFO='));
  const parsed: Pick<DispatchResult, 'jobId' | 'driverName' | 'printerStatus'> = {};

  if (jobLine) {
    const jobId = Number(jobLine.slice('FLO_JOB_ID='.length));
    if (Number.isSafeInteger(jobId) && jobId > 0) parsed.jobId = jobId;
  }
  if (infoLine) {
    try {
      const info = JSON.parse(infoLine.slice('FLO_PRINTER_INFO='.length)) as { DriverName?: unknown; PrinterStatus?: unknown };
      if (typeof info.DriverName === 'string' && info.DriverName.trim()) parsed.driverName = info.DriverName.trim();
      if (typeof info.PrinterStatus === 'number') parsed.printerStatus = info.PrinterStatus;
    } catch { /* diagnostics metadata is best-effort */ }
  }
  return parsed;
}

async function printViaUSBWindows(data: Buffer, printerName?: string, signal?: AbortSignal): Promise<DispatchResult> {
  if (!printerName) {
    const detail = 'No Windows printer configured; refusing to guess a target';
    console.error(`[Printer] ${detail}`);
    return { ok: false, detail };
  }

  // %TEMP%, not C:\Windows\Temp — the latter is not writable by a standard user.
  const tmpFile = path.join(os.tmpdir(), `flo_print_${process.pid}_${Date.now()}.bin`);

  try {
    fs.writeFileSync(tmpFile, data);

    const encoded = Buffer.from(WINSPOOL_HELPER_SCRIPT, 'utf16le').toString('base64');

    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        encoding: 'utf8',
        timeout: 20000,
        signal,
        windowsHide: true,
        env: { ...process.env, FLO_PRINTER_NAME: printerName, FLO_PRINT_FILE: tmpFile },
      },
    );

    const metadata = parseWindowsPrintOutput(stdout);
    console.log(`[Printer] Windows raw print accepted for "${printerName}" (${String(stdout).trim()})`);
    return { ok: true, ...metadata };
  } catch (err: any) {
    const detail = String(err.stderr || err.message || '').trim();
    console.error(`[Printer] Windows raw print failed for "${printerName}": ${detail}`);
    return {
      ok: false,
      detail: detail || `Windows raw print failed for "${printerName}"`,
      failureClass: classifyPrintFailure(detail),
      platformErrorCode: extractPlatformErrorCode(detail),
      ...parseWindowsPrintOutput(err.stdout),
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

export function getPrinterStatus(): { connected: boolean; printer: any } {
  const printer = getPrinterConfig();
  return { connected: !!printer, printer };
}
