import { app, dialog, type Session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

type ApprovableUsbDevice = {
  deviceId: string;
  vendorId: number;
  productId: number;
  serialNumber?: string;
  productName?: string;
  manufacturerName?: string;
};

/**
 * vendorId+productId+serialNumber is the only combination that reliably
 * identifies one physical device — many printers share generic VID/PID pairs
 * from the same USB-to-serial chipset, so vendorId+productId alone can match
 * a different physical unit. Returns null when the device has no serial
 * number, meaning it has no identity trustworthy enough to persist or match
 * across restarts (mirrors how browsers scope WebUSB's own persisted-grant
 * store to devices that report a serial number).
 */
function persistableDeviceKey(device: ApprovableUsbDevice): string | null {
  return device.serialNumber ? `${device.vendorId}:${device.productId}:${device.serialNumber}` : null;
}

function approvalsFilePath(): string {
  return path.join(app.getPath('userData'), 'usb-printer-approvals.json');
}

function loadPersistedApprovals(): Set<string> {
  try {
    const raw = fs.readFileSync(approvalsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function savePersistedApprovals(keys: Set<string>): void {
  try {
    fs.writeFileSync(approvalsFilePath(), JSON.stringify([...keys]), { mode: 0o600 });
  } catch (err) {
    console.warn('[Printer] Failed to persist USB device approval:', err);
  }
}

/**
 * Wires up Electron's main-process USB device permission handlers, which a
 * Chromium embed (unlike a standard browser) requires before
 * `navigator.usb.requestDevice()`/`getDevices()` can resolve at all. Without
 * this, PrinterService's WebUSB connect flow has no device picker to select
 * from and silently never resolves in the packaged desktop app (issue #534).
 *
 * Electron has no built-in device-chooser UI (unlike Chrome), so this shows
 * a native confirmation dialog naming the specific device the first time it
 * is offered — restoring the same user-mediated, per-device authorization a
 * real browser's picker provides, rather than auto-granting access.
 *
 * A device that reports a serial number gets a durable approval persisted to
 * disk (see persistableDeviceKey), so PrinterService's silent startup
 * reconnect keeps working across app restarts without re-prompting. A
 * device without a serial number has no identity that safely survives a
 * restart — persisting a bare vendorId+productId match would let a
 * different physical unit sharing that pair silently inherit another
 * device's approval — so it only gets a session-scoped approval (keyed by
 * Electron's own per-session deviceId) and must be re-confirmed after every
 * restart.
 *
 * Both handlers are also scoped to `trustedOrigin` (the app's own served
 * origin, e.g. `http://localhost:<port>`) — this app never intentionally
 * loads third-party content, but nothing else in the renderer's security
 * model stops a compromised dependency or a stray external navigation from
 * requesting USB access, so any request from another origin is refused
 * outright rather than reaching the dialog at all.
 */
export function registerUsbDevicePermissions(session: Session, trustedOrigin: string): void {
  const persistedApprovedKeys = loadPersistedApprovals();
  const sessionApprovedDeviceIds = new Set<string>();

  const isApproved = (device: ApprovableUsbDevice): boolean => {
    const persistKey = persistableDeviceKey(device);
    if (persistKey && persistedApprovedKeys.has(persistKey)) return true;
    return sessionApprovedDeviceIds.has(device.deviceId);
  };

  const markApproved = (device: ApprovableUsbDevice): void => {
    sessionApprovedDeviceIds.add(device.deviceId);
    const persistKey = persistableDeviceKey(device);
    if (persistKey) {
      persistedApprovedKeys.add(persistKey);
      savePersistedApprovals(persistedApprovedKeys);
    }
  };

  session.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    if (details.frame?.origin !== trustedOrigin) {
      callback();
      return;
    }
    const device = details.deviceList[0];
    if (!device) {
      callback();
      return;
    }
    if (isApproved(device)) {
      callback(device.deviceId);
      return;
    }

    const deviceLabel = device.productName
      ? `${device.productName}${device.manufacturerName ? ` (${device.manufacturerName})` : ''}`
      : `USB device ${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;

    dialog.showMessageBox({
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 0,
      cancelId: 1,
      title: 'Connect USB printer',
      message: 'FloCafe wants to connect to a USB device',
      detail: deviceLabel,
    }).then((result) => {
      if (result.response === 0) {
        markApproved(device);
        callback(device.deviceId);
      } else {
        callback();
      }
    }).catch(() => callback());
  });

  session.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'usb' || details.origin !== trustedOrigin) return false;
    return isApproved(details.device as ApprovableUsbDevice);
  });
}
