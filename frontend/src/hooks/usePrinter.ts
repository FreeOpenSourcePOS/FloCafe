'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  printerService,
  type PrinterStatus,
  type PrinterInfo,
  type PrintMode,
} from '@/lib/printer/PrinterService';
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
  buildDeliverySlipBytes,
  type DeliverySlipContact,
  type DeliverySlipPayment,
  type DeliverySlipWebUsbOptions,
} from '@/lib/printer/delivery-slip-encoder';
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
import {
  GENERIC_THERMAL_CAPABILITIES,
  type ThermalPrinterCapabilities,
} from '@print/thermal-capabilities';
import { DEFAULT_RASTER_MAX_BAND_HEIGHT, rasterWebUsbPathEnabled } from '@print/raster';
import {
  layoutColumnsForTextSize,
  normalizePrinterTextSize,
  type PrinterTextSize,
} from '@print/text-size';
import { columnsForConfiguredPrinter } from '@print/width';
import {
  ensureReceiptSettingsLoaded,
  PrintCancelledOnTenantChangeError,
  isPrintCancelledOnTenantChangeError,
} from '@/hooks/useReceiptSettingsSync';
import { getCountryByCode, getCurrencySymbol, resolveTenantCurrency } from '@/lib/countries';
import { PrinterOperationError, toPrinterOperationError } from '@/lib/operation-failure';

export {
  PrintCancelledOnTenantChangeError,
  isPrintCancelledOnTenantChangeError,
  PrinterOperationError,
  toPrinterOperationError,
};

type CoreBillTemplate = 'classic' | 'compact';

function nativeFallbackCapabilities(
  capabilities?: ThermalPrinterCapabilities,
): ThermalPrinterCapabilities | undefined {
  return capabilities?.raster.enabled === true
    ? { ...capabilities, raster: { ...capabilities.raster, enabled: false } }
    : capabilities;
}

export function defaultWebUsbCapabilities(
  paperWidth: PaperWidth,
  configuredPaperWidth?: string | null,
  configuredTextSize?: unknown,
): ThermalPrinterCapabilities {
  const cols = columnsForConfiguredPrinter(configuredPaperWidth, paperWidth);
  const widthDots = cols <= 32 ? 384 : cols <= 36 ? 432 : cols <= 40 ? 480 : 576;
  const textSize = normalizePrinterTextSize(configuredTextSize);
  return {
    ...GENERIC_THERMAL_CAPABILITIES,
    textSize,
    raster: {
      enabled: true,
      widthDots,
      maxBandHeight: DEFAULT_RASTER_MAX_BAND_HEIGHT,
      modes: ['mixed', 'whole-receipt'],
    },
  };
}

export function resolveWebUsbCapabilities(
  webusbPrinter: HardwarePrinter | null,
  paperWidth: PaperWidth,
  fallbackTextSize?: unknown,
): ThermalPrinterCapabilities {
  const textSize = normalizePrinterTextSize(
    webusbPrinter?.text_size ?? webusbPrinter?.capabilities?.textSize ?? fallbackTextSize,
  );
  if (webusbPrinter?.capabilities) {
    return {
      ...webusbPrinter.capabilities,
      textSize,
    };
  }
  return defaultWebUsbCapabilities(paperWidth, webusbPrinter?.paper_width, textSize);
}

export function resolveActivePrinterTextSize(
  state: Pick<PrinterState, 'defaultPrinter' | 'hardwarePrinter' | 'webusbPrinter'> &
    Partial<Pick<PrinterState, 'status' | 'deviceInfo' | 'printMethod'>>,
  override?: unknown,
): PrinterTextSize {
  if (override !== undefined) return normalizePrinterTextSize(override);
  const webusbConnected =
    state.status === 'connected' || Boolean(state.deviceInfo) || printerService.isConnected;
  const printer =
    webusbConnected && state.webusbPrinter
      ? state.webusbPrinter
      : state.printMethod === 'escpos' && state.hardwarePrinter
        ? state.hardwarePrinter
        : (state.webusbPrinter ?? state.defaultPrinter ?? state.hardwarePrinter);
  return normalizePrinterTextSize(printer?.text_size ?? printer?.capabilities?.textSize);
}

function makeRasterFallbackWarning(detail: unknown): PrintWarning {
  const message =
    detail instanceof Error
      ? detail.message
      : typeof detail === 'string' && detail.length > 0
        ? detail
        : 'Raster rendering failed';
  const financial = message.startsWith('Receipt not printed:');
  return {
    field: financial ? 'financial row' : 'raster renderer',
    text: '',
    message: `${message}. Native thermal output was used instead.`,
    kind: financial ? 'financial' : 'configuration',
  };
}

function resolveCoreBillTemplate(
  value: unknown,
  source: 'core' | 'pack' | 'merchant' | null,
): CoreBillTemplate | null {
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
  | 'business_name'
  | 'currency'
  | 'country'
  | 'timezone'
  | 'currency_display'
  | 'number_digits'
  | 'calendar'
>;

export interface HardwarePrinter {
  id: string;
  name: string;
  connection_type: 'network' | 'usb' | 'webusb';
  ip_address?: string | null;
  port?: number | null;
  paper_width?: string | null;
  text_size?: PrinterTextSize | null;
  is_default: number;
  readiness_state?: 'configured';
  configured_profile_id?: string | null;
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
  defaultPrinter: HardwarePrinter | null;
  refreshHardwarePrinter: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  printBill: (
    bill: Bill,
    tenant: ReceiptTenant,
    opts?: ReceiptOptions,
    reservedWindow?: Window | null,
  ) => Promise<PrintWarning[]>;
  printTaxBill: (
    bill: Bill,
    tenant: ReceiptTenant,
    opts?: TaxBillOptions,
  ) => Promise<PrintWarning[]>;
  printKot: (order: Order, opts?: KotOptions & { items?: OrderItem[] }) => Promise<PrintWarning[]>;
  printDeliverySlip: (
    order: Order,
    contact: DeliverySlipContact,
    opts?: DeliverySlipWebUsbOptions,
  ) => Promise<PrintWarning[]>;
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
      defaultPrinter: null,

      refreshHardwarePrinter: async () => {
        try {
          const res = await api.get('/printers');
          const list: HardwarePrinter[] = (res.data.printers || []).map(
            (printer: HardwarePrinter) => ({ ...printer, readiness_state: 'configured' }),
          );
          const defaultPrinter =
            list.find((p) => p.is_default === 1 && p.connection_type !== 'webusb') ||
            list.find((p) => p.connection_type !== 'webusb') ||
            null;
          const webusbPrinters = list.filter((p) => p.connection_type === 'webusb');
          const connectedProductName = printerService.deviceInfo?.productName?.trim().toLowerCase();
          const webusbPrinter =
            (connectedProductName
              ? webusbPrinters.find((p) => p.name.trim().toLowerCase() === connectedProductName)
              : undefined) ||
            webusbPrinters.find((p) => p.is_default === 1) ||
            (webusbPrinters.length === 1 ? webusbPrinters[0] : null);
          const configuredDefault = list.find((p) => p.is_default === 1) || null;
          set({
            hardwarePrinter: defaultPrinter,
            webusbPrinter,
            defaultPrinter: configuredDefault,
          });
        } catch {
          set({ hardwarePrinter: null, webusbPrinter: null, defaultPrinter: null });
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

      printBill: async (bill, tenant, opts, reservedWindow) => {
        set({ lastError: null });
        let windowTransferred = false;
        let activeConnectionType = 'unknown';
        const authTenantIdAtStart = useAuthStore.getState().currentTenant?.id ?? null;
        const isSameTenant = () =>
          (useAuthStore.getState().currentTenant?.id ?? null) === authTenantIdAtStart;
        const throwIfTenantChanged = (): void => {
          if (isSameTenant()) return;
          if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
          windowTransferred = true;
          throw new PrintCancelledOnTenantChangeError();
        };
        try {
          const readyForTenant = await ensureReceiptSettingsLoaded(authTenantIdAtStart).catch(() =>
            isSameTenant(),
          );
          if (!readyForTenant) {
            if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
            windowTransferred = true;
            throw new PrintCancelledOnTenantChangeError();
          }
          throwIfTenantChanged();
          const {
            billTemplate,
            billTemplateSource,
            billTaxRegistrationNumber,
            billAddress,
            billPhone,
            billFooterMessage,
            receiptLogo,
            receiptLogoRaster,
            billShowLogo,
            billShowName,
            billShowAddress,
            billShowPhone,
            billShowTaxId,
            billShowTaxBreakdown,
            billShowCustomerName,
            billShowCustomerPhone,
            billDeliveryShowCustomerPhoneAlways,
            billShowTableNumber,
            billShowLargeOrderNumber,
            printerPaperSize,
            printerUseUnicode,
            printerArabicShaping,
            printerTrimDecimals,
          } = usePosSettingsStore.getState();

          const configuredPaperWidth: PaperWidth = printerPaperSize === 'thermal80' ? 80 : 58;
          // One width for every path this bill can take. The byte encoders, the
          // raster document, and the browser page all render the same bill, so
          // they resolve the configured printer once rather than each guessing.
          const billColumns = columnsForConfiguredPrinter(
            (get().webusbPrinter ?? get().hardwarePrinter)?.paper_width,
            configuredPaperWidth,
          );
          const activeTextSize = resolveActivePrinterTextSize(get(), opts?.capabilities?.textSize);

          const isReprint = opts?.isReprint ?? false;
          const isUnknownCoreTemplate =
            billTemplateSource === null &&
            (billTemplate === 'compact' || billTemplate === 'classic');
          const billTemplateWarning =
            billTemplateSource === 'core' || isUnknownCoreTemplate
              ? null
              : makeBillTemplateFallbackWarning({
                  source: billTemplateSource ?? 'unknown',
                  id: billTemplate,
                });
          const rasterBillTemplate = resolveCoreBillTemplate(billTemplate, billTemplateSource);

          const executeBrowserPrint = async (): Promise<PrintWarning[]> => {
            const { printWebBill } = await import('@/lib/printer/web-print');
            throwIfTenantChanged();
            windowTransferred = true;
            const browserWarnings = await printWebBill(
              bill,
              tenant,
              {
                paperSize: printerPaperSize,
                textSize: activeTextSize,
                columns: billColumns,
                languages: opts?.languages ?? resolveBillPrintLanguages(),
                includeTaxId: billShowTaxId,
                taxRegistrationNumber:
                  billShowTaxId && billTaxRegistrationNumber
                    ? billTaxRegistrationNumber
                    : undefined,
                address: billShowAddress && billAddress ? billAddress : undefined,
                phone: billShowPhone && billPhone ? billPhone : undefined,
                footerNote: billFooterMessage || undefined,
                businessName: tenant.business_name,
                showBusinessName: billShowName,
                showLogo: billShowLogo,
                receiptLogo: billShowLogo ? receiptLogo : undefined,
                receiptLogoRaster: billShowLogo ? receiptLogoRaster : undefined,
                showTaxBreakdown: billShowTaxBreakdown,
                showCustomerName: billShowCustomerName,
                showCustomerPhone: billShowCustomerPhone,
                deliveryShowCustomerPhoneAlways: billDeliveryShowCustomerPhoneAlways,
                showTableNumber: billShowTableNumber,
                showLargeOrderNumber: opts?.showLargeOrderNumber ?? billShowLargeOrderNumber,
                useUnicode: printerUseUnicode,
                isReprint,
                trimDecimals: printerTrimDecimals,
              },
              reservedWindow,
            );
            return billTemplateWarning
              ? [...browserWarnings, billTemplateWarning]
              : browserWarnings;
          };

          const hw = get().hardwarePrinter;
          if (hw && get().printMethod === 'escpos') {
            try {
              const response = await api.post<{ warnings?: PrintWarning[] }>(
                '/printers/print-bill',
                {
                  billId: bill.id,
                  useUnicode: printerUseUnicode,
                  arabicShaping: printerArabicShaping,
                  isReprint,
                },
              );
              if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
              windowTransferred = true;
              return response.data.warnings || [];
            } catch (err: unknown) {
              if (isPrintCancelledOnTenantChangeError(err)) throw err;
              throwIfTenantChanged();
              const e = err as {
                response?: { data?: { error?: string; detail?: string } };
                message?: string;
              };
              const errorMsg =
                e.response?.data?.detail || e.response?.data?.error || e.message || 'Print failed';
              if (errorMsg.includes('No default printer configured')) {
                toast('No thermal printer configured — printing via system print', { icon: 'ℹ️' });
                return await executeBrowserPrint();
              }
              throw toPrinterOperationError(err, {
                kind: 'receipt',
                connectionType: hw.connection_type,
                stage: 'dispatch',
                fallbackDetail: 'Print failed',
              });
            }
          }

          // Await startup silent reconnect before checking isConnected
          // to avoid premature browser print fallbacks.
          await printerService.awaitPendingReconnect();
          throwIfTenantChanged();

          if (
            get().printMethod === 'browser' ||
            (!hw && !printerService.isConnected && get().printMethod === 'escpos')
          ) {
            if (!hw && !printerService.isConnected && get().printMethod === 'escpos') {
              toast('No thermal printer configured — printing via system print', { icon: 'ℹ️' });
            }
            return await executeBrowserPrint();
          }

          if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
          windowTransferred = true;
          activeConnectionType = 'webusb';

          // ESC/POS thermal path: load requested language bundles before resolving labels.
          const languages = opts?.languages ?? resolveBillPrintLanguages();
          const failedLanguages = await ensurePrintLanguagesLoaded(languages);
          throwIfTenantChanged();
          // Surface failed locale loads as warnings when labels fall back to English.
          const warnings: PrintWarning[] = failedLanguages.map((language) => ({
            field: 'receipt language',
            text: language,
            message: `Receipt language "${language}" could not be loaded, so English labels were used.`,
            kind: 'locale' as const,
          }));
          if (billTemplateWarning) warnings.push(billTemplateWarning);
          const webusbPrinter = get().webusbPrinter;
          const webusbCapabilities =
            opts?.capabilities ??
            resolveWebUsbCapabilities(
              webusbPrinter,
              opts?.paperWidth ?? configuredPaperWidth,
              activeTextSize,
            );
          const rasterizePrintDocument = window.electronAPI?.rasterizePrintDocument;
          const useElectronRaster = Boolean(
            rasterBillTemplate &&
            webusbPrinter &&
            rasterizePrintDocument &&
            rasterWebUsbPathEnabled(webusbPrinter.capabilities, true, webusbPrinter.profile_id),
          );
          const builderOpts: ReceiptOptions = {
            ...opts,
            paperWidth: opts?.paperWidth ?? configuredPaperWidth,
            columns: billColumns,
            taxRegistrationNumber:
              billShowTaxId && billTaxRegistrationNumber ? billTaxRegistrationNumber : undefined,
            address: billShowAddress && billAddress ? billAddress : undefined,
            phone: billShowPhone && billPhone ? billPhone : undefined,
            footerNote: billFooterMessage || undefined,
            showBusinessName: billShowName,
            showLogo: billShowLogo,
            receiptLogo: billShowLogo ? receiptLogo : undefined,
            receiptLogoRaster: billShowLogo ? receiptLogoRaster : undefined,
            showTaxBreakdown: billShowTaxBreakdown,
            showCustomerName: billShowCustomerName,
            showCustomerPhone: billShowCustomerPhone,
            deliveryShowCustomerPhoneAlways: billDeliveryShowCustomerPhoneAlways,
            showTableNumber: billShowTableNumber,
            showLargeOrderNumber: opts?.showLargeOrderNumber ?? billShowLargeOrderNumber,
            useUnicode: printerUseUnicode,
            arabicShaping: printerArabicShaping,
            isReprint,
            trimDecimals: printerTrimDecimals,
            languages,
            capabilities: useElectronRaster
              ? nativeFallbackCapabilities(webusbCapabilities)
              : webusbCapabilities,
          };

          let bytes: Uint8Array;
          const encoderWarnings: PrintWarning[] = [];
          const nativeBillTemplate =
            rasterBillTemplate ??
            (billTemplateSource === null &&
            (billTemplate === 'compact' || billTemplate === 'classic')
              ? billTemplate
              : 'classic');
          if (nativeBillTemplate === 'compact') {
            bytes = buildCompactReceiptBytes(bill, tenant, builderOpts, encoderWarnings);
          } else {
            bytes = buildClassicReceiptBytes(bill, tenant, builderOpts, encoderWarnings);
          }

          if (useElectronRaster && rasterBillTemplate && webusbPrinter && rasterizePrintDocument) {
            try {
              const currency = resolveTenantCurrency(tenant.currency, tenant.country);
              const rasterTextSize = normalizePrinterTextSize(
                webusbCapabilities.textSize ?? activeTextSize,
              );
              const rasterResult = await rasterizePrintDocument({
                document: buildFrontendBillDocument(bill, tenant, {
                  ...builderOpts,
                  columns: layoutColumnsForTextSize(billColumns, rasterTextSize),
                  businessName: tenant.business_name,
                  includeTaxId: billShowTaxId,
                  taxIdLabel: getCountryByCode(tenant.country)?.taxIdLabel ?? 'Tax ID',
                  maskCustomerPhone: true,
                  useBillCustomer: true,
                }),
                template: rasterBillTemplate,
                profileId: webusbPrinter.profile_id,
                options: {
                  columns: billColumns,
                  language: languages[0],
                  locale: getCountryByCode(tenant.country)?.locale ?? 'en-US',
                  currency,
                  currencySymbol: getCurrencySymbol(
                    currency,
                    getCountryByCode(tenant.country)?.locale,
                  ),
                  trimDecimals: printerTrimDecimals,
                  useUnicode: printerUseUnicode,
                  arabicShaping: printerArabicShaping,
                  textSize: rasterTextSize,
                  ...(tenant.timezone ? { timezone: tenant.timezone } : {}),
                },
              });
              if (!rasterResult.ok || !rasterResult.data) {
                warnings.push(
                  makeRasterFallbackWarning(rasterResult.ok ? undefined : rasterResult.error),
                );
                warnings.push(...encoderWarnings);
              } else {
                if (rasterResult.warnings)
                  warnings.push(...(rasterResult.warnings as PrintWarning[]));
                const rasterFinancialFailed =
                  rasterResult.warnings?.some((warning) => warning.kind === 'financial') ?? false;
                if (
                  rasterResult.rasterSelected &&
                  !rasterResult.rasterFailed &&
                  !rasterFinancialFailed
                ) {
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
            throw new PrinterOperationError({
              kind: 'receipt',
              code: 'print.receipt.failed',
              failure_class: 'unsupported',
              connection_type: 'webusb',
              stage: 'prepare',
              detail: refusal,
            });
          }
          throwIfTenantChanged();

          set({ lastPrintedBytes: bytes });
          await printerService.print(bytes);
          return warnings;
        } catch (err) {
          if (!windowTransferred && reservedWindow && !reservedWindow.closed)
            reservedWindow.close();
          if (isPrintCancelledOnTenantChangeError(err)) {
            throw err;
          }
          if (!isSameTenant()) {
            throw new PrintCancelledOnTenantChangeError();
          }
          const printerErr = toPrinterOperationError(err, {
            kind: 'receipt',
            connectionType: activeConnectionType,
            stage: 'dispatch',
            fallbackDetail: 'Print failed',
          });
          set({ lastError: printerErr.message });
          throw printerErr;
        }
      },

      printTaxBill: async (bill, tenant, opts) => {
        set({ lastError: null });
        const authTenantIdAtStart = useAuthStore.getState().currentTenant?.id ?? null;
        const isSameTenant = () =>
          (useAuthStore.getState().currentTenant?.id ?? null) === authTenantIdAtStart;
        const throwIfTenantChanged = (): void => {
          if (!isSameTenant()) {
            throw new PrintCancelledOnTenantChangeError();
          }
        };
        try {
          const readyForTenant = await ensureReceiptSettingsLoaded(authTenantIdAtStart).catch(() =>
            isSameTenant(),
          );
          if (!readyForTenant) {
            throw new PrintCancelledOnTenantChangeError();
          }
          throwIfTenantChanged();
          const {
            printerUseUnicode,
            printerArabicShaping,
            printerTrimDecimals,
            printerPaperSize,
            billTaxRegistrationNumber,
            billAddress,
            billPhone,
            billFooterMessage,
            receiptLogo,
            receiptLogoRaster,
            billShowLogo,
            billShowName,
            billShowAddress,
            billShowPhone,
            billShowTaxId,
            billShowTaxBreakdown,
            billShowCustomerName,
            billShowCustomerPhone,
            billDeliveryShowCustomerPhoneAlways,
            billShowTableNumber,
            billShowLargeOrderNumber,
          } = usePosSettingsStore.getState();
          const configuredPaperWidth: PaperWidth = printerPaperSize === 'thermal80' ? 80 : 58;
          const taxBillColumns = columnsForConfiguredPrinter(
            get().webusbPrinter?.paper_width,
            configuredPaperWidth,
          );
          const activeTextSize = resolveActivePrinterTextSize(get(), opts?.capabilities?.textSize);
          const languages = opts?.language
            ? ([opts.language as Language] as const)
            : resolveBillPrintLanguages();

          // Fall back to browser print when no WebUSB thermal transport is connected.
          // Await any in-flight startup reconnect before checking connection status.
          await printerService.awaitPendingReconnect();
          throwIfTenantChanged();
          const noThermalTransport = !printerService.isConnected && get().printMethod === 'escpos';
          if (get().printMethod === 'browser' || noThermalTransport) {
            if (noThermalTransport) {
              toast('No thermal printer connected — printing via system print', { icon: 'ℹ️' });
            }
            // Render HTML directly for browser printing to preserve Unicode glyphs.
            const { printWebBill } = await import('@/lib/printer/web-print');
            throwIfTenantChanged();
            const browserWarnings = await printWebBill(bill, tenant, {
              paperSize: printerPaperSize,
              textSize: activeTextSize,
              columns: taxBillColumns,
              languages,
              includeTaxId: billShowTaxId,
              taxRegistrationNumber: billShowTaxId
                ? opts?.taxRegistrationNumber || billTaxRegistrationNumber || undefined
                : undefined,
              address: billShowAddress ? opts?.address || billAddress || undefined : undefined,
              phone: billShowPhone ? opts?.phone || billPhone || undefined : undefined,
              footerNote: billFooterMessage || undefined,
              businessName: tenant.business_name,
              showBusinessName: billShowName,
              showLogo: billShowLogo,
              receiptLogo: billShowLogo ? receiptLogo : undefined,
              receiptLogoRaster: billShowLogo ? receiptLogoRaster : undefined,
              showTaxBreakdown: billShowTaxBreakdown,
              showCustomerName: billShowCustomerName,
              showCustomerPhone: billShowCustomerPhone,
              deliveryShowCustomerPhoneAlways: billDeliveryShowCustomerPhoneAlways,
              showTableNumber: billShowTableNumber,
              showLargeOrderNumber: opts?.showLargeOrderNumber ?? billShowLargeOrderNumber,
              useUnicode: printerUseUnicode,
              trimDecimals: printerTrimDecimals,
            });
            return browserWarnings;
          }

          const failedLanguages = await ensurePrintLanguagesLoaded(languages);
          throwIfTenantChanged();
          const warnings: PrintWarning[] = failedLanguages.map((language) => ({
            field: 'receipt language',
            text: language,
            message: `Receipt language "${language}" could not be loaded, so English labels were used.`,
            kind: 'locale' as const,
          }));
          const bytes = buildTaxBillBytes(
            bill,
            tenant,
            {
              ...opts,
              paperWidth: opts?.paperWidth ?? configuredPaperWidth,
              columns: taxBillColumns,
              taxRegistrationNumber: billShowTaxId
                ? opts?.taxRegistrationNumber || billTaxRegistrationNumber || undefined
                : undefined,
              address: billShowAddress ? opts?.address || billAddress || undefined : undefined,
              phone: billShowPhone ? opts?.phone || billPhone || undefined : undefined,
              showBusinessName: billShowName,
              showTaxBreakdown: billShowTaxBreakdown,
              showCustomerName: billShowCustomerName,
              showCustomerPhone: billShowCustomerPhone,
              deliveryShowCustomerPhoneAlways: billDeliveryShowCustomerPhoneAlways,
              showTableNumber: billShowTableNumber,
              showLargeOrderNumber: opts?.showLargeOrderNumber ?? billShowLargeOrderNumber,
              useUnicode: printerUseUnicode,
              arabicShaping: printerArabicShaping,
              trimDecimals: printerTrimDecimals,
              rawEscPos: true,
              language: languages[0],
              capabilities:
                opts?.capabilities ??
                resolveWebUsbCapabilities(
                  get().webusbPrinter,
                  opts?.paperWidth ?? configuredPaperWidth,
                  activeTextSize,
                ),
            },
            warnings,
          );
          if (hasFinancialPrintWarning(warnings)) {
            const refusal = makeFinancialPrintRefusalMessage(warnings);
            toast.error(refusal);
            throw new Error(refusal);
          }
          set({ lastPrintedBytes: bytes });
          await printerService.print(bytes);
          return warnings;
        } catch (err) {
          if (isPrintCancelledOnTenantChangeError(err)) {
            throw err;
          }
          if (!isSameTenant()) {
            throw new PrintCancelledOnTenantChangeError();
          }
          set({ lastError: (err as Error).message });
          throw err;
        }
      },

      printKot: async (order, opts) => {
        set({ lastError: null });
        let activeConnectionType = 'unknown';
        const authTenantIdAtStart = useAuthStore.getState().currentTenant?.id ?? null;
        const isSameTenant = () =>
          (useAuthStore.getState().currentTenant?.id ?? null) === authTenantIdAtStart;
        const throwIfTenantChanged = (): void => {
          if (!isSameTenant()) {
            throw new PrintCancelledOnTenantChangeError();
          }
        };
        // Enforce master kot_printing_enabled toggle for all automatic and manual prints.
        const {
          kotPrintingEnabled,
          printerUseUnicode,
          printerArabicShaping,
          billShowLargeOrderNumber,
        } = usePosSettingsStore.getState();
        const tenant = useAuthStore.getState().currentTenant;
        const tenantTimezone = tenant?.timezone;
        const tenantLocale = getCountryByCode(tenant?.country ?? '')?.locale ?? 'en-US';
        if (!kotPrintingEnabled) {
          const err = new Error('KOT printing is disabled for this business');
          set({ lastError: err.message });
          throw err;
        }
        try {
          const hw = get().hardwarePrinter;
          if (hw && get().printMethod === 'escpos') {
            try {
              const response = await api.post<{ warnings?: PrintWarning[] }>(
                '/printers/print-kot',
                {
                  orderId: order.id,
                  items: opts?.items ?? order.items,
                  stationName: opts?.stationName,
                  useUnicode: printerUseUnicode,
                  arabicShaping: printerArabicShaping,
                  showLargeOrderNumber: opts?.showLargeOrderNumber ?? billShowLargeOrderNumber,
                },
              );
              throwIfTenantChanged();
              return response.data.warnings || [];
            } catch (err: unknown) {
              if (isPrintCancelledOnTenantChangeError(err)) throw err;
              throwIfTenantChanged();
              throw toPrinterOperationError(err, {
                kind: 'kot',
                connectionType: hw.connection_type,
                stage: 'dispatch',
                fallbackDetail: 'KOT print failed',
              });
            }
          }

          const readyForTenant = await ensureReceiptSettingsLoaded(authTenantIdAtStart).catch(() =>
            isSameTenant(),
          );
          if (!readyForTenant) {
            throw new PrintCancelledOnTenantChangeError();
          }
          throwIfTenantChanged();
          const hydratedLargeOrderNumber =
            usePosSettingsStore.getState().billShowLargeOrderNumber;

          const orderForPrint = opts?.items ? { ...order, items: opts.items } : order;
          const activeTextSize = resolveActivePrinterTextSize(get(), opts?.capabilities?.textSize);
          const { resolveKotTicketLanguage } = await import('@/lib/printer/kot-web-print');
          throwIfTenantChanged();
          const kotLanguage = resolveKotTicketLanguage();
          const failedLanguages = await ensurePrintLanguagesLoaded([kotLanguage]);
          throwIfTenantChanged();

          // Await startup silent reconnect before checking isConnected
          // to avoid premature browser print fallbacks.
          await printerService.awaitPendingReconnect();
          throwIfTenantChanged();
          if (get().printMethod === 'escpos' && printerService.isConnected) {
            activeConnectionType = 'webusb';
            const { paperWidth } = get();
            const warnings: PrintWarning[] = [];
            const encoderWarnings: PrintWarning[] = [];
            const webusbPrinter = get().webusbPrinter;
            const kotColumns = columnsForConfiguredPrinter(webusbPrinter?.paper_width, paperWidth);
            const webusbCapabilities =
              opts?.capabilities ??
              resolveWebUsbCapabilities(webusbPrinter, paperWidth, activeTextSize);
            const rasterizeKotDocument = window.electronAPI?.rasterizeKotDocument;
            const useRaster = Boolean(
              webusbPrinter &&
              rasterizeKotDocument &&
              rasterWebUsbPathEnabled(webusbPrinter.capabilities, true, webusbPrinter.profile_id),
            );
            let rasterOrder = orderForPrint;
            let rasterHydrationError: unknown = null;
            if (useRaster && (orderForPrint.table_id || orderForPrint.customer_id)) {
              try {
                const response = await api.get<{ order: Order }>(`/orders/${orderForPrint.id}`);
                throwIfTenantChanged();
                rasterOrder = orderForPrint.items
                  ? { ...response.data.order, items: orderForPrint.items }
                  : response.data.order;
              } catch (error) {
                if (isPrintCancelledOnTenantChangeError(error)) throw error;
                throwIfTenantChanged();
                rasterHydrationError = error;
              }
              throwIfTenantChanged();
            }
            const bytes = buildKotBytes(
              rasterOrder,
              {
                ...opts,
                paperWidth,
                columns: kotColumns,
                stationName: opts?.stationName,
                arabicShaping: printerArabicShaping,
                language: kotLanguage,
                timezone: tenantTimezone ?? opts?.timezone,
                showLargeOrderNumber: opts?.showLargeOrderNumber ?? hydratedLargeOrderNumber,
                capabilities: useRaster
                  ? nativeFallbackCapabilities(webusbCapabilities)
                  : webusbCapabilities,
              },
              encoderWarnings,
            );
            let output = bytes;
            if (useRaster && rasterHydrationError) {
              warnings.push(makeRasterFallbackWarning(rasterHydrationError));
              warnings.push(...encoderWarnings);
            } else if (useRaster && rasterizeKotDocument && webusbPrinter) {
              try {
                const rasterKotTextSize = normalizePrinterTextSize(
                  webusbCapabilities.textSize ?? activeTextSize,
                );
                const rasterResult = await rasterizeKotDocument({
                  document: buildFrontendKotDocument(rasterOrder, {
                    items: rasterOrder.items,
                    stationName: opts?.stationName ?? 'Kitchen',
                    columns: layoutColumnsForTextSize(kotColumns, rasterKotTextSize),
                    language: kotLanguage,
                    showLargeOrderNumber: opts?.showLargeOrderNumber ?? hydratedLargeOrderNumber,
                    ...((tenantTimezone ?? opts?.timezone)
                      ? { timezone: tenantTimezone ?? opts?.timezone }
                      : {}),
                  }),
                  profileId: webusbPrinter.profile_id,
                  options: {
                    columns: kotColumns,
                    language: kotLanguage,
                    locale: tenantLocale,
                    ...((tenantTimezone ?? opts?.timezone)
                      ? { timezone: tenantTimezone ?? opts?.timezone }
                      : {}),
                    useUnicode: printerUseUnicode,
                    arabicShaping: printerArabicShaping,
                    textSize: rasterKotTextSize,
                  },
                });
                throwIfTenantChanged();
                if (!rasterResult.ok || !rasterResult.data) {
                  warnings.push(
                    makeRasterFallbackWarning(rasterResult.ok ? undefined : rasterResult.error),
                  );
                  warnings.push(...encoderWarnings);
                } else {
                  if (rasterResult.warnings)
                    warnings.push(...(rasterResult.warnings as PrintWarning[]));
                  const rasterFinancialFailed =
                    rasterResult.warnings?.some((warning) => warning.kind === 'financial') ?? false;
                  if (
                    rasterResult.rasterSelected &&
                    !rasterResult.rasterFailed &&
                    !rasterFinancialFailed
                  ) {
                    output = Uint8Array.from(rasterResult.data);
                  } else {
                    warnings.push(...encoderWarnings);
                  }
                }
              } catch (error) {
                if (isPrintCancelledOnTenantChangeError(error)) throw error;
                throwIfTenantChanged();
                warnings.push(makeRasterFallbackWarning(error));
                warnings.push(...encoderWarnings);
              }
            } else {
              warnings.push(...encoderWarnings);
            }
            if (hasFinancialPrintWarning(warnings)) {
              const refusal = makeFinancialPrintRefusalMessage(warnings);
              toast.error(refusal);
              throw new PrinterOperationError({
                kind: 'kot',
                code: 'print.kot.failed',
                failure_class: 'unsupported',
                connection_type: 'webusb',
                stage: 'prepare',
                detail: refusal,
              });
            }
            throwIfTenantChanged();
            set({ lastPrintedBytes: output });
            await printerService.print(output);
            throwIfTenantChanged();
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

          // Browser fallback: render semantic KOT HTML when hardware or WebUSB is unavailable.
          // Ensure target KOT language bundle is loaded to avoid fallback to English labels.
          const paperWidth = (get().paperWidth || 80) === 80 ? 80 : 58;
          const { generateKotHtml } = await import('@/lib/printer/kot-web-print');
          throwIfTenantChanged();
          const html = generateKotHtml(orderForPrint, {
            paperWidth,
            textSize: activeTextSize,
            language: kotLanguage,
            stationName: opts?.stationName ?? 'Kitchen',
            timezone: tenantTimezone ?? opts?.timezone,
            showLargeOrderNumber: opts?.showLargeOrderNumber ?? hydratedLargeOrderNumber,
          });
          await printerService.printViaBrowser(html, paperWidth);
          throwIfTenantChanged();
          // Surface failed locale loads as warnings when falling back to English labels.
          return failedLanguages.map((language) => ({
            field: 'kot language',
            text: language,
            message: `KOT language "${language}" could not be loaded, so English labels were used.`,
            kind: 'locale' as const,
          })) as PrintWarning[];
        } catch (err) {
          if (isPrintCancelledOnTenantChangeError(err)) {
            throw err;
          }
          if (!isSameTenant()) {
            throw new PrintCancelledOnTenantChangeError();
          }
          const printerErr = toPrinterOperationError(err, {
            kind: 'kot',
            connectionType: activeConnectionType,
            stage: 'dispatch',
            fallbackDetail: 'KOT print failed',
          });
          set({ lastError: printerErr.message });
          throw printerErr;
        }
      },

      printDeliverySlip: async (order, contact, opts) => {
        set({ lastError: null });
        const initialPrinter = get().hardwarePrinter;
        let reservedPopup: Window | null = null;
        try {
          reservedPopup = printerService.reserveBrowserPrintWindow();
          const {
            printerUseUnicode,
            printerArabicShaping,
            billDeliveryShowCustomerPhoneAlways,
            billShowCustomerPhone,
          } = usePosSettingsStore.getState();
          // A settings change can swap the receipt language without loading its
          // bundle, so load it first rather than printing an English slip silently.
          const slipLanguages = resolveBillPrintLanguages();
          const failedSlipLanguages = await ensurePrintLanguagesLoaded(slipLanguages);
          const tenant = useAuthStore.getState().currentTenant;
          const tenantTimezone = tenant?.timezone;
          const orderForPrint = (opts as { items?: OrderItem[] } | undefined)?.items
            ? { ...order, items: (opts as { items?: OrderItem[] }).items }
            : order;
          // Same rule as the backend route: the delivery override, or the
          // receipt setting when the override is off.
          const slipContact =
            billDeliveryShowCustomerPhoneAlways || billShowCustomerPhone
              ? contact
              : { ...contact, phone: '' };
          const slipItems = (orderForPrint.items ?? []).map((item) => ({
            product_name: item.product_name,
            variant_selection: item.variant_selection ?? null,
            quantity: Number(item.quantity) || 0,
            addons: (item.addons ?? []).map((addon) => ({
              name: addon.name,
              ...(typeof addon.quantity === 'number' && addon.quantity > 0
                ? { quantity: addon.quantity }
                : {}),
            })),
            special_instructions: item.special_instructions ?? null,
          }));
          // The order-level note travels with the order, not the items, so it is
          // read from the order row rather than the per-item instructions above.
          const slipOrder = {
            order_number: String(orderForPrint.order_number ?? ''),
            created_at: String(orderForPrint.created_at ?? ''),
            type: String((orderForPrint as { type?: string }).type ?? ''),
            special_instructions: orderForPrint.special_instructions ?? null,
            delivery_note: orderForPrint.delivery_note ?? null,
          };
          const hw = initialPrinter;
          if (hw && get().printMethod === 'escpos') {
            try {
              const response = await api.post<{ warnings?: PrintWarning[] }>(
                '/printers/print-delivery-slip',
                {
                  orderId: order.id,
                  useUnicode: printerUseUnicode,
                  arabicShaping: printerArabicShaping,
                },
              );
              if (reservedPopup && !reservedPopup.closed) reservedPopup.close();
              return response.data.warnings || [];
            } catch (err: unknown) {
              const e = err as {
                response?: { data?: { error?: string; detail?: string } };
                message?: string;
              };
              const errorMsg =
                e.response?.data?.detail ||
                e.response?.data?.error ||
                e.message ||
                'Delivery slip print failed';
              if (errorMsg.includes('No default printer configured')) {
                toast('No thermal printer configured — printing via system print', { icon: 'ℹ️' });
              } else {
                throw new Error(errorMsg);
              }
            }
          }

          await printerService.awaitPendingReconnect();
          if (
            (get().printMethod !== 'escpos' || !printerService.isConnected) &&
            (!reservedPopup || reservedPopup.closed)
          ) {
            throw new Error('Please allow popups to print');
          }
          const { paperWidth } = get();
          const activeTextSize = resolveActivePrinterTextSize(get(), opts?.capabilities?.textSize);
          const paymentResponse = await api.get<{ payment?: DeliverySlipPayment }>(
            `/printers/delivery-slip-payment/${order.id}`,
          );
          const slipPayment = paymentResponse.data.payment;
          if (get().printMethod === 'escpos' && printerService.isConnected) {
            if (reservedPopup && !reservedPopup.closed) reservedPopup.close();
            const warnings: PrintWarning[] = [];
            const encoderWarnings: PrintWarning[] = [];
            const columns = columnsForConfiguredPrinter(
              get().webusbPrinter?.paper_width,
              paperWidth,
            );
            const bytes = buildDeliverySlipBytes(
              slipOrder,
              slipItems,
              slipContact,
              {
                paperWidth,
                columns,
                arabicShaping: printerArabicShaping,
                language: slipLanguages[0] as Language,
                capabilities:
                  opts?.capabilities ??
                  resolveWebUsbCapabilities(get().webusbPrinter, paperWidth, activeTextSize),
                ...(slipPayment ? { payment: slipPayment } : {}),
                ...(tenantTimezone ? { timezone: tenantTimezone } : {}),
              },
              encoderWarnings,
            );
            if (hasFinancialPrintWarning(encoderWarnings)) {
              const refusal = makeFinancialPrintRefusalMessage(encoderWarnings);
              toast.error(refusal);
              throw new Error(refusal);
            }
            set({ lastPrintedBytes: bytes });
            await printerService.print(bytes);
            return [
              ...failedSlipLanguages.map((language) => ({
                field: 'slip language',
                text: language,
                message: `Slip language "${language}" could not be loaded, so English labels were used.`,
                kind: 'locale' as const,
              })),
              ...warnings,
              ...encoderWarnings,
            ] as PrintWarning[];
          }

          const { generateDeliverySlipHtml } =
            await import('@/lib/printer/delivery-slip-web-print');
          const html = generateDeliverySlipHtml(slipOrder, slipItems, slipContact, {
            paperWidth,
            textSize: activeTextSize,
            language: resolveBillPrintLanguages()[0] as Language,
            ...(slipPayment ? { payment: slipPayment } : {}),
            ...(tenantTimezone ? { timezone: tenantTimezone } : {}),
          });
          if (!reservedPopup || reservedPopup.closed)
            throw new Error('Please allow popups to print');
          await printerService.printViaBrowser(html, paperWidth, reservedPopup);
          return failedSlipLanguages.map((language) => ({
            field: 'slip language',
            text: language,
            message: `Slip language "${language}" could not be loaded, so English labels were used.`,
            kind: 'locale' as const,
          })) as PrintWarning[];
        } catch (err) {
          if (reservedPopup && !reservedPopup.closed) reservedPopup.close();
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
      partialize: (state) => ({
        printMode: state.printMode,
        paperWidth: state.paperWidth,
        printMethod: state.printMethod,
      }),
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
    },
  ),
);

export function usePrinterStatusSync(): void {
  const store = usePrinterStore();

  useEffect(() => {
    usePrinterStore.setState({
      status: printerService.status,
      deviceInfo: printerService.deviceInfo,
    });

    store.refreshHardwarePrinter();
    // Re-attach to previously authorized WebUSB printer across reloads.
    printerService.tryReconnect();

    const unsub = printerService.onStatusChange((status, info) => {
      usePrinterStore.setState({
        status,
        deviceInfo: info ?? printerService.deviceInfo,
      });
    });

    return unsub;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
