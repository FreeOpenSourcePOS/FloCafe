import { dialog, type Session } from 'electron';

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
 * real browser's picker provides, rather than auto-granting access. Once a
 * device is explicitly approved it is remembered for the running app
 * session (matches the printer being connected once via the POS toolbar's
 * Connect button, not re-prompted on every reload/print).
 *
 * Both handlers are also scoped to `trustedOrigin` (the app's own served
 * origin, e.g. `http://localhost:<port>`) — this app never intentionally
 * loads third-party content, but nothing else in the renderer's security
 * model stops a compromised dependency or a stray external navigation from
 * requesting USB access, so any request from another origin is refused
 * outright rather than reaching the dialog at all.
 */
export function registerUsbDevicePermissions(session: Session, trustedOrigin: string): void {
  const approvedDeviceIds = new Set<string>();

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
    if (approvedDeviceIds.has(device.deviceId)) {
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
        approvedDeviceIds.add(device.deviceId);
        callback(device.deviceId);
      } else {
        callback();
      }
    }).catch(() => callback());
  });

  session.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'usb' || details.origin !== trustedOrigin) return false;
    return approvedDeviceIds.has((details.device as { deviceId: string }).deviceId);
  });
}
