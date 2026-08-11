import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PaperSize = 'thermal58' | 'thermal80';
export type PrinterPrintMode = 'escpos' | 'browser';
export type BillTemplate = 'classic' | 'compact' | 'detailed';

export interface PosSettingsState {
  showProductImages: boolean;
  customerMandatory: boolean;
  // When enabled, the POS auto-advances focus from phone → name as soon as
  // the typed digits form a valid number for the tenant's country, so
  // cashiers don't have to tab/click over manually.
  enforcePhoneLength: boolean;
  billingType: 'postpaid' | 'prepaid';
  tablesRequired: boolean;
  // UI language for i18n routing. Synced from tenant on auth load.
  // Initial value reads the browser locale; persist middleware overrides
  // on reload, so user choices persist across sessions.
  language: 'en' | 'es' | 'pt';
  // Printer settings
  printerPaperSize: PaperSize;
  printerEnabled: boolean;
  printerPrintMode: PrinterPrintMode;
  autoPrintKot: boolean;
  autoPrintBill: boolean;
  whatsappShareEnabled: boolean;
  // Web print settings
  defaultPrintMode: 'thermal' | 'web';
  // Bill template settings
  billTemplate: BillTemplate;
  billFooterMessage: string;
  billTaxRegistrationNumber: string;
  billAddress: string;
  billPhone: string;
  billShowName: boolean;
  billShowAddress: boolean;
  billShowPhone: boolean;
  billShowTaxId: boolean;
  billShowTaxBreakdown: boolean;
  billShowCustomerName: boolean;
  billShowCustomerPhone: boolean;
  billShowTableNumber: boolean;
  // Thermal printer unicode support
  printerUseUnicode: boolean;
  // Receipt amount formatting
  printerTrimDecimals: boolean;
  // Kitchen workflow toggles (issue #133) — business-level settings, synced
  // from the backend (default true, matching pre-toggle always-on behavior).
  kdsEnabled: boolean;
  kotPrintingEnabled: boolean;
  // Whether the WhatsApp integration is enabled on this tenant. Synced from
  // the backend on auth load so the sidebar can hide the nav entry when the
  // feature is off, and updated by the WhatsApp page after the user toggles.
  whatsappEnabled: boolean;
  // Actions
  setShowProductImages: (show: boolean) => void;
  setCustomerMandatory: (mandatory: boolean) => void;
  setEnforcePhoneLength: (enabled: boolean) => void;
  setLanguage: (lang: 'en' | 'es' | 'pt') => void;
  setPrinterPaperSize: (size: PaperSize) => void;
  setPrinterEnabled: (enabled: boolean) => void;
  setPrinterPrintMode: (mode: PrinterPrintMode) => void;
  setAutoPrintKot: (enabled: boolean) => void;
  setAutoPrintBill: (enabled: boolean) => void;
  setWhatsappShareEnabled: (enabled: boolean) => void;
  setDefaultPrintMode: (mode: 'thermal' | 'web') => void;
  setBillTemplate: (t: BillTemplate) => void;
  setBillFooterMessage: (m: string) => void;
  setBillTaxRegistrationNumber: (g: string) => void;
  setBillAddress: (a: string) => void;
  setBillPhone: (p: string) => void;
  setBillShowName: (v: boolean) => void;
  setBillShowAddress: (v: boolean) => void;
  setBillShowPhone: (v: boolean) => void;
  setBillShowTaxId: (v: boolean) => void;
  setBillShowTaxBreakdown: (v: boolean) => void;
  setBillShowCustomerName: (v: boolean) => void;
  setBillShowCustomerPhone: (v: boolean) => void;
  setBillShowTableNumber: (v: boolean) => void;
  setBillingType: (v: 'postpaid' | 'prepaid') => void;
  setTablesRequired: (v: boolean) => void;
  setPrinterUseUnicode: (v: boolean) => void;
  setPrinterTrimDecimals: (v: boolean) => void;
  setKdsEnabled: (v: boolean) => void;
  setKotPrintingEnabled: (v: boolean) => void;
  setWhatsappEnabled: (v: boolean) => void;
}

export const usePosSettingsStore = create<PosSettingsState>()(
  persist(
    (set) => ({
      showProductImages: true,
      customerMandatory: false,
      enforcePhoneLength: false,
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
      // Bill template defaults
      billTemplate: 'classic',
      billFooterMessage: '',
      billTaxRegistrationNumber: '',
      billAddress: '',
      billPhone: '',
      billShowName: true,
      billShowAddress: true,
      billShowPhone: true,
      billShowTaxId: false,
      billShowTaxBreakdown: true,
      billShowCustomerName: true,
      billShowCustomerPhone: true,
      billShowTableNumber: true,
      printerUseUnicode: false,
      printerTrimDecimals: false,
      kdsEnabled: true,
      kotPrintingEnabled: true,
      // Default false so the sidebar hides the WhatsApp nav entry until the
      // tenant actually enables the integration. Synced from /api/whatsapp/status
      // on auth load (see Sidebar.tsx) and updated by the WhatsApp page after
      // a successful enable/disable toggle.
      whatsappEnabled: false,
      // Actions
      setShowProductImages: (show) => set({ showProductImages: show }),
      setCustomerMandatory: (mandatory) => set({ customerMandatory: mandatory }),
      setEnforcePhoneLength: (enabled) => set({ enforcePhoneLength: enabled }),
      setLanguage: (language) => set({ language }),
      setPrinterPaperSize: (size) => set({ printerPaperSize: size }),
      setPrinterEnabled: (enabled) => set({ printerEnabled: enabled }),
      setPrinterPrintMode: (mode) => set({ printerPrintMode: mode }),
      setAutoPrintKot: (enabled) => set({ autoPrintKot: enabled }),
      setAutoPrintBill: (enabled) => set({ autoPrintBill: enabled }),
      setWhatsappShareEnabled: (enabled) => set({ whatsappShareEnabled: enabled }),
      setDefaultPrintMode: (mode) => set({ defaultPrintMode: mode }),
      setBillTemplate: (t) => set({ billTemplate: t }),
      setBillFooterMessage: (m) => set({ billFooterMessage: m }),
      setBillTaxRegistrationNumber: (g) => set({ billTaxRegistrationNumber: g }),
      setBillAddress: (a) => set({ billAddress: a }),
      setBillPhone: (p) => set({ billPhone: p }),
      setBillShowName: (v) => set({ billShowName: v }),
      setBillShowAddress: (v) => set({ billShowAddress: v }),
      setBillShowPhone: (v) => set({ billShowPhone: v }),
      setBillShowTaxId: (v) => set({ billShowTaxId: v }),
      setBillShowTaxBreakdown: (v) => set({ billShowTaxBreakdown: v }),
      setBillShowCustomerName: (v) => set({ billShowCustomerName: v }),
      setBillShowCustomerPhone: (v) => set({ billShowCustomerPhone: v }),
      setBillShowTableNumber: (v) => set({ billShowTableNumber: v }),
      setBillingType: (v) => set({ billingType: v }),
      setTablesRequired: (v) => set({ tablesRequired: v }),
      setPrinterUseUnicode: (v) => set({ printerUseUnicode: v }),
      setPrinterTrimDecimals: (v) => set({ printerTrimDecimals: v }),
      setKdsEnabled: (v) => set({ kdsEnabled: v }),
      setKotPrintingEnabled: (v) => set({ kotPrintingEnabled: v }),
      setWhatsappEnabled: (v: boolean) => set({ whatsappEnabled: v }),
    }),
    {
      name: 'pos-settings',
      // Don't persist whatsappEnabled — it's always synced from the
      // backend (Sidebar fetches /whatsapp/status on mount, WhatsApp page
      // updates on toggle). Stale persisted values would mask the real
      // state for tenants who enable/disable across devices.
      partialize: (s) => Object.fromEntries(
        Object.entries(s).filter(([k]) => k !== 'whatsappEnabled'),
      ) as PosSettingsState,
      // v1: billGstin/billShowGstn (India-specific names) renamed to the
      // generic billTaxRegistrationNumber/billShowTaxId. Carry existing
      // browsers' saved values forward under the new keys instead of
      // silently resetting them.
      // v2: A4/A5 web-print support was removed entirely (PaperSize is now
      // thermal58/thermal80 only, frontend/src/lib/printer/web-print.ts) —
      // negligible real-world usage didn't justify keeping a second paper
      // layout alive. A browser that saved 'a4'/'a5' before the removal
      // would otherwise keep a value nothing in the app still recognizes.
      // v3: web print now shares the main printerPaperSize setting, and bill
      // content controls gained explicit customer/table/tax-breakdown flags.
      version: 3,
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        if (version < 1) {
          if ('billGstin' in state) {
            state.billTaxRegistrationNumber = state.billGstin;
            delete state.billGstin;
          }
          if ('billShowGstn' in state) {
            state.billShowTaxId = state.billShowGstn;
            delete state.billShowGstn;
          }
          delete state.includeGstOnBill;
        }
        if (version < 2) {
          if (state.webPrintSize === 'a4' || state.webPrintSize === 'a5') {
            state.webPrintSize = 'thermal58';
          }
        }
        if (version < 3) {
          if (!state.printerPaperSize && state.webPrintSize) state.printerPaperSize = state.webPrintSize;
          delete state.webPrintSize;
          state.billShowTaxBreakdown ??= true;
          state.billShowCustomerName ??= true;
          state.billShowCustomerPhone ??= true;
          state.billShowTableNumber ??= true;
        }
        return state as unknown as PosSettingsState;
      },
    }
  )
);
