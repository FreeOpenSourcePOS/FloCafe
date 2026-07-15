import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PaperSize = 'thermal58' | 'thermal80' | 'a4' | 'a5';
export type PrinterPrintMode = 'escpos' | 'browser';
export type BillTemplate = 'classic' | 'compact' | 'detailed';

export interface PosSettingsState {
  showProductImages: boolean;
  customerMandatory: boolean;
  billingType: 'postpaid' | 'prepaid';
  tablesRequired: boolean;
  // UI language for i18n routing. Synced from tenant on auth load.
  // Initial value reads the browser locale; persist middleware overrides
  // on reload, so user choices persist across sessions.
  language: 'en' | 'es';
  // Printer settings
  printerPaperSize: PaperSize;
  printerEnabled: boolean;
  printerPrintMode: PrinterPrintMode;
  autoPrintKot: boolean;
  autoPrintBill: boolean;
  whatsappShareEnabled: boolean;
  // Web print settings
  defaultPrintMode: 'thermal' | 'web';
  webPrintSize: PaperSize;
  includeGstOnBill: boolean;
  // Bill template settings
  billTemplate: BillTemplate;
  billFooterMessage: string;
  billGstin: string;
  billAddress: string;
  billPhone: string;
  billShowName: boolean;
  billShowAddress: boolean;
  billShowPhone: boolean;
  billShowGstn: boolean;
  // Thermal printer unicode support
  printerUseUnicode: boolean;
  // Actions
  setShowProductImages: (show: boolean) => void;
  setCustomerMandatory: (mandatory: boolean) => void;
  setLanguage: (lang: 'en' | 'es') => void;
  setPrinterPaperSize: (size: PaperSize) => void;
  setPrinterEnabled: (enabled: boolean) => void;
  setPrinterPrintMode: (mode: PrinterPrintMode) => void;
  setAutoPrintKot: (enabled: boolean) => void;
  setAutoPrintBill: (enabled: boolean) => void;
  setWhatsappShareEnabled: (enabled: boolean) => void;
  setDefaultPrintMode: (mode: 'thermal' | 'web') => void;
  setWebPrintSize: (size: PaperSize) => void;
  setIncludeGstOnBill: (include: boolean) => void;
  setBillTemplate: (t: BillTemplate) => void;
  setBillFooterMessage: (m: string) => void;
  setBillGstin: (g: string) => void;
  setBillAddress: (a: string) => void;
  setBillPhone: (p: string) => void;
  setBillShowName: (v: boolean) => void;
  setBillShowAddress: (v: boolean) => void;
  setBillShowPhone: (v: boolean) => void;
  setBillShowGstn: (v: boolean) => void;
  setBillingType: (v: 'postpaid' | 'prepaid') => void;
  setTablesRequired: (v: boolean) => void;
  setPrinterUseUnicode: (v: boolean) => void;
}

export const usePosSettingsStore = create<PosSettingsState>()(
  persist(
    (set) => ({
      showProductImages: true,
      customerMandatory: false,
      billingType: 'postpaid',
      tablesRequired: true,
      language: 'en',
      // Printer defaults
      printerPaperSize: 'thermal58',
      printerEnabled: false,
      printerPrintMode: 'escpos',
      autoPrintKot: false,
      autoPrintBill: false,
      whatsappShareEnabled: true,
      // Web print defaults
      defaultPrintMode: 'thermal',
      webPrintSize: 'a4',
      includeGstOnBill: false,
      // Bill template defaults
      billTemplate: 'classic',
      billFooterMessage: '',
      billGstin: '',
      billAddress: '',
      billPhone: '',
      billShowName: true,
      billShowAddress: true,
      billShowPhone: true,
      billShowGstn: false,
      printerUseUnicode: false,
      // Actions
      setShowProductImages: (show) => set({ showProductImages: show }),
      setCustomerMandatory: (mandatory) => set({ customerMandatory: mandatory }),
      setLanguage: (language) => set({ language }),
      setPrinterPaperSize: (size) => set({ printerPaperSize: size }),
      setPrinterEnabled: (enabled) => set({ printerEnabled: enabled }),
      setPrinterPrintMode: (mode) => set({ printerPrintMode: mode }),
      setAutoPrintKot: (enabled) => set({ autoPrintKot: enabled }),
      setAutoPrintBill: (enabled) => set({ autoPrintBill: enabled }),
      setWhatsappShareEnabled: (enabled) => set({ whatsappShareEnabled: enabled }),
      setDefaultPrintMode: (mode) => set({ defaultPrintMode: mode }),
      setWebPrintSize: (size) => set({ webPrintSize: size }),
      setIncludeGstOnBill: (include) => set({ includeGstOnBill: include }),
      setBillTemplate: (t) => set({ billTemplate: t }),
      setBillFooterMessage: (m) => set({ billFooterMessage: m }),
      setBillGstin: (g) => set({ billGstin: g }),
      setBillAddress: (a) => set({ billAddress: a }),
      setBillPhone: (p) => set({ billPhone: p }),
      setBillShowName: (v) => set({ billShowName: v }),
      setBillShowAddress: (v) => set({ billShowAddress: v }),
      setBillShowPhone: (v) => set({ billShowPhone: v }),
      setBillShowGstn: (v) => set({ billShowGstn: v }),
      setBillingType: (v) => set({ billingType: v }),
      setTablesRequired: (v) => set({ tablesRequired: v }),
      setPrinterUseUnicode: (v) => set({ printerUseUnicode: v }),
    }),
    { name: 'pos-settings' }
  )
);
