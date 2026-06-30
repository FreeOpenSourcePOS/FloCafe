import * as net from 'net';
import * as fs from 'fs';
import { execSync, exec, execFileSync } from 'child_process';
import { getDatabase } from '../db';

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
}

function guessPaperWidth(name: string, model: string): string {
  const s = (name + ' ' + model).toLowerCase();
  if (s.includes('58')) return '58mm';
  return '80mm';
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

          printers.push({
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
          });
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
    const out = execSync(`lpstat -p "${name}" 2>/dev/null`, { encoding: 'utf8' }).toLowerCase();
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
    const info = execSync(`lpoptions -p "${name}" -l 2>/dev/null`, { encoding: 'utf8' });

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
    const defaultPrinter = execSync('lpstat -d 2>/dev/null', { encoding: 'utf8' });
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

        printers.push({
          name,
          make: makeModel.make,
          model: makeModel.model,
          connectionType: 'usb',
          deviceUri: name,
          driver,
          status: status === 'ok' || status === 'idle' ? 'idle' : 'offline',
          isDefault,
          paperWidth: guessPaperWidth(name, makeModel.model),
        });
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

        printers.push({
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
        });
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

export async function printReceipt(order: any, bill: any, business?: any, template?: string, useUnicode: boolean = false): Promise<boolean> {
  try {
    console.log('[Printer] printReceipt called, template:', template, 'useUnicode:', useUnicode);
    const printer = getPrinterConfig();
    if (!printer) {
      console.log('[Printer] No printer configured');
      return false;
    }
    console.log('[Printer] Using printer:', printer.name, printer.connection_type);

    const paperWidth = printer.paper_width || '80mm';
    const cols = paperWidth === '58mm' ? 42 : 48;

    let data: Buffer;
    try {
      data = formatReceipt(order, bill, business, template, cols, useUnicode);
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

export async function printKOT(order: any, items: any[], stationName: string, useUnicode: boolean = false): Promise<boolean> {
  try {
    console.log('[Printer] printKOT called, items count:', items?.length || 0, 'useUnicode:', useUnicode);
    const printer = getPrinterConfig();
    if (!printer) {
      console.log('[Printer] No printer configured');
      return false;
    }
    console.log('[Printer] Using printer:', printer.name, printer.connection_type);

    const paperWidth = printer.paper_width || '80mm';
    const cols = paperWidth === '58mm' ? 42 : 48;

    const data = formatKOT(order, items, stationName, cols, useUnicode);
    console.log('[Printer] KOT data length:', data.length, 'bytes');
    return await dispatchPrint(printer, data);
  } catch (error: any) {
    console.error('[Printer] KOT print error:', error);
    return false;
  }
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

export function formatReceipt(order: any, bill: any, business?: any, template?: string, cols: number = 48, useUnicode: boolean = false): Buffer {
  console.log('[Printer] formatReceipt - template:', template);
  console.log('[Printer] formatReceipt - order:', order?.order_number, 'bill:', bill?.bill_number);
  console.log('[Printer] formatReceipt - items count:', order?.items?.length || 0, 'cols:', cols);

  const tpl = template || 'compact';
  const biz = business || { name: 'Store', address: '', phone: '', gstin: '' };

  try {
    switch (tpl) {
      case 'classic':
        return formatClassicReceipt(order, bill, biz, cols, useUnicode);
      case 'detailed':
        return formatDetailedReceipt(order, bill, biz, cols, useUnicode);
      default:
        return formatCompactReceipt(order, bill, biz, cols, useUnicode);
    }
  } catch (err) {
    console.error('[Printer] formatReceipt error:', err);
    throw err;
  }
}

function formatCompactReceipt(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false): Buffer {
  const lines: string[] = [];
  const date = new Date(order.created_at);

  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);

  const itemNameLen = cols === 42 ? 22 : 28;
  const amtLen = 10;

  lines.push('{INIT}');
  lines.push('{CENTER}{BOLD}' + (biz.name || 'Store') + '{/BOLD}{/CENTER}');
  lines.push(bar);
  lines.push('Bill #: ' + (bill.bill_number || order.order_number));
  lines.push('Date: ' + date.toLocaleDateString() + ' ' + date.toLocaleTimeString());
  lines.push(dash);
  lines.push(itemHeader(itemNameLen, amtLen, cols));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      lines.push(itemRow(item, itemNameLen, amtLen, cols));

      const addons = parseAddons(item.addons);
      for (const addon of addons) {
        lines.push(addonRow(addon, itemNameLen, amtLen, cols));
      }
      if (item.special_instructions) {
        lines.push('  Note: ' + truncate(item.special_instructions, cols - 8));
      }
    }
  }

  lines.push(dash);
  lines.push('Subtotal' + rightAlign(formatCurrency(bill.subtotal), cols - 8));
  if (bill.discount_amount > 0) {
    lines.push('Discount' + rightAlign('-' + formatCurrency(bill.discount_amount), cols - 8));
  }
  lines.push('Tax' + rightAlign(formatCurrency(bill.tax_amount), cols - 3));
  lines.push('{BOLD}TOTAL' + rightAlign(formatCurrency(bill.total), cols - 5) + '{/BOLD}');

  if (bill.payment_details) {
    lines.push(dash);
    try {
      const payments = typeof bill.payment_details === 'string' ? JSON.parse(bill.payment_details) : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            lines.push(payment.method + rightAlign(formatCurrency(payment.amount), cols - payment.method.length));
          }
        }
      }
    } catch {}
  }

  lines.push(bar);
  if (biz.address) lines.push(biz.address);
  if (biz.phone) lines.push('Ph: ' + biz.phone);
  if (biz.gstin) lines.push('GSTIN: ' + biz.gstin);
  lines.push('{CENTER}Thank you!{/CENTER}');
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode);
}

function formatClassicReceipt(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false): Buffer {
  const lines: string[] = [];
  const date = new Date(order.created_at);

  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);

  const itemNameLen = cols === 42 ? 22 : 28;
  const amtLen = 10;

  lines.push('{INIT}');
  lines.push('{CENTER}{BOLD}' + (biz.name || 'Store') + '{/BOLD}{/CENTER}');
  lines.push(bar);
  lines.push('Bill #: ' + (bill.bill_number || order.order_number));
  lines.push('Date: ' + date.toLocaleDateString() + ' ' + date.toLocaleTimeString());
  lines.push(dash);
  lines.push(itemHeader(itemNameLen, amtLen, cols));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      lines.push(itemRow(item, itemNameLen, amtLen, cols));

      const addons = parseAddons(item.addons);
      for (const addon of addons) {
        lines.push(addonRow(addon, itemNameLen, amtLen, cols));
      }
      if (item.special_instructions) {
        lines.push('  Note: ' + truncate(item.special_instructions, cols - 8));
      }
    }
  }

  lines.push(dash);
  lines.push('Subtotal' + rightAlign(formatCurrency(bill.subtotal), cols - 8));
  if (bill.discount_amount > 0) {
    lines.push('Discount' + rightAlign('-' + formatCurrency(bill.discount_amount), cols - 8));
  }
  lines.push('Tax' + rightAlign(formatCurrency(bill.tax_amount), cols - 3));
  lines.push('{BOLD}TOTAL' + rightAlign(formatCurrency(bill.total), cols - 5) + '{/BOLD}');

  if (bill.payment_details) {
    lines.push(dash);
    try {
      const payments = typeof bill.payment_details === 'string' ? JSON.parse(bill.payment_details) : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            lines.push(payment.method + rightAlign(formatCurrency(payment.amount), cols - payment.method.length));
          }
        }
      }
    } catch {}
  }

  lines.push(bar);
  if (biz.address) lines.push(biz.address);
  if (biz.phone) lines.push('Ph: ' + biz.phone);
  if (biz.gstin) lines.push('GSTIN: ' + biz.gstin);
  lines.push('{CENTER}Thank you!{/CENTER}');
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode);
}

function formatDetailedReceipt(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false): Buffer {
  const lines: string[] = [];
  const date = new Date(order.created_at);
  
  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);
  
  const itemNameLen = cols === 42 ? 22 : 28;

  lines.push('{INIT}');
  lines.push('{CENTER}{BOLD}' + (biz.name || 'Store').toUpperCase() + '{/BOLD}{/CENTER}');
  lines.push(bar);
  lines.push('{CENTER}TAX INVOICE{/CENTER}');
  lines.push(bar);
  lines.push('Invoice #: ' + (bill.bill_number || order.order_number));
  lines.push('Date: ' + date.toLocaleDateString());
  lines.push('Time: ' + date.toLocaleTimeString());
  lines.push(dash);
  lines.push(itemHeader(itemNameLen, 10, cols));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      lines.push(itemRow(item, itemNameLen, 10, cols));

      const addons = parseAddons(item.addons);
      for (const addon of addons) {
        lines.push(addonRow(addon, itemNameLen, 10, cols));
      }
      if (item.special_instructions) {
        lines.push('  Note: ' + truncate(item.special_instructions, cols - 8));
      }
    }
  }

  lines.push(dash);
  lines.push('Subtotal' + rightAlign(formatCurrency(bill.subtotal), cols - 8));
  if (bill.discount_amount > 0) {
    lines.push('Discount' + rightAlign('-' + formatCurrency(bill.discount_amount), cols - 8));
  }

  if (bill.tax_breakdown) {
    try {
      const taxBreakdown = typeof bill.tax_breakdown === 'string' ? JSON.parse(bill.tax_breakdown) : bill.tax_breakdown;
      if (Array.isArray(taxBreakdown) && taxBreakdown.length > 0) {
        for (const tax of taxBreakdown) {
          if (tax.amount > 0) {
            lines.push((tax.name || 'Tax') + ' @' + tax.rate + '%' + rightAlign(formatCurrency(tax.amount), cols - 16));
          }
        }
      }
    } catch {
      lines.push('Tax' + rightAlign(formatCurrency(bill.tax_amount), cols - 3));
    }
  } else {
    lines.push('Tax' + rightAlign(formatCurrency(bill.tax_amount), cols - 3));
  }

  lines.push(bar);
  lines.push('{BOLD}GRAND TOTAL' + rightAlign(formatCurrency(bill.total), cols - 12) + '{/BOLD}');

  if (bill.payment_details) {
    lines.push(dash);
    try {
      const payments = typeof bill.payment_details === 'string' ? JSON.parse(bill.payment_details) : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            lines.push(payment.method + rightAlign(formatCurrency(payment.amount), cols - payment.method.length));
          }
        }
      }
    } catch {}
  }

  lines.push(bar);
  if (biz.address) lines.push('Address: ' + biz.address);
  if (biz.phone) lines.push('Phone: ' + biz.phone);
  if (biz.gstin) lines.push('GSTIN: ' + biz.gstin);
  lines.push('{CENTER}Thank you for your business!{/CENTER}');
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode);
}

// Item row layout: [ name (nameLen) ][ qty (4) ][ tax (5) ][ amount right-aligned (amtLen) ]
// All four segments sum to `cols`, so columns line up between header and rows.
function itemHeader(nameLen: number, amtLen: number, cols: number): string {
  const qtyW = 4;
  const taxW = cols - nameLen - qtyW - amtLen;
  return (
    'Item'.padEnd(nameLen) +
    'Qty'.padEnd(qtyW) +
    'Tax'.padEnd(taxW) +
    rightAlign('Amount', amtLen)
  );
}

function itemRow(item: any, nameLen: number, amtLen: number, cols: number): string {
  const qtyW = 4;
  const taxW = cols - nameLen - qtyW - amtLen;
  const name = truncate(item.product_name, nameLen).padEnd(nameLen);
  const qty = String(item.quantity).padEnd(qtyW);
  const taxRate = getTaxRate(item);
  const taxStr = (taxRate > 0 ? taxRate + '%' : '').padEnd(taxW);
  const amt = rightAlign(formatCurrency(item.total), amtLen);
  return name + qty + taxStr + amt;
}

function addonRow(addon: any, nameLen: number, amtLen: number, cols: number): string {
  const midW = cols - nameLen - amtLen;
  const label = truncate('  + ' + addon.name, nameLen).padEnd(nameLen);
  const spacer = ' '.repeat(Math.max(0, midW));
  const price = addon.price ? rightAlign(formatCurrency(addon.price), amtLen) : ' '.repeat(amtLen);
  return label + spacer + price;
}

function parseAddons(addons: any): any[] {
  if (!addons) return [];
  if (typeof addons === 'string') {
    try {
      const parsed = JSON.parse(addons);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return Array.isArray(addons) ? addons : [];
}

function formatCurrency(amount: number): string {
  return '₹' + (Number(amount) || 0).toFixed(2);
}

function rightAlign(text: string, width: number = 24): string {
  return ' '.repeat(Math.max(1, width - text.length)) + text;
}

function getTaxRate(item: any): number {
  if (item.tax_rate !== undefined && item.tax_rate !== null) return Number(item.tax_rate);
  if (item.tax_type && item.tax_type !== 'none') {
    const match = item.tax_type.match(/(\d+)/);
    if (match) return parseInt(match[1]);
  }
  if (item.unit_price && item.tax_amount) {
    const rate = (item.tax_amount / item.unit_price / item.quantity) * 100;
    return Math.round(rate);
  }
  return 0;
}

function truncate(text: string, length: number): string {
  return text.length > length ? text.substring(0, length - 2) + '..' : text;
}

export function formatKOT(order: any, items: any[], stationName: string, cols: number = 48, useUnicode: boolean = false): Buffer {
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
  lines.push('Time: ' + new Date(order.created_at).toLocaleTimeString());
  lines.push(bar);
  lines.push('');

  for (const item of items) {
    lines.push('{DOUBLE_HEIGHT}{BOLD}' + item.quantity + 'x  ' + item.product_name + '{/BOLD}{/DOUBLE_HEIGHT}');
    if (item.special_instructions) {
      lines.push('  ** ' + item.special_instructions + ' **');
    }
  }

  lines.push('');
  lines.push(bar);
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode);
}

export function buildTestPage(paperWidth: string = '80mm'): Buffer {
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
    `Time: ${new Date().toLocaleString()}`,
    '',
    bar,
    '{CENTER}If you can read this, your printer is working!{/CENTER}',
    bar,
    '{CUT}',
  ];
  return buildEscPos(lines);
}

const CURRENCY_ASCII_MAP: Record<string, string> = {
  '₹': 'Rs', '₨': 'Rs', '€': 'EUR', '£': 'GBP', '¥': 'Yen',
  '₩': 'KRW', '₺': 'TRY', '₫': 'VND', '₪': 'NIS', '₽': 'RUB',
  '฿': 'THB', '₱': 'PHP', '₴': 'UAH', '₦': 'NGN', '₵': 'GHS',
  '₡': 'CRC', '₲': 'PYG',
};

function normalizeCurrencyToAscii(text: string): string {
  let out = text;
  for (const [sym, ascii] of Object.entries(CURRENCY_ASCII_MAP)) {
    if (out.includes(sym)) out = out.split(sym).join(ascii);
  }
  return out;
}

export function buildEscPos(lines: string[], useUnicode: boolean = false): Buffer {
  const buf: number[] = [];

  const resetAllStyles = () => {
    buf.push(0x1B, 0x45, 0x00);
    buf.push(0x1B, 0x21, 0x00);
    buf.push(0x1B, 0x61, 0x00);
  };

  for (let line of lines) {
    if (!useUnicode) line = normalizeCurrencyToAscii(line);
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
      buf.push(0x1D, 0x56, 0x00);
      continue;
    }

    let lineBold = line.includes('{BOLD}');
    let lineDH = line.includes('{DOUBLE_HEIGHT}');
    let lineDW = line.includes('{DOUBLE_WIDTH}');
    let center = line.startsWith('{CENTER}') && line.includes('{/CENTER}');

    line = line.replace(/\{CENTER\}/g, '').replace(/\{\/CENTER\}/g, '');
    line = line.replace(/\{BOLD\}/g, '').replace(/\{\/BOLD\}/g, '');
    line = line.replace(/\{DOUBLE_HEIGHT\}/g, '').replace(/\{\/DOUBLE_HEIGHT\}/g, '');
    line = line.replace(/\{DOUBLE_WIDTH\}/g, '').replace(/\{\/DOUBLE_WIDTH\}/g, '');

    buf.push(0x1B, 0x61, center ? 0x01 : 0x00);

    if (lineBold || lineDH || lineDW) {
      let mode = 0;
      if (lineDH) mode |= 0x10;
      if (lineDW) mode |= 0x20;
      if (lineBold) mode |= 0x08;
      buf.push(0x1B, 0x21, mode);
    } else {
      buf.push(0x1B, 0x21, 0x00);
    }

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
      client.write(data);
      client.end();
      resolve(true);
    });

    client.on('error', (err) => {
      console.error(`[Printer] Network error: ${err.message}`);
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

  console.log('[Printer] Unsupported platform:', process.platform);
  return false;
}

async function printViaUSBMacOS(data: Buffer, printerName?: string): Promise<boolean> {
  const tmpFile = `/tmp/flo_print_${Date.now()}.bin`;

  try {
    fs.writeFileSync(tmpFile, data);
    console.log('[Printer] Data written to:', tmpFile, 'size:', data.length, 'bytes');
    console.log('[Printer] First 50 bytes:', Array.from(data.slice(0, 50)).map(b => b.toString(16)).join(' '));

    const args = ['-o', 'raw', tmpFile];
    if (printerName) {
      args.splice(0, 0, '-d', printerName);
    }

    console.log('[Printer] Executing: lp', args.join(' '));
    const result = execFileSync('lp', args, { encoding: 'utf8' });
    console.log('[Printer] Print sent successfully, result:', result);
    return true;
  } catch (err: any) {
    console.error('[Printer] macOS print error:', err.message);
    console.error('[Printer] Error details:', err);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function printViaUSBWindows(data: Buffer, printerName?: string): Promise<boolean> {
  try {
    const printerLib = require('node-thermal-printer');
    const ThermalPrinter = printerLib.printer;
    const PrinterTypes = printerLib.types;

    const printer = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: printerName ? ` printer:${printerName}` : undefined,
      width: 48,
    });

    const isConnected = await printer.isPrinterConnected();
    console.log('[Printer] Windows printer connected:', isConnected);

    if (!isConnected) {
      console.error('[Printer] No USB printer detected');
      return false;
    }

    printer.printRaw(data);
    await printer.execute();
    console.log('[Printer] Windows print sent successfully');
    return true;
  } catch (err: any) {
    console.error('[Printer] Windows print error:', err.message);

    console.log('[Printer] Trying raw Windows printing...');
    return await printViaWindowsRaw(data, printerName);
  }
}

async function printViaWindowsRaw(data: Buffer, printerName?: string): Promise<boolean> {
  try {
    const tmpFile = `C:\\Windows\\Temp\\flo_print_${Date.now()}.bin`;
    fs.writeFileSync(tmpFile, data);

    const name = printerName || 'Microsoft Print to PDF';
    const psCommand = `Start-Process -FilePath '${tmpFile}' -Verb PrintTo -ArgumentList '${name}' -Wait`;

    execFileSync('powershell', ['-Command', psCommand], { encoding: 'utf8', shell: true });
    fs.unlinkSync(tmpFile);
    return true;
  } catch (err: any) {
    console.error('[Printer] Windows raw print error:', err.message);
    return false;
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
