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
 */
export function registerUsbDevicePermissions(session: Session): void {
  session.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    callback(details.deviceList[0]?.deviceId);
  });

  session.setDevicePermissionHandler((details) => details.deviceType === 'usb');
}
