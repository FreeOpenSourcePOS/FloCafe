/**
 * PrinterService — WebUSB ESC/POS thermal printer driver.
 *
 * Real usage (WebUSB):  await printerService.connect();
 *                        await printerService.print(bytes);
 *
 * Browser fallback:     Use window.print() with thermal-optimized CSS
 */

export type PrinterStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type PrintMode = 'escpos' | 'browser';

export interface PrinterInfo {
  vendorId: number;
  productId: number;
  manufacturerName?: string;
  productName?: string;
  serialNumber?: string;
}

type StatusListener = (status: PrinterStatus, info?: PrinterInfo) => void;

const ESCPOS_USB_CLASS = 0x07;
const PRINTER_INTERFACE = 0;

class PrinterService {
  private device: USBDevice | null = null;
  private interfaceClaimed = false;
  private claimedInterface: number | null = null;
  private endpointOut = 0x01; // discovered dynamically on connect()
  private _status: PrinterStatus = 'disconnected';
  private _printMode: PrintMode = 'escpos';
  private listeners: Set<StatusListener> = new Set();

  get isConnected(): boolean {
    return this._status === 'connected';
  }

  get status(): PrinterStatus {
    return this._status;
  }

  get printMode(): PrintMode {
    return this._printMode;
  }

  get deviceInfo(): PrinterInfo | null {
    if (!this.device) return null;
    return {
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      manufacturerName: this.device.manufacturerName ?? undefined,
      productName: this.device.productName ?? undefined,
      serialNumber: this.device.serialNumber ?? undefined,
    };
  }

  setPrintMode(mode: PrintMode): void {
    this._printMode = mode;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private static readonly DEVICE_FILTERS: USBDeviceFilter[] = [
    { classCode: ESCPOS_USB_CLASS },
    { vendorId: 0x0483 },
    { vendorId: 0x04b8 },
    { vendorId: 0x0519 },
    { vendorId: 0x0dd4 },
    { vendorId: 0x1504 },
    { vendorId: 0x1a86 },
    { vendorId: 0x1fc9 },
    { vendorId: 0x20d1 },
    { vendorId: 0x2109 },
    { vendorId: 0x22e0 },
    { vendorId: 0x2e8d },
    { vendorId: 0x37b9 },
    { vendorId: 0x41c9 },
    { vendorId: 0x4d42 },
    { vendorId: 0x5255 },
    { vendorId: 0x525a },
    { vendorId: 0x0fe6 },
    { vendorId: 0x1b24 },
    { vendorId: 0x0922 },
  ];

  /**
   * Opens (or re-opens) a device that has already been granted, claiming its
   * ESC/POS interface. Shared by connect() (fresh grant) and tryReconnect()
   * (silent re-grant), which differ only in how they obtain `device`.
   */
  private async openDevice(device: USBDevice): Promise<void> {
    this.device = device;
    try {
      await this.device.open();

      if (this.device.configuration === null) {
        await this.device.selectConfiguration(1);
      }

      for (const iface of this.device.configurations[0]?.interfaces ?? []) {
        const alt = iface.alternates[0];
        if (alt?.interfaceClass === ESCPOS_USB_CLASS) {
          await this.device.claimInterface(iface.interfaceNumber);
          this.interfaceClaimed = true;
          this.claimedInterface = iface.interfaceNumber;
          // Discover the bulk-OUT endpoint number from the descriptor
          const outEndpoint = alt.endpoints.find(
            (ep) => ep.type === 'bulk' && ep.direction === 'out'
          );
          if (outEndpoint) this.endpointOut = outEndpoint.endpointNumber;
          break;
        }
      }

      if (!this.interfaceClaimed) {
        await this.device.claimInterface(PRINTER_INTERFACE);
        this.interfaceClaimed = true;
        this.claimedInterface = PRINTER_INTERFACE;
      }
    } catch (err) {
      await this.disconnect();
      this.setStatus('error');
      throw new Error(`Could not connect to printer: ${(err as Error).message}`);
    }

    this.setStatus('connected', this.deviceInfo ?? undefined);
    navigator.usb.addEventListener('disconnect', this.handleDisconnect);
  }

  // Serializes every device-acquisition attempt (connect() and tryReconnect()
  // alike) so at most one is ever inside openDevice() at a time. Without this,
  // a user clicking Connect while the startup tryReconnect() is still in
  // flight would have both concurrently mutate `this.device`/interface state;
  // a claim failure in one then runs openDevice()'s disconnect() cleanup and
  // tears down the connection the other just established.
  private connectLock: Promise<unknown> = Promise.resolve();

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.connectLock.catch(() => undefined);
    const run = previous.then(fn, fn);
    this.connectLock = run.catch(() => undefined);
    return run;
  }

  /**
   * Opens the browser's USB device picker and connects to a thermal printer.
   * Must be called from a user-gesture handler (click, etc.).
   */
  async connect(): Promise<void> {
    if (this._printMode === 'browser') {
      return;
    }

    if (!navigator.usb) {
      throw new Error(
        'WebUSB API is not supported in this browser. Use Chrome or Edge 89+.'
      );
    }

    return this.runExclusive(async () => {
      this.setStatus('connecting');

      let device: USBDevice;
      try {
        device = await navigator.usb!.requestDevice({ filters: PrinterService.DEVICE_FILTERS });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          this.setStatus('disconnected');
          return;
        }
        this.setStatus('error');
        throw new Error(`USB device selection failed: ${(err as Error).message}`);
      }

      await this.openDevice(device);
    });
  }

  private reconnectPromise: Promise<boolean> | null = null;

  /**
   * Silently re-attaches to a printer the user already granted permission
   * for in a previous session, using the non-prompting getDevices() API.
   * Safe to call on every app start/reload — never shows a picker and never
   * throws; returns whether a device was reattached. Without this, the
   * WebUSB connection is lost on every reload/relaunch and print() throws
   * "Printer is not connected" until the user manually reconnects.
   *
   * Concurrent calls (and calls made while one is already in flight) share
   * the same in-flight promise rather than racing multiple getDevices()/open()
   * attempts against each other.
   */
  async tryReconnect(): Promise<boolean> {
    if (this.reconnectPromise) return this.reconnectPromise;
    if (this._printMode === 'browser' || this.device || !navigator.usb) {
      return false;
    }
    this.reconnectPromise = this.runExclusive(async () => {
      // Re-check after acquiring the lock: a concurrent connect() may have
      // already opened a device while this call was waiting its turn.
      if (this.device) return true;
      try {
        const devices = await navigator.usb!.getDevices();
        const previouslyGranted = devices[0];
        if (!previouslyGranted) return false;
        this.setStatus('connecting');
        await this.openDevice(previouslyGranted);
        return true;
      } catch (err) {
        console.warn('[PrinterService] Silent reconnect failed:', err);
        this.setStatus('disconnected');
        return false;
      }
    }).finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  /**
   * Waits for a silent reconnect already in flight (started at app startup)
   * to settle, without starting a new one. Callers that gate on `isConnected`
   * right before printing should await this first — otherwise a print
   * triggered moments after startup (e.g. KOT auto-print on the first order)
   * can read `isConnected` as false and fall back to browser print even
   * though the WebUSB printer reconnects a beat later.
   */
  async awaitPendingReconnect(): Promise<void> {
    if (this.reconnectPromise) await this.reconnectPromise;
  }

  async disconnect(): Promise<void> {
    navigator.usb?.removeEventListener('disconnect', this.handleDisconnect);

    if (this.device) {
      try {
        if (this.interfaceClaimed && this.claimedInterface !== null) {
          await this.device.releaseInterface(this.claimedInterface).catch(() => {});
        }
      } catch {}

      try {
        await this.device.close();
      } catch {}

      this.device = null;
      this.interfaceClaimed = false;
      this.claimedInterface = null;
      this.endpointOut = 0x01;
    }

    this.setStatus('disconnected');
  }

  /**
   * Send raw ESC/POS bytes to the printer via WebUSB.
   * Throws if not connected or in browser print mode.
   */
  async print(data: Uint8Array): Promise<void> {
    if (this._printMode === 'browser') {
      throw new Error('Browser print mode is active. Use window.print() instead.');
    }

    if (!this.device || this._status !== 'connected') {
      throw new Error('Printer is not connected. Call connect() first.');
    }

    try {
      // Copy to a fresh ArrayBuffer covering exactly the encoder's bytes,
      // which avoids sending garbage if the Uint8Array is a subarray view.
      const buf = new Uint8Array(data).buffer as ArrayBuffer;
      await this.device.transferOut(this.endpointOut, buf);
    } catch (err) {
      throw new Error(`Print failed: ${(err as Error).message}`);
    }
  }

  /**
   * Print using browser's print dialog with thermal-optimized styles.
   * @param htmlContent - The HTML to print
   * @param paperWidth - Paper width in mm (58 or 80)
   */
  async printViaBrowser(htmlContent: string, paperWidth: 58 | 80): Promise<void> {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      throw new Error('Please allow popups to print');
    }

    const mmWidth = paperWidth === 58 ? '58mm' : '80mm';

    const style = printWindow.document.createElement('style');
    style.textContent = `
      @page { size: ${mmWidth} auto; margin: 0; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.2;
        width: ${mmWidth};
        max-width: ${mmWidth};
        margin: 0 auto;
        padding: 4px;
        text-align: left;
      }
      @media print {
        body { width: ${mmWidth} !important; max-width: ${mmWidth} !important; }
        @page { size: ${mmWidth} auto; margin: 0; }
      }
    `;
    printWindow.document.head.appendChild(style);

    // Parse receipt markup in an inert document, then remove executable and
    // javascript-bearing nodes before importing it into the print window.
    const parsed = new DOMParser().parseFromString(htmlContent, 'text/html');
    parsed.querySelectorAll('script, link, meta, base, iframe, object, embed, form').forEach((node) => node.remove());
    parsed.querySelectorAll('*').forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on')) {
          element.removeAttribute(attribute.name);
        } else if (
          ['href', 'src', 'action'].includes(name) &&
          /^(?:javascript|data):/i.test(attribute.value.trim())
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    });
    printWindow.document.body.replaceChildren(
      ...Array.from(parsed.body.childNodes).map((node) => printWindow.document.importNode(node, true)),
    );
    printWindow.document.close();
    printWindow.print();
    printWindow.close();
  }

  private setStatus(status: PrinterStatus, info?: PrinterInfo): void {
    this._status = status;
    this.listeners.forEach((listener) => {
      try {
        listener(status, info);
      } catch (error) {
        console.warn('[PrinterService] Status listener failed:', error);
      }
    });
  }

  private handleDisconnect = (event: Event): void => {
    const e = event as USBConnectionEvent;
    if (e.device === this.device) {
      this.device = null;
      this.interfaceClaimed = false;
      this.claimedInterface = null;
      this.setStatus('disconnected');
    }
  };
}

export const printerService = new PrinterService();
