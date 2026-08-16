'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { printerService, type PrinterStatus, type PrinterInfo, type PrintMode } from '@/lib/printer/PrinterService';
import {
  buildClassicReceiptBytes,
  buildCompactReceiptBytes,
  type ReceiptOptions,
} from '@/lib/printer/receipt-encoder';
import { usePosSettingsStore } from '@/store/pos-settings';
import { buildTaxBillBytes, type TaxBillOptions } from '@/lib/printer/tax-bill-encoder';
import { buildKotBytes, type KotOptions } from '@/lib/printer/kot-encoder';
import type { PrintWarning } from '@/lib/printer/warnings';
import api from '@/lib/api';
import type { Bill, Tenant, Order } from '@/lib/types';

export type { PrintWarning } from '@/lib/printer/warnings';

type PrintModeType = 'receipt' | 'tax' | 'kot';
type PaperWidth = 58 | 80;

export interface HardwarePrinter {
  id: string;
  name: string;
  connection_type: 'network' | 'usb' | 'webusb';
  ip_address?: string | null;
  port?: number | null;
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
  printBill: (bill: Bill, tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>, opts?: ReceiptOptions) => Promise<PrintWarning[]>;
  printTaxBill: (bill: Bill, tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>, opts?: TaxBillOptions) => Promise<PrintWarning[]>;
  printKot: (order: Order, opts?: KotOptions) => Promise<PrintWarning[]>;
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
            billTaxRegistrationNumber, billAddress, billPhone, billFooterMessage,
            billShowName, billShowAddress, billShowPhone, billShowTaxId,
            billShowTaxBreakdown, billShowCustomerName, billShowCustomerPhone, billShowTableNumber,
            printerPaperSize,
            printerUseUnicode,
            printerTrimDecimals,
          } = usePosSettingsStore.getState();

          const isReprint = opts?.isReprint ?? false;

          const hw = get().hardwarePrinter;
          if (hw && get().printMethod === 'escpos') {
            try {
              const response = await api.post<{ warnings?: PrintWarning[] }>('/printers/print-bill', { billId: bill.id, useUnicode: printerUseUnicode, isReprint });
              return response.data.warnings || [];
            } catch (err: unknown) {
              const e = err as { response?: { data?: { error?: string } }; message?: string };
              throw new Error(e.response?.data?.error || e.message || 'Print failed');
            }
          }

          if (get().printMethod === 'browser') {
            // Browser / A4 print path
            const { printWebBill } = await import('@/lib/printer/web-print');
            printWebBill(bill, tenant, {
              paperSize: printerPaperSize,
              includeTaxId: billShowTaxId,
              taxRegistrationNumber: billShowTaxId && billTaxRegistrationNumber ? billTaxRegistrationNumber : undefined,
              address: billShowAddress && billAddress ? billAddress : undefined,
              phone: billShowPhone && billPhone ? billPhone : undefined,
              footerNote: billFooterMessage || undefined,
              businessName: tenant.business_name,
              showBusinessName: billShowName,
              showTaxBreakdown: billShowTaxBreakdown,
              showCustomerName: billShowCustomerName,
              showCustomerPhone: billShowCustomerPhone,
              showTableNumber: billShowTableNumber,
              useUnicode: printerUseUnicode,
              isReprint,
              trimDecimals: printerTrimDecimals,
            });
            return [];
          }

          // ESC/POS thermal path
          const configuredPaperWidth: PaperWidth = printerPaperSize === 'thermal80' ? 80 : 58;
          const builderOpts: ReceiptOptions = {
            ...opts,
            paperWidth: opts?.paperWidth ?? configuredPaperWidth,
            taxRegistrationNumber: billShowTaxId && billTaxRegistrationNumber ? billTaxRegistrationNumber : undefined,
            address: billShowAddress && billAddress ? billAddress : undefined,
            phone: billShowPhone && billPhone ? billPhone : undefined,
            footerNote: billFooterMessage || undefined,
            showBusinessName: billShowName,
            showTaxBreakdown: billShowTaxBreakdown,
            showCustomerName: billShowCustomerName,
            showCustomerPhone: billShowCustomerPhone,
            showTableNumber: billShowTableNumber,
            useUnicode: printerUseUnicode,
            isReprint,
            trimDecimals: printerTrimDecimals,
          };

          const warnings: PrintWarning[] = [];
          let bytes: Uint8Array;
          if (billTemplate === 'compact') {
            bytes = buildCompactReceiptBytes(bill, tenant, builderOpts, warnings);
          } else {
            bytes = buildClassicReceiptBytes(bill, tenant, builderOpts, warnings);
          }

          set({ lastPrintedBytes: bytes });
          await printerService.print(bytes);
          return warnings;
        } catch (err) {
          set({ lastError: (err as Error).message });
          throw err;
        }
      },

      printTaxBill: async (bill, tenant, opts) => {
        set({ lastError: null });
        try {
          const {
            printerUseUnicode, printerTrimDecimals, printerPaperSize,
            billTaxRegistrationNumber, billAddress, billPhone, billFooterMessage,
            billShowName, billShowAddress, billShowPhone, billShowTaxId,
            billShowTaxBreakdown, billShowCustomerName, billShowCustomerPhone, billShowTableNumber,
          } = usePosSettingsStore.getState();
          const configuredPaperWidth: PaperWidth = printerPaperSize === 'thermal80' ? 80 : 58;

          if (get().printMethod === 'browser') {
            // Browser / A4 print path: render real HTML instead of decoding
            // raw ESC/POS bytes (which would strip Persian digits/ریال to
            // printer ASCII). Mirrors the printBill browser path.
            const { printWebBill } = await import('@/lib/printer/web-print');
            printWebBill(bill, tenant, {
              paperSize: printerPaperSize,
              includeTaxId: billShowTaxId,
              taxRegistrationNumber: billShowTaxId
                ? (opts?.taxRegistrationNumber || billTaxRegistrationNumber || undefined)
                : undefined,
              address: billShowAddress ? (opts?.address || billAddress || undefined) : undefined,
              phone: billShowPhone ? (opts?.phone || billPhone || undefined) : undefined,
              footerNote: billFooterMessage || undefined,
              businessName: tenant.business_name,
              showBusinessName: billShowName,
              showTaxBreakdown: billShowTaxBreakdown,
              showCustomerName: billShowCustomerName,
              showCustomerPhone: billShowCustomerPhone,
              showTableNumber: billShowTableNumber,
              useUnicode: printerUseUnicode,
              trimDecimals: printerTrimDecimals,
            });
            return [];
          }

          const warnings: PrintWarning[] = [];
          const bytes = buildTaxBillBytes(bill, tenant, {
            ...opts,
            paperWidth: opts?.paperWidth ?? configuredPaperWidth,
            taxRegistrationNumber: billShowTaxId
              ? (opts?.taxRegistrationNumber || billTaxRegistrationNumber || undefined)
              : undefined,
            address: billShowAddress ? (opts?.address || billAddress || undefined) : undefined,
            phone: billShowPhone ? (opts?.phone || billPhone || undefined) : undefined,
            showBusinessName: billShowName,
            showTaxBreakdown: billShowTaxBreakdown,
            showCustomerName: billShowCustomerName,
            showCustomerPhone: billShowCustomerPhone,
            showTableNumber: billShowTableNumber,
            useUnicode: printerUseUnicode,
            trimDecimals: printerTrimDecimals,
            rawEscPos: true,
          }, warnings);
          set({ lastPrintedBytes: bytes });
          await printerService.print(bytes);
          return warnings;
        } catch (err) {
          set({ lastError: (err as Error).message });
          throw err;
        }
      },

      printKot: async (order, opts) => {
        set({ lastError: null });
        // Single choke point for every KOT print path (auto + manual): when
        // kot_printing_enabled is off, no KOT print command may ever go out
        // (issue #133) — coarser than auto_print_kot, which only gates
        // automatic printing on order placement.
        const { kotPrintingEnabled, printerUseUnicode } = usePosSettingsStore.getState();
        if (!kotPrintingEnabled) {
          const err = new Error('KOT printing is disabled for this business');
          set({ lastError: err.message });
          throw err;
        }
        try {
          const hw = get().hardwarePrinter;
          if (hw && get().printMethod === 'escpos') {
            try {
              const response = await api.post<{ warnings?: PrintWarning[] }>('/printers/print-kot', { orderId: order.id, useUnicode: printerUseUnicode });
              return response.data.warnings || [];
            } catch (err: unknown) {
              const e = err as { response?: { data?: { error?: string } }; message?: string };
              throw new Error(e.response?.data?.error || e.message || 'KOT print failed');
            }
          }

          const { paperWidth } = get();
          const warnings: PrintWarning[] = [];
          const bytes = buildKotBytes(order, { ...opts, paperWidth }, warnings);
          set({ lastPrintedBytes: bytes });

          if (get().printMethod === 'escpos') {
            await printerService.print(bytes);
          } else {
            const paperWidth = get().paperWidth || 80;
            const html = `<html><body style="font-family:monospace;white-space:pre;padding:10px;">${new TextDecoder().decode(bytes)}</body></html>`;
            await printerService.printViaBrowser(html, paperWidth);
          }
          return warnings;
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
      // v1: the 'gst' print-mode value was renamed to 'tax'. Carry existing
      // browsers' saved selection forward instead of silently resetting it.
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as { printMode?: string };
        if (version < 1 && state.printMode === 'gst') {
          state.printMode = 'tax';
        }
        return state as unknown as PrinterState;
      },
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
