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
import { useAuthStore } from '@/store/auth';
import {
  ensurePrintLanguagesLoaded,
  resolveBillPrintLanguages,
  buildFrontendBillDocument,
  buildFrontendKotDocument,
} from '@/lib/printer/print-document';
import { buildTaxBillBytes, type TaxBillOptions } from '@/lib/printer/tax-bill-encoder';
import { buildKotBytes, type KotOptions } from '@/lib/printer/kot-encoder';
import {
  hasFinancialPrintWarning,
  makeBillTemplateFallbackWarning,
  makeFinancialPrintRefusalMessage,
  type PrintWarning,
} from '@/lib/printer/warnings';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import type { Bill, Tenant, Order, OrderItem } from '@/lib/types';
import { type Language } from '@/lib/i18n/languages';
import type { ThermalPrinterCapabilities } from '@print/thermal-capabilities';
import { rasterWebUsbPathEnabled } from '@print/raster';
import { getCountryByCode, getCurrencySymbol, resolveTenantCurrency } from '@/lib/countries';

type CoreBillTemplate = 'classic' | 'compact';

function makeRasterFallbackWarning(detail: unknown): PrintWarning {
  const message = detail instanceof Error
    ? detail.message
    : (typeof detail === 'string' && detail.length > 0 ? detail : 'Raster rendering failed');
  const financial = message.startsWith('Receipt not printed:');
  return {
    field: financial ? 'financial row' : 'raster renderer',
    text: '',
    message: `${message}. Native thermal output was used instead.`,
    kind: financial ? 'financial' : 'configuration',
  };
}

function resolveCoreBillTemplate(value: unknown, source: 'core' | 'pack' | 'merchant' | null): CoreBillTemplate | null {
  if (source !== 'core') return null;
  if (value === 'classic' || value === 'compact') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const selection = JSON.parse(trimmed) as { source?: unknown; id?: unknown };
    return selection.source === 'core' && (selection.id === 'classic' || selection.id === 'compact')
      ? selection.id
      : null;
  } catch {
    return null;
  }
}

export type { PrintWarning } from '@/lib/printer/warnings';

type PrintModeType = 'receipt' | 'tax' | 'kot';
type PaperWidth = 58 | 80;

/** Tenant fields a browser/thermal receipt needs for locale-correct rendering. */
type ReceiptTenant = Pick<
  Tenant,
  'business_name' | 'currency' | 'country' | 'timezone' | 'currency_display' | 'number_digits' | 'calendar'
>;

export interface HardwarePrinter {
  id: string;
  name: string;
  connection_type: 'network' | 'usb' | 'webusb';
  ip_address?: string | null;
  port?: number | null;
  paper_width?: string | null;
  is_default: number;
  profile_id?: string;
  capabilities?: ThermalPrinterCapabilities;
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
  webusbPrinter: HardwarePrinter | null;
  refreshHardwarePrinter: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  printBill: (bill: Bill, tenant: ReceiptTenant, opts?: ReceiptOptions) => Promise<PrintWarning[]>;
  printTaxBill: (bill: Bill, tenant: ReceiptTenant, opts?: TaxBillOptions) => Promise<PrintWarning[]>;
  printKot: (order: Order, opts?: KotOptions & { items?: OrderItem[] }) => Promise<PrintWarning[]>;
  setPrintMode: (mode: PrintModeType) => void;
  setPaperWidth: (width: PaperWidth) => void;
  setPrintMethod: (method: PrintMode) => void;
  clearError: () => void;
  downloadLastReceipt: () => void;
  copyLastReceiptHex: () => Promise<void>;
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
      webusbPrinter: null,

      refreshHardwarePrinter: async () => {
        try {
          const res = await api.get('/printers');
          const list: HardwarePrinter[] = res.data.printers || [];
          const defaultPrinter =
            list.find((p) => p.is_default === 1 && p.connection_type !== 'webusb') ||
            list.find((p) => p.connection_type !== 'webusb') ||
            null;
          const webusbPrinters = list.filter((p) => p.connection_type === 'webusb');
          const webusbPrinter = webusbPrinters.length === 1 ? webusbPrinters[0] : null;
          set({ hardwarePrinter: defaultPrinter, webusbPrinter });
        } catch {
          set({ hardwarePrinter: null, webusbPrinter: null });
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
            billTemplateSource,
            billTaxRegistrationNumber, billAddress, billPhone, billFooterMessage,
            billShowName, billShowAddress, billShowPhone, billShowTaxId,
            billShowTaxBreakdown, billShowCustomerName, billShowCustomerPhone, billShowTableNumber,
            printerPaperSize,
            printerUseUnicode,
            printerArabicShaping,
            printerTrimDecimals,
          } = usePosSettingsStore.getState();

          const isReprint = opts?.isReprint ?? false;
          const billTemplateWarning = billTemplateSource === 'core'
            ? null
            : makeBillTemplateFallbackWarning({ source: billTemplateSource ?? 'unknown', id: billTemplate });
          const rasterBillTemplate = resolveCoreBillTemplate(billTemplate, billTemplateSource);

          const executeBrowserPrint = async (): Promise<PrintWarning[]> => {
            const { printWebBill } = await import('@/lib/printer/web-print');
            const browserWarnings = await printWebBill(bill, tenant, {
              paperSize: printerPaperSize,
              languages: opts?.languages ?? resolveBillPrintLanguages(),
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
            return billTemplateWarning ? [...browserWarnings, billTemplateWarning] : browserWarnings;
          };

          const hw = get().hardwarePrinter;
          if (hw && get().printMethod === 'escpos') {
            try {
              const response = await api.post<{ warnings?: PrintWarning[] }>('/printers/print-bill', { billId: bill.id, useUnicode: printerUseUnicode, arabicShaping: printerArabicShaping, isReprint });
              return response.data.warnings || [];
            } catch (err: unknown) {
              const e = err as { response?: { data?: { error?: string } }; message?: string };
              const errorMsg = e.response?.data?.error || e.message || 'Print failed';
              if (errorMsg.includes('No default printer configured')) {
                toast('No thermal printer configured — printing via system print', { icon: 'ℹ️' });
                return await executeBrowserPrint();
              }
              if (errorMsg.startsWith('Receipt not printed:')) toast.error(errorMsg);
              throw new Error(errorMsg);
            }
          }

          // A silent reconnect kicked off at app startup may still be in
          // flight (e.g. a print triggered moments after launch) — wait for
          // it to settle before trusting isConnected, or a printer that's
          // about to reattach would wrongly fall back to browser print.
          await printerService.awaitPendingReconnect();

          if (get().printMethod === 'browser' || (!hw && !printerService.isConnected && get().printMethod === 'escpos')) {
            if (!hw && !printerService.isConnected && get().printMethod === 'escpos') {
              toast('No thermal printer configured — printing via system print', { icon: 'ℹ️' });
            }
            return await executeBrowserPrint();
          }

          // ESC/POS thermal path — labels are resolved from the receipt
          // language policy through the shared PrintDocument (#444), so the
          // requested language bundles must be in memory first.
          const configuredPaperWidth: PaperWidth = printerPaperSize === 'thermal80' ? 80 : 58;
          const languages = opts?.languages ?? resolveBillPrintLanguages();
          const failedLanguages = await ensurePrintLanguagesLoaded(languages);
          // A locale bundle that failed to load degrades to English labels;
          // surface that through the established warning path (Greptile P1).
          const warnings: PrintWarning[] = failedLanguages.map((language) => ({
            field: 'receipt language',
            text: language,
            message: `Receipt language "${language}" could not be loaded, so English labels were used.`,
            kind: 'locale' as const,
          }));
          if (billTemplateWarning) warnings.push(billTemplateWarning);
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
            arabicShaping: printerArabicShaping,
            isReprint,
            trimDecimals: printerTrimDecimals,
            languages,
            capabilities: get().webusbPrinter?.capabilities,
          };

          let bytes: Uint8Array;
          const encoderWarnings: PrintWarning[] = [];
          const nativeBillTemplate = rasterBillTemplate
            ?? (billTemplateSource === 'core' && (billTemplate === 'compact' || billTemplate === 'classic') ? billTemplate : 'classic');
          if (nativeBillTemplate === 'compact') {
            bytes = buildCompactReceiptBytes(bill, tenant, builderOpts, encoderWarnings);
          } else {
            bytes = buildClassicReceiptBytes(bill, tenant, builderOpts, encoderWarnings);
          }

          const webusbPrinter = get().webusbPrinter;
          const webusbCapabilities = webusbPrinter?.capabilities;
          if (rasterBillTemplate && rasterWebUsbPathEnabled(webusbCapabilities, Boolean(window.electronAPI?.rasterizePrintDocument), webusbPrinter?.profile_id)) {
            try {
              const currency = resolveTenantCurrency(tenant.currency, tenant.country);
              const rasterResult = await window.electronAPI.rasterizePrintDocument({
                document: buildFrontendBillDocument(bill, tenant, {
                  ...builderOpts,
                  columns: builderOpts.paperWidth === 80 ? 48 : 42,
                  businessName: tenant.business_name,
                  includeTaxId: billShowTaxId,
                  taxIdLabel: getCountryByCode(tenant.country ?? 'IN')?.taxIdLabel ?? 'Tax ID',
                  maskCustomerPhone: true,
                  useBillCustomer: true,
                }),
                template: rasterBillTemplate,
                profileId: webusbPrinter.profile_id,
                options: {
                  columns: builderOpts.paperWidth === 80 ? 48 : 42,
                  language: languages[0],
                  locale: getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US',
                  currency,
                  currencySymbol: getCurrencySymbol(currency, getCountryByCode(tenant.country ?? 'IN')?.locale),
                  trimDecimals: printerTrimDecimals,
                  useUnicode: printerUseUnicode,
                  arabicShaping: printerArabicShaping,
                  ...(tenant.timezone ? { timezone: tenant.timezone } : {}),
                },
              });
              if (!rasterResult.ok || !rasterResult.data) {
                warnings.push(makeRasterFallbackWarning(rasterResult.ok ? undefined : rasterResult.error));
                warnings.push(...encoderWarnings);
              } else {
                if (rasterResult.warnings) warnings.push(...rasterResult.warnings as PrintWarning[]);
                if (rasterResult.rasterSelected || (rasterResult.warnings?.length ?? 0) > 0) {
                  bytes = Uint8Array.from(rasterResult.data);
                } else {
                  warnings.push(...encoderWarnings);
                }
              }
            } catch (error) {
              warnings.push(makeRasterFallbackWarning(error));
              warnings.push(...encoderWarnings);
            }
          } else {
            warnings.push(...encoderWarnings);
          }

          if (hasFinancialPrintWarning(warnings)) {
            const refusal = makeFinancialPrintRefusalMessage(warnings);
            toast.error(refusal);
            throw new Error(refusal);
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
            printerUseUnicode, printerArabicShaping, printerTrimDecimals, printerPaperSize,
            billTaxRegistrationNumber, billAddress, billPhone, billFooterMessage,
            billShowName, billShowAddress, billShowPhone, billShowTaxId,
            billShowTaxBreakdown, billShowCustomerName, billShowCustomerPhone, billShowTableNumber,
          } = usePosSettingsStore.getState();
          const configuredPaperWidth: PaperWidth = printerPaperSize === 'thermal80' ? 80 : 58;
          const languages = opts?.language
            ? [opts.language as Language] as const
            : resolveBillPrintLanguages();

          // No backend route exists for tax-bill printing, so this path only
          // has the WebUSB transport for 'escpos' — unlike printBill/printKot,
          // it can't fall back to a backend hardware printer. Without a
          // connected WebUSB device it must fall back to browser print
          // instead of throwing "Printer is not connected" (issue #534).
          // A startup silent-reconnect attempt may still be in flight — wait
          // for it to settle before trusting isConnected.
          await printerService.awaitPendingReconnect();
          const noThermalTransport = !printerService.isConnected && get().printMethod === 'escpos';
          if (get().printMethod === 'browser' || noThermalTransport) {
            if (noThermalTransport) {
              toast('No thermal printer connected — printing via system print', { icon: 'ℹ️' });
            }
            // Browser / A4 print path: render real HTML instead of decoding
            // raw ESC/POS bytes (which would strip Persian digits/ریال to
            // printer ASCII). Mirrors the printBill browser path.
            const { printWebBill } = await import('@/lib/printer/web-print');
            const browserWarnings = await printWebBill(bill, tenant, {
              paperSize: printerPaperSize,
              languages,
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
            return browserWarnings;
          }

          const failedLanguages = await ensurePrintLanguagesLoaded(languages);
          const warnings: PrintWarning[] = failedLanguages.map((language) => ({
            field: 'receipt language',
            text: language,
            message: `Receipt language "${language}" could not be loaded, so English labels were used.`,
            kind: 'locale' as const,
          }));
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
            arabicShaping: printerArabicShaping,
            trimDecimals: printerTrimDecimals,
            rawEscPos: true,
            language: languages[0],
            capabilities: get().webusbPrinter?.capabilities,
          }, warnings);
          if (hasFinancialPrintWarning(warnings)) {
            const refusal = makeFinancialPrintRefusalMessage(warnings);
            toast.error(refusal);
            throw new Error(refusal);
          }
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
        const { kotPrintingEnabled, printerUseUnicode, printerArabicShaping } = usePosSettingsStore.getState();
        const tenant = useAuthStore.getState().currentTenant;
        const tenantTimezone = tenant?.timezone;
        const tenantLocale = getCountryByCode(tenant?.country ?? 'IN')?.locale ?? 'en-US';
        if (!kotPrintingEnabled) {
          const err = new Error('KOT printing is disabled for this business');
          set({ lastError: err.message });
          throw err;
        }
        try {
          const hw = get().hardwarePrinter;
          if (hw && get().printMethod === 'escpos') {
            try {
              const response = await api.post<{ warnings?: PrintWarning[] }>('/printers/print-kot', { orderId: order.id, items: opts?.items, stationName: opts?.stationName, useUnicode: printerUseUnicode, arabicShaping: printerArabicShaping });
              return response.data.warnings || [];
            } catch (err: unknown) {
              const e = err as { response?: { data?: { error?: string } }; message?: string };
              throw new Error(e.response?.data?.error || e.message || 'KOT print failed');
            }
          }

          const orderForPrint = opts?.items ? { ...order, items: opts.items } : order;
          const { resolveKotTicketLanguage } = await import('@/lib/printer/kot-web-print');
          const kotLanguage = resolveKotTicketLanguage();
          const failedLanguages = await ensurePrintLanguagesLoaded([kotLanguage]);

          // A startup silent-reconnect attempt may still be in flight (e.g.
          // KOT auto-print firing on the first order right after launch) —
          // wait for it to settle before trusting isConnected.
          await printerService.awaitPendingReconnect();
          if (get().printMethod === 'escpos' && printerService.isConnected) {
            const { paperWidth } = get();
            const warnings: PrintWarning[] = [];
            const encoderWarnings: PrintWarning[] = [];
            const bytes = buildKotBytes(
              orderForPrint,
              { ...opts, paperWidth, stationName: opts?.stationName, arabicShaping: printerArabicShaping, language: kotLanguage, timezone: tenantTimezone ?? opts?.timezone, capabilities: get().webusbPrinter?.capabilities },
              encoderWarnings,
            );
            const webusbPrinter = get().webusbPrinter;
            const webusbCapabilities = webusbPrinter?.capabilities;
            let output = bytes;
            if (rasterWebUsbPathEnabled(webusbCapabilities, Boolean(window.electronAPI?.rasterizeKotDocument), webusbPrinter?.profile_id)) {
              try {
                let rasterOrder = orderForPrint;
                if (orderForPrint.table_id || orderForPrint.customer_id) {
                  const response = await api.get<{ order: Order }>(`/orders/${orderForPrint.id}`);
                  rasterOrder = orderForPrint.items
                    ? { ...response.data.order, items: orderForPrint.items }
                    : response.data.order;
                }
                const rasterResult = await window.electronAPI.rasterizeKotDocument({
                  document: buildFrontendKotDocument(rasterOrder, {
                    items: rasterOrder.items,
                    stationName: opts?.stationName ?? 'Kitchen',
                    columns: paperWidth === 80 ? 48 : 42,
                    language: kotLanguage,
                    ...(tenantTimezone ?? opts?.timezone ? { timezone: tenantTimezone ?? opts?.timezone } : {}),
                  }),
                  profileId: webusbPrinter.profile_id,
                  options: {
                    columns: paperWidth === 80 ? 48 : 42,
                    language: kotLanguage,
                    locale: tenantLocale,
                    ...(tenantTimezone ?? opts?.timezone ? { timezone: tenantTimezone ?? opts?.timezone } : {}),
                    useUnicode: printerUseUnicode,
                    arabicShaping: printerArabicShaping,
                  },
                });
                if (!rasterResult.ok || !rasterResult.data) {
                  warnings.push(makeRasterFallbackWarning(rasterResult.ok ? undefined : rasterResult.error));
                  warnings.push(...encoderWarnings);
                } else {
                  if (rasterResult.warnings) warnings.push(...rasterResult.warnings as PrintWarning[]);
                  if (rasterResult.rasterSelected || (rasterResult.warnings?.length ?? 0) > 0) {
                    output = Uint8Array.from(rasterResult.data);
                  } else {
                    warnings.push(...encoderWarnings);
                  }
                }
              } catch (error) {
                warnings.push(makeRasterFallbackWarning(error));
                warnings.push(...encoderWarnings);
              }
            } else {
              warnings.push(...encoderWarnings);
            }
            set({ lastPrintedBytes: output });
            await printerService.print(output);
            return [
              ...failedLanguages.map((language) => ({
                field: 'kot language',
                text: language,
                message: `KOT language "${language}" could not be loaded, so English labels were used.`,
                kind: 'locale' as const,
              })),
              ...warnings,
            ] as PrintWarning[];
          }

          // Browser fallback: no backend hardware printer and no WebUSB
          // device connected — render semantic KOT HTML instead of decoding
          // raw ESC/POS bytes (#444). The ticket is built from the order's
          // fields with resolved labels and kernel direction annotations.
          // Greptile P1 (PR #474): when a fixed KOT language differs from the
          // active UI language after a cold start, its message bundle is not
          // in the loader cache yet - load it before generating so labels
          // don't silently fall back to English.
          const paperWidth = (get().paperWidth || 80) === 80 ? 80 : 58;
          const { generateKotHtml } = await import('@/lib/printer/kot-web-print');
          const html = generateKotHtml(orderForPrint, { paperWidth, language: kotLanguage, stationName: opts?.stationName ?? 'Kitchen', timezone: tenantTimezone ?? opts?.timezone });
          await printerService.printViaBrowser(html, paperWidth);
          // A failed locale load degrades to English labels; surface it
          // through the established warning path instead of staying silent
          // (Greptile P1, PR #474).
          return failedLanguages.map((language) => ({
            field: 'kot language',
            text: language,
            message: `KOT language "${language}" could not be loaded, so English labels were used.`,
            kind: 'locale' as const,
          })) as PrintWarning[];
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
    // Best-effort: re-attach to a WebUSB printer the user already granted
    // permission for, so a reload/relaunch doesn't require re-clicking
    // Connect before the next print (see issue #534).
    printerService.tryReconnect();

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
