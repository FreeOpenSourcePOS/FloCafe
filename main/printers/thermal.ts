import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, exec, execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { getDatabase } from '../db';
import { PrinterCutMode, resolvePrinterProfile, matchSupportedPrinterProfile, SupportedPrinterProfile } from './profiles';
import { getCountryByCode } from '../countries';
import { resolveTaxComponents } from '../services/tax-components';

const isMasBuild =
  process.env.MAS_BUILD === '1' ||
  (process as NodeJS.Process & { mas?: boolean }).mas === true;

let defaultPrinter: any = null;

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
  if (s.includes('58')) return '58mm';
  return '80mm';
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

export async function detectConnectedPrinters(): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  if (isMasBuild) {
    return printers;
  }

  if (process.platform === 'darwin') {
    return await detectMacOSPrinters();
  }

  if (process.platform === 'win32') {
    return detectWindowsPrinters();
  }

  if (process.platform === 'linux') {
    return detectLinuxPrinters();
  }

  return printers;
}

async function detectMacOSPrinters(): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    const lpStatOutput = execSync('lpstat -v 2>/dev/null', { encoding: 'utf8' });
    const lines = lpStatOutput.split('\n');

    const printerNames = new Set<string>();

    for (const line of lines) {
      const match = line.match(/device for (\S+):\s*(.+)/);
      if (match) {
        const name = match[1];
        const uri = match[2].trim();

        if (!printerNames.has(name)) {
          printerNames.add(name);

          const makeModel = await getMacOSPrinterDetails(name);
          const isDefault = await isMacOSDefaultPrinter(name);
          const status = await getMacOSPrinterStatus(name);
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

async function getMacOSPrinterStatus(name: string): Promise<'idle' | 'printing' | 'offline'> {
  try {
    const out = execFileSync('lpstat', ['-p', name], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).toLowerCase();
    if (out.includes('disabled')) return 'offline';
    if (out.includes('printing') || out.includes('now printing')) return 'printing';
    return 'idle';
  } catch {
    return 'offline';
  }
}

async function getMacOSPrinterDetails(name: string): Promise<{ make: string; model: string }> {
  let make = 'Unknown';
  let model = 'Thermal Printer';

  try {
    const info = execFileSync('lpoptions', ['-p', name, '-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

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

async function isMacOSDefaultPrinter(name: string): Promise<boolean> {
  try {
    const defaultPrinter = execFileSync('lpstat', ['-d'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return defaultPrinter.includes(name);
  } catch {
    return false;
  }
}

function detectWindowsPrinters(): PrinterInfo[] {
  const printers: PrinterInfo[] = [];

  try {
    const output = execSync('wmic printer get Name,Default,Status,DriverName 2>/dev/null', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const lines = output.split('\n').slice(1);

    for (const line of lines) {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 2 && parts[0]) {
        const name = parts[0].trim();
        const isDefault = parts[1]?.toLowerCase() === 'true';
        const status = parts[2]?.toLowerCase() || 'unknown';
        const driver = parts[3] || '';

        const makeModel = detectWindowsMakeModel(name, driver);

        printers.push(annotateProfile({
          name,
          make: makeModel.make,
          model: makeModel.model,
          connectionType: 'usb',
          deviceUri: name,
          driver,
          status: status === 'ok' || status === 'idle' ? 'idle' : 'offline',
          isDefault,
          paperWidth: guessPaperWidth(name, makeModel.model),
        }));
      }
    }
  } catch (err) {
    console.log('[Printer] Could not detect Windows printers via wmic:', err);
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

function getMakeModelFromLpstat(): Map<string, { make: string; model: string }> {
  const result = new Map<string, { make: string; model: string }>();
  try {
    const output = execSync('lpstat -l -p 2>/dev/null', { encoding: 'utf8' });
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

function detectLinuxPrinters(): PrinterInfo[] {
  const printers: PrinterInfo[] = [];

  try {
    // Layer 1: Get make/model from CUPS Device URI (most reliable)
    const cupsMakeModel = getMakeModelFromLpstat();

    // Layer 2: Get USB vendor IDs from sysfs (works without CUPS)
    const usbVendors = getUsbPrinterVendorIds();

    // Get printer list from CUPS
    const output = execSync('lpstat -v 2>/dev/null', { encoding: 'utf8' });
    const lines = output.split('\n');

    for (const line of lines) {
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
    defaultPrinter = db.prepare('SELECT * FROM printers WHERE is_default = 1').get();
    if (defaultPrinter) {
      console.log(`[Printer] Default printer: ${defaultPrinter.name} (${defaultPrinter.connection_type})`);
    } else {
      console.log('[Printer] No default printer configured');
    }
  } catch (error) {
    console.log('[Printer] Printer initialization skipped (database not ready)');
  }
}

export async function printReceipt(order: any, bill: any, business?: any, template?: string, useUnicode: boolean = false, isReprint: boolean = false): Promise<boolean> {
  try {
    console.log('[Printer] printReceipt called, template:', template, 'useUnicode:', useUnicode, 'isReprint:', isReprint);
    const printer = getPrinterConfig();
    if (!printer) {
      console.log('[Printer] No printer configured');
      return false;
    }
    console.log('[Printer] Using printer:', printer.name, printer.connection_type);

    const profile = resolvePrinterProfile(printer);
    const cols = getColumnsForPrinter(printer, profile);

    let data: Buffer;
    try {
      data = formatReceipt(order, bill, business, template, cols, useUnicode, isReprint, profile.cutMode);
      console.log('[Printer] Receipt data length:', data.length, 'bytes');
      console.log('[Printer] First 100 bytes:', Array.from(data.slice(0, 100)).map(b => b.toString(16)).join(' '));
    } catch (err) {
      console.error('[Printer] formatReceipt failed:', err);
      throw err;
    }

    return await dispatchPrint(printer, data);
  } catch (error: any) {
    console.error('[Printer] Print error:', error);
    return false;
  }
}

export async function printKOT(order: any, items: any[], stationName: string, useUnicode: boolean = false, targetPrinter?: any): Promise<boolean> {
  try {
    console.log('[Printer] printKOT called, items count:', items?.length || 0, 'useUnicode:', useUnicode, 'station:', stationName);
    const printer = targetPrinter || getPrinterConfig();
    if (!printer) {
      console.log('[Printer] No printer configured');
      return false;
    }
    console.log('[Printer] Using printer:', printer.name, printer.connection_type);

    const profile = resolvePrinterProfile(printer);
    const cols = getColumnsForPrinter(printer, profile);

    const db = getDatabase();
    const biz = db.prepare('SELECT * FROM settings LIMIT 1').get() as any;
    const locale = biz?.country ? getCountryByCode(biz.country)?.locale ?? 'en-US' : 'en-US';
    const tzOptions = biz?.timezone ? { timeZone: biz.timezone } : undefined;

    const data = formatKOT(order, items, stationName, cols, useUnicode, profile.cutMode, locale, tzOptions);
    console.log('[Printer] KOT data length:', data.length, 'bytes');
    return await dispatchPrint(printer, data);
  } catch (error: any) {
    console.error('[Printer] KOT print error:', error);
    return false;
  }
}

function getColumnsForPrinter(printer: any, profile: SupportedPrinterProfile): number {
  const paperWidth = printer.paper_width || profile.defaultPaperWidth || '80mm';
  if (paperWidth === '58mm') return 42;
  return profile.fontAColumns || 48;
}

async function dispatchPrint(printer: any, data: Buffer): Promise<boolean> {
  switch (printer.connection_type) {
    case 'network':
      return await printViaNetwork(printer.ip_address, printer.port || 9100, data);
    case 'usb':
      if (isMasBuild) {
        console.log('[Printer] USB printers are not supported in the App Store build. Use a network printer.');
        return false;
      }
      return await printViaUSB(data, printer.name);
    case 'webusb':
      console.log('[Printer] WebUSB printer — not supported in Electron');
      return false;
    default:
      console.log(`[Printer] Unsupported connection type: ${printer.connection_type}`);
      return false;
  }
}

function getPrinterConfig(): any {
  if (defaultPrinter) return defaultPrinter;
  const db = getDatabase();
  return db.prepare('SELECT * FROM printers WHERE is_default = 1').get();
}

export function formatReceipt(order: any, bill: any, business?: any, template?: string, cols: number = 48, useUnicode: boolean = false, isReprint: boolean = false, cutMode: PrinterCutMode = 'full'): Buffer {
  console.log('[Printer] formatReceipt - template:', template);
  console.log('[Printer] formatReceipt - order:', order?.order_number, 'bill:', bill?.bill_number);
  console.log('[Printer] formatReceipt - items count:', order?.items?.length || 0, 'cols:', cols);

  const tpl = normalizeReceiptTemplate(template);
  const biz = business || { name: 'Store', address: '', phone: '', gstin: '' };

  try {
    switch (tpl) {
      case 'classic':
        return formatClassicReceipt(order, bill, biz, cols, useUnicode, isReprint, cutMode);
      case 'detailed':
        return formatDetailedReceipt(order, bill, biz, cols, useUnicode, isReprint, cutMode);
      default:
        return formatCompactReceipt(order, bill, biz, cols, useUnicode, isReprint, cutMode);
    }
  } catch (err) {
    console.error('[Printer] formatReceipt error:', err);
    throw err;
  }
}

function normalizeReceiptTemplate(template?: string): 'classic' | 'compact' | 'detailed' {
  const normalized = String(template || 'classic').toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.includes('compact') || normalized.includes('minimal')) return 'compact';
  if (normalized.includes('detailed') || normalized.includes('gst') || normalized.includes('tax')) return 'detailed';
  return 'classic';
}

function formatCompactReceipt(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false, isReprint: boolean = false, cutMode: PrinterCutMode = 'full'): Buffer {
  const lines: string[] = [];
  const date = new Date(order.created_at);

  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);

  const itemNameLen = cols === 42 ? 28 : 34;
  const amtLen = 10;
  const prefix = resolveCurrencyPrefix(biz.currency_symbol || '₹', useUnicode);
  const locale = getCountryByCode(biz.country)?.locale ?? 'en-US';
  const taxIdLabel = getCountryByCode(biz.country)?.taxIdLabel || 'Tax ID';
  const hasTax = Number(bill.tax_amount) !== 0
    || resolveTaxComponents({ ...bill, items: order.items }).some((component) => component.amount !== 0);

  const tzOptions = biz.timezone ? { timeZone: biz.timezone } : undefined;

  lines.push('{INIT}');
  if (isReprint) lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** REPRINT **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  lines.push('{CENTER}{BOLD}' + (biz.name || 'Store') + '{/BOLD}{/CENTER}');
  lines.push(bar);
  lines.push('Bill #: ' + (bill.bill_number || order.order_number));
  lines.push('Date: ' + date.toLocaleDateString(locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(locale + '-u-nu-latn', tzOptions));
  lines.push(dash);
  lines.push(itemHeader(itemNameLen, amtLen));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      lines.push(itemRow(item, itemNameLen, amtLen, prefix, locale));

      const addons = parseAddons(item.addons);
      for (const addon of addons) {
        lines.push(addonRow(addon, itemNameLen, amtLen, cols, prefix, locale));
      }
      if (item.special_instructions) {
        lines.push('  Note: ' + truncate(item.special_instructions, cols - 8));
      }
    }
  }

  lines.push(dash);
  lines.push('Subtotal' + rightAlign(formatCurrency(bill.subtotal, prefix, locale), cols - 8));
  if (bill.discount_amount > 0) {
    lines.push('Discount' + rightAlign('-' + formatCurrency(bill.discount_amount, prefix, locale), cols - 8));
  }
  if (Number(bill.tax_amount) !== 0) {
    lines.push('Tax' + rightAlign(formatCurrency(bill.tax_amount, prefix, locale), cols - 3));
  }
  lines.push('{BOLD}TOTAL' + rightAlign(formatCurrency(bill.total, prefix, locale), cols - 5) + '{/BOLD}');

  if (bill.payment_details) {
    lines.push(dash);
    try {
      const payments = typeof bill.payment_details === 'string' ? JSON.parse(bill.payment_details) : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            const methodLabel = truncate(String(payment.method), cols - 12);
            lines.push(methodLabel + rightAlign(formatCurrency(payment.amount, prefix, locale), cols - methodLabel.length));
          }
        }
      }
    } catch (err: any) {
      console.warn('[Printer] Failed to parse payment details JSON:', err.message);
    }
  }

  lines.push(bar);
  if (biz.address) lines.push(biz.address);
  if (biz.phone) lines.push('Ph: ' + biz.phone);
  if (hasTax && biz.gstin) lines.push(taxIdLabel + ': ' + biz.gstin);
  lines.push('{CENTER}Thank you!{/CENTER}');
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode, { cutMode });
}

function formatClassicReceipt(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false, isReprint: boolean = false, cutMode: PrinterCutMode = 'full'): Buffer {
  const lines: string[] = [];
  const date = new Date(order.created_at);

  const dash = '-'.repeat(cols);

  const itemNameLen = cols === 42 ? 28 : 34;
  const amtLen = 10;
  const prefix = resolveCurrencyPrefix(biz.currency_symbol || '₹', useUnicode);
  const locale = getCountryByCode(biz.country)?.locale ?? 'en-US';

  const tzOptions = biz.timezone ? { timeZone: biz.timezone } : undefined;

  lines.push('{INIT}');
  if (isReprint) lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** REPRINT **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');

  // Header: store name (Font A, big + bold), then customer name (Font B) and
  // mobile number, each only if the bill actually has that data.
  lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}' + (biz.name || 'Store') + '{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  if (biz.customer_name) lines.push('{CENTER}{FONT_B}' + biz.customer_name + '{/FONT_B}{/CENTER}');
  if (biz.customer_phone) lines.push('{CENTER}' + biz.customer_phone + '{/CENTER}');

  lines.push(dash);
  lines.push('{CENTER}Invoice #: ' + (bill.bill_number || order.order_number) + '{/CENTER}');
  lines.push('{CENTER}' + date.toLocaleDateString(locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(locale + '-u-nu-latn', tzOptions) + '{/CENTER}');
  lines.push(dash);

  lines.push(itemHeader(itemNameLen, amtLen));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      lines.push(itemRow(item, itemNameLen, amtLen, prefix, locale));

      const addons = parseAddons(item.addons);
      for (const addon of addons) {
        lines.push(addonRow(addon, itemNameLen, amtLen, cols, prefix, locale));
      }
      if (item.special_instructions) {
        lines.push('  Note: ' + truncate(item.special_instructions, cols - 8));
      }
    }
  }

  lines.push(dash);

  // Discount / redeemed points sit above the subtotal, each only if present.
  if (bill.discount_amount > 0) {
    lines.push('Discount' + rightAlign('-' + formatCurrency(bill.discount_amount, prefix, locale), cols - 8));
  }
  if (biz.points_redeemed > 0) {
    const label = 'Points Redeemed';
    lines.push(label + rightAlign('-' + biz.points_redeemed + ' pts', cols - label.length));
  }

  lines.push('Subtotal' + rightAlign(formatCurrency(bill.subtotal, prefix, locale), cols - 8));
  if (Number(bill.tax_amount) !== 0) {
    lines.push('Tax' + rightAlign(formatCurrency(bill.tax_amount, prefix, locale), cols - 3));
  }
  lines.push('{BOLD}TOTAL' + rightAlign(formatCurrency(bill.total, prefix, locale), cols - 5) + '{/BOLD}');

  if (bill.payment_details) {
    try {
      const payments = typeof bill.payment_details === 'string' ? JSON.parse(bill.payment_details) : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            const methodLabel = truncate(String(payment.method), cols - 12);
            lines.push(methodLabel + rightAlign(formatCurrency(payment.amount, prefix, locale), cols - methodLabel.length));
          }
        }
      }
    } catch (err: any) {
      console.warn('[Printer] Failed to parse payment details JSON:', err.message);
    }
  }

  // Earned points this bill + running balance, each only if it exists.
  const hasEarned = biz.points_earned > 0;
  const hasBalance = biz.points_balance !== null && biz.points_balance !== undefined;
  if (hasEarned || hasBalance) {
    lines.push(dash);
    if (hasEarned) lines.push('Points Earned' + rightAlign(String(biz.points_earned), cols - 13));
    if (hasBalance) lines.push('Points Balance' + rightAlign(String(biz.points_balance), cols - 14));
  }

  // Footer: store contact details, only the ones actually configured.
  const footerLines: string[] = [];
  if (biz.address) footerLines.push(biz.address);
  if (biz.phone) footerLines.push('Ph: ' + biz.phone);
  if (biz.instagram_handle) footerLines.push(biz.instagram_handle);
  if (footerLines.length > 0) {
    lines.push(dash);
    for (const footerLine of footerLines) lines.push('{CENTER}' + footerLine + '{/CENTER}');
  }

  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode, { cutMode });
}

function formatDetailedReceipt(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false, isReprint: boolean = false, cutMode: PrinterCutMode = 'full'): Buffer {
  const lines: string[] = [];
  const date = new Date(order.created_at);

  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);

  const itemNameLen = cols === 42 ? 28 : 34;
  const prefix = resolveCurrencyPrefix(biz.currency_symbol || '₹', useUnicode);
  const locale = getCountryByCode(biz.country)?.locale ?? 'en-US';
  const taxIdLabel = getCountryByCode(biz.country)?.taxIdLabel || 'Tax ID';
  const taxComponents = resolveTaxComponents({ ...bill, items: order.items });
  const hasTax = Number(bill.tax_amount) !== 0
    || taxComponents.some((component) => component.amount !== 0);

  const tzOptions = biz.timezone ? { timeZone: biz.timezone } : undefined;

  lines.push('{INIT}');
  if (isReprint) lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** REPRINT **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  lines.push('{CENTER}{BOLD}' + (biz.name || 'Store').toUpperCase() + '{/BOLD}{/CENTER}');
  lines.push(bar);
  lines.push(`{CENTER}${hasTax ? 'TAX INVOICE' : 'INVOICE'}{/CENTER}`);
  lines.push(bar);
  lines.push('Invoice #: ' + (bill.bill_number || order.order_number));
  lines.push('Date: ' + date.toLocaleDateString(locale + '-u-nu-latn', tzOptions));
  lines.push('Time: ' + date.toLocaleTimeString(locale + '-u-nu-latn', tzOptions));
  lines.push(dash);
  lines.push(itemHeader(itemNameLen, 10));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      lines.push(itemRow(item, itemNameLen, 10, prefix, locale));

      const addons = parseAddons(item.addons);
      for (const addon of addons) {
        lines.push(addonRow(addon, itemNameLen, 10, cols, prefix, locale));
      }
      if (item.special_instructions) {
        lines.push('  Note: ' + truncate(item.special_instructions, cols - 8));
      }
    }
  }

  lines.push(dash);
  lines.push('Subtotal' + rightAlign(formatCurrency(bill.subtotal, prefix, locale), cols - 8));
  if (bill.discount_amount > 0) {
    lines.push('Discount' + rightAlign('-' + formatCurrency(bill.discount_amount, prefix, locale), cols - 8));
  }

  if (taxComponents.length > 0) {
    for (const tax of taxComponents) {
      if (tax.amount === 0) continue;
      const rawLabel = tax.rate === null ? tax.title : `${tax.title} @${tax.rate}%`;
      const label = truncate(rawLabel, cols - 12);
      lines.push(label + rightAlign(formatCurrency(tax.amount, prefix, locale), cols - label.length));
    }
  } else if (bill.tax_amount) {
    lines.push('Tax' + rightAlign(formatCurrency(bill.tax_amount, prefix, locale), cols - 3));
  }

  lines.push(bar);
  lines.push('{BOLD}GRAND TOTAL' + rightAlign(formatCurrency(bill.total, prefix, locale), cols - 12) + '{/BOLD}');

  if (bill.payment_details) {
    lines.push(dash);
    try {
      const payments = typeof bill.payment_details === 'string' ? JSON.parse(bill.payment_details) : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            const methodLabel = truncate(String(payment.method), cols - 12);
            lines.push(methodLabel + rightAlign(formatCurrency(payment.amount, prefix, locale), cols - methodLabel.length));
          }
        }
      }
    } catch (err: any) {
      console.warn('[Printer] Failed to parse payment details JSON:', err.message);
    }
  }

  lines.push(bar);
  if (biz.address) lines.push('Address: ' + biz.address);
  if (biz.phone) lines.push('Phone: ' + biz.phone);
  if (hasTax && biz.gstin) lines.push(taxIdLabel + ': ' + biz.gstin);
  lines.push('{CENTER}Thank you for your business!{/CENTER}');
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode, { cutMode });
}

// Item row layout: [ name (nameLen) ][ qty (4) ][ amount right-aligned (amtLen) ].
// Tax components belong in the document-level breakdown, not a redundant
// per-item column derived from deprecated product tax fields.
function itemHeader(nameLen: number, amtLen: number): string {
  const qtyW = 4;
  return (
    'Item'.padEnd(nameLen) +
    'Qty'.padEnd(qtyW) +
    rightAlign('Amount', amtLen)
  );
}

function itemRow(item: any, nameLen: number, amtLen: number, prefix: string, locale: string = 'en-US'): string {
  const qtyW = 4;
  const name = truncate(item.product_name, nameLen).padEnd(nameLen);
  const qty = String(item.quantity).padEnd(qtyW);
  const amt = rightAlign(formatCurrency(item.total, prefix, locale), amtLen);
  return name + qty + amt;
}

function addonRow(addon: any, nameLen: number, amtLen: number, cols: number, prefix: string, locale: string = 'en-US'): string {
  const midW = cols - nameLen - amtLen;
  const label = truncate('  + ' + addon.name, nameLen).padEnd(nameLen);
  const spacer = ' '.repeat(Math.max(0, midW));
  const price = addon.price ? rightAlign(formatCurrency(addon.price, prefix, locale), amtLen) : ' '.repeat(amtLen);
  return label + spacer + price;
}

function parseAddons(addons: any): any[] {
  return Array.isArray(addons) ? addons : [];
}

function formatCurrency(amount: number, prefix: string, locale: string = 'en-US'): string {
  return prefix + (Number(amount) || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function rightAlign(text: string, width: number = 24): string {
  return ' '.repeat(Math.max(1, width - text.length)) + text;
}

function truncate(text: string, length: number): string {
  return text.length > length ? text.substring(0, length - 2) + '..' : text;
}

export function formatKOT(order: any, items: any[], stationName: string, cols: number = 48, useUnicode: boolean = false, cutMode: PrinterCutMode = 'full', locale: string = 'en-US', tzOptions?: any): Buffer {
  const lines: string[] = [];
  const bar = '='.repeat(cols);

  lines.push('{INIT}');
  lines.push('{CENTER}{BOLD}KITCHEN ORDER TICKET{/BOLD}{/CENTER}');
  lines.push('');
  lines.push('Station: ' + stationName);
  lines.push('Order: ' + order.order_number);
  if (order.table) {
    lines.push('Table: ' + order.table.name);
  }
  lines.push('Time: ' + new Date(order.created_at).toLocaleTimeString(locale + '-u-nu-latn', tzOptions));
  lines.push(bar);
  lines.push('');

  for (const item of items) {
    lines.push('{DOUBLE_HEIGHT}{BOLD}' + item.quantity + 'x  ' + item.product_name + '{/BOLD}{/DOUBLE_HEIGHT}');
    const addons = parseAddons(item.addons);
    for (const addon of addons) {
      if (addon?.name) {
        lines.push('  + ' + truncate(String(addon.name), cols - 4));
      }
    }
    if (item.special_instructions) {
      lines.push('  ** ' + item.special_instructions + ' **');
    }
  }

  lines.push('');
  lines.push(bar);
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode, { cutMode });
}

export function buildTestPage(paperWidth: string = '80mm', cutMode: PrinterCutMode = 'full'): Buffer {
  const width = paperWidth === '58mm' ? 42 : 48;
  const bar = '='.repeat(width);
  const lines = [
    '{INIT}',
    '{CENTER}{BOLD}Flo Printer Test{/BOLD}{/CENTER}',
    '',
    bar,
    '{CENTER}Network / USB test print{/CENTER}',
    bar,
    '',
    `Paper: ${paperWidth}`,
    `Time: ${new Date().toLocaleString('en-US-u-nu-latn')}`,
    '',
    bar,
    '{CENTER}If you can read this, your printer is working!{/CENTER}',
    bar,
    '{CUT}',
  ];
  return buildEscPos(lines, false, { cutMode });
}

// Every ASCII fallback is exactly 2 characters, so the currency slot on a
// printed line is always 2 columns wide whether or not unicode is enabled.
const CURRENCY_ASCII_MAP: Record<string, string> = {
  '₹': 'Rs', '₨': 'Rs', '€': 'Eu', '£': 'Pd', '¥': 'Yn',
  '₩': 'Kw', '₺': 'Tl', '₫': 'Vd', '₪': 'Ns', '₽': 'Rb',
  '฿': 'Bh', '₱': 'Ph', '₴': 'Uh', '₦': 'Ng', '₵': 'Gh',
  '₡': 'Cr', '₲': 'Pg', 'د.إ': 'Dh', '﷼': 'Rl', '৳': 'Tk',
  'E£': 'Ep',
};

// Resolves the currency symbol into the exact text that will be printed,
// padded to a fixed 2-column slot (leading space if it's a single-width
// symbol). Must run BEFORE rightAlign() computes padding — swapping the
// symbol out afterwards (e.g. '₹' -> 'Rs') changes the string length and
// pushes trailing digits onto the next line.
function resolveCurrencyPrefix(symbol: string, useUnicode: boolean): string {
  const isAsciiSafe = /^[\x00-\x7F]+$/.test(symbol);
  const prefix = (useUnicode || isAsciiSafe)
    ? symbol
    : (CURRENCY_ASCII_MAP[symbol] || symbol.slice(0, 2).toUpperCase() || 'Rs');
  return prefix.length >= 2 ? prefix : ' '.repeat(2 - prefix.length) + prefix;
}

export function buildEscPos(lines: string[], useUnicode: boolean = false, options: { cutMode?: PrinterCutMode } = {}): Buffer {
  const buf: number[] = [];

  const resetAllStyles = () => {
    buf.push(0x1B, 0x45, 0x00);
    buf.push(0x1B, 0x21, 0x00);
    buf.push(0x1B, 0x61, 0x00);
  };

  for (let line of lines) {
    if (line.includes('{INIT}')) {
      buf.push(0x1B, 0x40);
      resetAllStyles();
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

    let lineBold = line.includes('{BOLD}');
    let lineDH = line.includes('{DOUBLE_HEIGHT}');
    let lineDW = line.includes('{DOUBLE_WIDTH}');
    // ESC/POS mode byte bit 0 selects the character font: 0 = Font A (12x24,
    // the default), 1 = Font B (9x17, condensed). No token means Font A.
    let lineFontB = line.includes('{FONT_B}');
    let center = line.startsWith('{CENTER}') && line.includes('{/CENTER}');

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

    if (lineBold) {
      buf.push(0x1B, 0x45, 0x01);
    }

    buf.push(...Buffer.from(line, 'utf8'));
    buf.push(0x0A);
  }

  return Buffer.from(buf);
}

export async function printViaNetwork(ip: string, port: number, data: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new net.Socket();

    client.connect(port, ip, () => {
      client.write(data, () => {
        client.end();
        resolve(true);
      });
    });

    client.on('error', (err) => {
      console.error(`[Printer] Network error: ${err.message}`);
      client.destroy();
      resolve(false);
    });

    client.setTimeout(5000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

export async function printViaUSB(data: Buffer, printerName?: string): Promise<boolean> {
  console.log('[Printer] printViaUSB called, platform:', process.platform, 'printer:', printerName);

  if (process.platform === 'darwin') {
    return await printViaUSBMacOS(data, printerName);
  }

  if (process.platform === 'win32') {
    return await printViaUSBWindows(data, printerName);
  }

  if (process.platform === 'linux') {
    return await printViaUSBLinux(data, printerName);
  }

  console.warn('[Printer] Unsupported platform:', process.platform);
  return false;
}

async function printViaUSBMacOS(data: Buffer, printerName?: string): Promise<boolean> {
  const tmpFile = `/tmp/flo_print_${Date.now()}.bin`;

  try {
    fs.writeFileSync(tmpFile, data);

    if (printerName) {
      execFileSync('lp', ['-d', printerName, '-o', 'raw', tmpFile], { encoding: 'utf8' });
    } else {
      execFileSync('lp', ['-o', 'raw', tmpFile], { encoding: 'utf8' });
    }

    return true;
  } catch (err: any) {
    console.error('[Printer] macOS print error:', err.message);
    return false;
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

async function printViaUSBWindows(data: Buffer, printerName?: string): Promise<boolean> {
  if (!printerName) {
    console.error('[Printer] No Windows printer configured; refusing to guess a target');
    return false;
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
        windowsHide: true,
        env: { ...process.env, FLO_PRINTER_NAME: printerName, FLO_PRINT_FILE: tmpFile },
      },
    );

    console.log(`[Printer] Windows raw print accepted for "${printerName}" (${stdout.trim()})`);
    return true;
  } catch (err: any) {
    const detail = String(err.stderr || err.message || '').trim();
    console.error(`[Printer] Windows raw print failed for "${printerName}": ${detail}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function printViaUSBLinux(data: Buffer, printerName?: string): Promise<boolean> {
  const tmpFile = `/tmp/flo_print_${Date.now()}.bin`;

  try {
    fs.writeFileSync(tmpFile, data);

    if (printerName) {
      execFileSync('lp', ['-d', printerName, '-o', 'raw', tmpFile], { encoding: 'utf8' });
    } else {
      execFileSync('lp', ['-o', 'raw', tmpFile], { encoding: 'utf8' });
    }

    return true;
  } catch (err: any) {
    console.error('[Printer] Linux print error:', err.message);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

export function getPrinterStatus(): { connected: boolean; printer: any } {
  const printer = getPrinterConfig();
  return { connected: !!printer, printer };
}
