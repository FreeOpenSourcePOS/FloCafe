'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { printerService, type PrinterStatus, type PrinterInfo, type PrintMode } from '@/lib/printer/PrinterService';
import {
  buildClassicReceiptBytes,
  buildCompactReceiptBytes,
  buildDetailedReceiptBytes,
  type ReceiptOptions,
} from '@/lib/printer/receipt-encoder';
import { usePosSettingsStore } from '@/store/pos-settings';
import { buildGstBillBytes, type GstBillOptions } from '@/lib/printer/gst-bill-encoder';
import { buildKotBytes, type KotOptions } from '@/lib/printer/kot-encoder';
import api from '@/lib/api';
import type { Bill, Tenant, Order } from '@/lib/types';

type PrintModeType = 'receipt' | 'gst' | 'kot';
type PaperWidth = 58 | 80;

export interface HardwarePrinter {
  id: string;
  name: string;
  connection_type: 'network' | 'usb' | 'webusb';
  ip_address?: string | null;
  port?: number | null;
  usb_device_path?: string | null;
  paper_width?: string | null;
  is_default: number;
}

interface PrinterState {
  status: PrinterStatus;
  deviceInfo: PrinterInfo | null;
  lastError: string | null;
  lastPrintedBytes: Uint8Array | null;
  printMode: PrintModeType;
  paperWidth: PaperWidth;
  printMethod: PrintMode;
  hardwarePrinter: HardwarePrinter | null;

  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  printBill: (bill: Bill, tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>, opts?: ReceiptOptions) => Promise<void>;
  printGstBill: (bill: Bill, tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>, opts?: GstBillOptions) => Promise<void>;
  printKot: (order: Order, opts?: KotOptions) => Promise<void>;
  setPrintMode: (mode: PrintModeType) => void;
  setPaperWidth: (width: PaperWidth) => void;
  setPrintMethod: (method: PrintMode) => void;
  clearError: () => void;
  downloadLastReceipt: () => void;
  copyLastReceiptHex: () => Promise<void>;
  refreshHardwarePrinter: () => Promise<void>;
}

export const usePrinterStore = create<PrinterState>()(
  persist(
    (set, get) => ({
      status: 'disconnected',
      deviceInfo: null,
      lastError: null,
      lastPrintedBytes: null,
      printMode: 'receipt',
      paperWidth: 58,
      printMethod: 'escpos',
      hardwarePrinter: null,

      refreshHardwarePrinter: async () => {
        try {
          const res = await api.get('/printers');
          const list: HardwarePrinter[] = res.data.printers || [];
          const defaultPrinter = list.find((p) => p.is_default === 1 && p.connection_type !== 'webusb') || null;
          set({ hardwarePrinter: defaultPrinter });
        } catch {
          set({ hardwarePrinter: null });
        }
      },

      connect: async () => {
        set({ lastError: null });
        try {
          await printerService.connect();
        } catch (err) {
          set({ lastError: (err as Error).message });
        }
      },

      disconnect: async () => {
        await printerService.disconnect();
      },

      printBill: async (bill, tenant, opts) => {
        set({ lastError: null });
        try {
          const {
            billTemplate,
            billGstin, billAddress, billPhone, billFooterMessage,
            billShowName, billShowAddress, billShowPhone, billShowGstn,
            webPrintSize,
            printerUseUnicode,
          } = usePosSettingsStore.getState();

          const isReprint = opts?.isReprint ?? false;

          const hw = get().hardwarePrinter;
          if (hw && get().printMethod === 'escpos') {
            try {
              await api.post('/printers/print-bill', { billId: bill.id, useUnicode: printerUseUnicode, isReprint });
              return;
            } catch (err: unknown) {
              const e = err as { response?: { data?: { error?: string } }; message?: string };
              throw new Error(e.response?.data?.error || e.message || 'Print failed');
            }
          }

          if (get().printMethod === 'browser') {
            // Browser / A4 print path
            const { printWebBill } = await import('@/lib/printer/web-print');
            printWebBill(bill, tenant, {
              paperSize: webPrintSize,
              includeGst: billShowGstn,
              gstin: billShowGstn && billGstin ? billGstin : undefined,
              address: billShowAddress && billAddress ? billAddress : undefined,
              phone: billShowPhone && billPhone ? billPhone : undefined,
              footerNote: billFooterMessage || undefined,
              businessName: billShowName ? tenant.business_name : undefined,
              useUnicode: printerUseUnicode,
              isReprint,
            });
            return;
          }

          // ESC/POS thermal path
          const { paperWidth } = get();
          const builderOpts: ReceiptOptions = {
            ...opts,
            paperWidth,
            gstin: billShowGstn && billGstin ? billGstin : undefined,
            address: billShowAddress && billAddress ? billAddress : undefined,
            phone: billShowPhone && billPhone ? billPhone : undefined,
            footerNote: billFooterMessage || undefined,
            showTaxBreakdown: billShowGstn,
            useUnicode: printerUseUnicode,
            isReprint,
          };

          let bytes: Uint8Array;
          if (billTemplate === 'compact') {
            bytes = buildCompactReceiptBytes(bill, tenant, builderOpts);
          } else if (billTemplate === 'detailed') {
            bytes = buildDetailedReceiptBytes(bill, tenant, builderOpts);
          } else {
            bytes = buildClassicReceiptBytes(bill, tenant, builderOpts);
          }

          set({ lastPrintedBytes: bytes });
          await printerService.print(bytes);
        } catch (err) {
          set({ lastError: (err as Error).message });
          throw err;
        }
      },

      printGstBill: async (bill, tenant, opts) => {
        set({ lastError: null });
        try {
          const { paperWidth } = get();
          const { printerUseUnicode } = usePosSettingsStore.getState();
          const bytes = buildGstBillBytes(bill, tenant, { ...opts, paperWidth, useUnicode: printerUseUnicode });
          set({ lastPrintedBytes: bytes });
          
          if (get().printMethod === 'escpos') {
            await printerService.print(bytes);
          } else {
            throw new Error('Browser print mode - use printViaBrowser instead');
          }
        } catch (err) {
          set({ lastError: (err as Error).message });
          throw err;
        }
      },

      printKot: async (order, opts) => {
        set({ lastError: null });
        try {
          const { printerUseUnicode } = usePosSettingsStore.getState();
          const hw = get().hardwarePrinter;
          if (hw && get().printMethod === 'escpos') {
            try {
              await api.post('/printers/print-kot', { orderId: order.id, useUnicode: printerUseUnicode });
              return;
            } catch (err: unknown) {
              const e = err as { response?: { data?: { error?: string } }; message?: string };
              throw new Error(e.response?.data?.error || e.message || 'KOT print failed');
            }
          }

          const { paperWidth } = get();
          const bytes = buildKotBytes(order, { ...opts, paperWidth });
          set({ lastPrintedBytes: bytes });

          if (get().printMethod === 'escpos') {
            await printerService.print(bytes);
          } else {
            throw new Error('Browser print mode - use printViaBrowser instead');
          }
        } catch (err) {
          set({ lastError: (err as Error).message });
          throw err;
        }
      },

      setPrintMode: (mode) => set({ printMode: mode }),
      setPaperWidth: (width) => set({ paperWidth: width }),
      setPrintMethod: (method) => {
        printerService.setPrintMode(method);
        set({ printMethod: method, lastError: null });
      },

      clearError: () => set({ lastError: null }),

      downloadLastReceipt: () => {
        const bytes = get().lastPrintedBytes;
        if (!bytes) return;
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'receipt.bin';
        a.click();
        URL.revokeObjectURL(url);
      },

      copyLastReceiptHex: async () => {
        const bytes = get().lastPrintedBytes;
        if (!bytes) return;
        const hex = Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
          .join(' ');
        await navigator.clipboard.writeText(hex);
      },
    }),
    {
      name: 'flo-printer-settings',
      partialize: (state) => ({ printMode: state.printMode, paperWidth: state.paperWidth, printMethod: state.printMethod }),
    }
  )
);

export function usePrinterStatusSync(): void {
  const store = usePrinterStore();

  useEffect(() => {
    usePrinterStore.setState({
      status: printerService.status,
      deviceInfo: printerService.deviceInfo,
    });

    store.refreshHardwarePrinter();

    const unsub = printerService.onStatusChange((status, info) => {
      usePrinterStore.setState({
        status,
        deviceInfo: info ?? printerService.deviceInfo,
      });
    });

    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
