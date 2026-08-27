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
 * A `deviceId` is only stable for the current session/enumeration — it is
 * not guaranteed to match after an app restart or device replug, so it
 * can't be used as the persisted identity. vendorId+productId+serialNumber
 * (falling back to just vendorId+productId when a printer doesn't report a
 * serial) is stable across restarts and is what's actually persisted.
 */
function stableDeviceKey(device: ApprovableUsbDevice): string {
  return device.serialNumber
    ? `${device.vendorId}:${device.productId}:${device.serialNumber}`
    : `${device.vendorId}:${device.productId}`;
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
 * real browser's picker provides, rather than auto-granting access. Once
 * approved, the device's stable identity (see stableDeviceKey) is persisted
 * to disk so PrinterService's silent startup reconnect keeps working across
 * app restarts without re-prompting — an in-memory-only approval set would
 * make every relaunch require re-approving the same printer.
 *
 * Both handlers are also scoped to `trustedOrigin` (the app's own served
 * origin, e.g. `http://localhost:<port>`) — this app never intentionally
 * loads third-party content, but nothing else in the renderer's security
 * model stops a compromised dependency or a stray external navigation from
 * requesting USB access, so any request from another origin is refused
 * outright rather than reaching the dialog at all.
 */
export function registerUsbDevicePermissions(session: Session, trustedOrigin: string): void {
  const approvedDeviceKeys = loadPersistedApprovals();

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
    if (approvedDeviceKeys.has(stableDeviceKey(device))) {
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
        approvedDeviceKeys.add(stableDeviceKey(device));
        savePersistedApprovals(approvedDeviceKeys);
        callback(device.deviceId);
      } else {
        callback();
      }
    }).catch(() => callback());
  });

  session.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'usb' || details.origin !== trustedOrigin) return false;
    return approvedDeviceKeys.has(stableDeviceKey(details.device as ApprovableUsbDevice));
  });
}
