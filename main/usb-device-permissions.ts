import type { Session } from 'electron';

/**
 * Wires up Electron's main-process USB device permission handlers, which a
 * Chromium embed (unlike a standard browser) requires before
 * `navigator.usb.requestDevice()`/`getDevices()` can resolve at all. Without
 * this, PrinterService's WebUSB connect flow has no device picker to select
 * from and silently never resolves in the packaged desktop app (issue #534).
 *
 * FloCafe is a single-origin app serving its own trusted renderer, so there
 * is no cross-site device-picker UX to build: any USB device offered by the
 * WebUSB filters (see PrinterService.DEVICE_FILTERS — ESC/POS printer class
 * plus known thermal-printer vendor IDs) is auto-selected and the origin is
 * granted standing permission to it, mirroring what a user would approve in
 * a real browser's picker. With more than one matching device connected,
 * the first one reported is selected; a POS terminal with multiple
 * simultaneously-attached USB printers isn't a supported configuration.
 *
 * Both handlers are scoped to `trustedOrigin` (the app's own served origin,
 * e.g. `http://localhost:<port>`) — this app never intentionally loads
 * third-party content, but nothing else in the renderer's security model
 * stops a compromised dependency or a stray external navigation from
 * requesting USB access, so any request from another origin is refused
 * rather than silently auto-approved.
 */
export function registerUsbDevicePermissions(session: Session, trustedOrigin: string): void {
  session.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    if (details.frame?.origin !== trustedOrigin) {
      callback();
      return;
    }
    callback(details.deviceList[0]?.deviceId);
  });

  session.setDevicePermissionHandler((details) => details.deviceType === 'usb' && details.origin === trustedOrigin);
}
