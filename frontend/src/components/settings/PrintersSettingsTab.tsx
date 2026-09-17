'use client';

import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Printer,
  RefreshCw,
  Plus,
  ChevronDown,
  Wifi,
  Usb,
  CheckCircle2,
  TestTube2,
  Star,
  Settings,
  Trash2,
  AlertTriangle,
  Share2,
  FileText,
} from 'lucide-react';
import { useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { Toggle } from '@/components/settings/Toggle';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import { LANGUAGES, type Language } from '@/lib/i18n';
import { isTemplateCardSelected, type BillTemplateSelectionSource } from '@/lib/bill-template-picker';
import { type PaperSize, type BillTemplate } from '@/store/pos-settings';
import { usePrinterStore } from '@/hooks/usePrinter';
import api from '@/lib/api';
import toast from 'react-hot-toast';

const SELECTABLE_LANGUAGES: Language[] = (Object.keys(LANGUAGES) as Language[]).filter(
  (lang) => LANGUAGES[lang].selectable,
);

export type HwPrinter = {
  id: string;
  name: string;
  connection_type: 'network' | 'usb' | 'webusb';
  ip_address?: string;
  port?: number;
  cash_drawer_pulse_enabled: number;
  paper_width: string;
  is_default: number;
  profile_id?: string;
  profile_name?: string;
};

export type DetectedPrinter = {
  name: string;
  make: string;
  model: string;
  connectionType: 'usb' | 'network' | 'bluetooth';
  deviceUri: string;
  status: 'idle' | 'printing' | 'offline';
  isDefault: boolean;
  ipAddress?: string;
  port?: number;
  paperWidth?: string;
  profileId?: string;
};

export type PrinterForm = {
  name: string;
  connection_type: 'network' | 'usb' | 'webusb';
  ip_address: string;
  port: string;
  paper_width: string;
};

export type PrintingForm = {
  printerEnabled: boolean;
  printerPaperSize: PaperSize;
  cashDrawerPulseEnabled: boolean | undefined;
  cashDrawerPulseMethods: string[];
  printMethod: 'escpos' | 'browser';
  autoPrintKot: boolean;
  autoPrintBill: boolean;
  whatsappShareEnabled: boolean;
  printerUseUnicode: boolean;
  printerArabicShaping: boolean;
  printerTrimDecimals: boolean;
  receiptPrimaryLanguage: string;
  receiptSecondLanguage: string;
  zReportPrimaryLanguage: string;
  zReportSecondLanguage: string;
  kotLanguage: string;
  billShowName: boolean;
  billShowAddress: boolean;
  billShowPhone: boolean;
  billShowTaxId: boolean;
  billShowTaxBreakdown: boolean;
  billShowCustomerName: boolean;
  billShowCustomerPhone: boolean;
  billShowTableNumber: boolean;
};

export type BillTemplateForm = {
  billTemplate: BillTemplate;
  billTemplateSource: BillTemplateSelectionSource;
  billFooterMessage: string;
};

type SettingsKey = keyof AppConfig['Messages']['settings'];

export interface TemplateCard {
  id: BillTemplate;
  nameKey?: SettingsKey;
  displayName?: string;
  preview: string;
  source: 'core' | 'plugin' | 'merchant';
  selectionSource: BillTemplateSelectionSource;
  description?: string;
  originBadgeKey?: 'billTemplateMerchantCreated' | 'billTemplateMerchantImported' | 'billTemplateMerchantCloned';
}

const emptyPrinterForm: PrinterForm = {
  name: '',
  connection_type: 'network',
  ip_address: '',
  port: '9100',
  paper_width: 'cols-42',
};

export interface PrintersSettingsTabProps {
  isActive: boolean;
  hwPrinters: HwPrinter[];
  setHwPrinters: React.Dispatch<React.SetStateAction<HwPrinter[]>>;
  printingForm: PrintingForm;
  setPrintingForm: React.Dispatch<React.SetStateAction<PrintingForm>>;
  billForm: BillTemplateForm;
  setBillForm: React.Dispatch<React.SetStateAction<BillTemplateForm>>;
  billTemplateCards: TemplateCard[];
  kotPrintingEnabledSetting: boolean;
  saveKotPrintingEnabled: (enabled: boolean) => Promise<void>;
  savingKotPrintingEnabled: boolean;
  kdsEnabledSetting: boolean;
  pulseCustomMethods: string[];
  markHydrationTouched: (field: string) => void;
  confirm: (message: string, options?: { title?: string; confirmLabel?: string; destructive?: boolean }) => Promise<boolean>;
}

export function PrintersSettingsTab({
  isActive,
  hwPrinters,
  setHwPrinters,
  printingForm,
  setPrintingForm,
  billForm,
  setBillForm,
  billTemplateCards,
  kotPrintingEnabledSetting,
  saveKotPrintingEnabled,
  savingKotPrintingEnabled,
  kdsEnabledSetting,
  pulseCustomMethods,
  markHydrationTouched,
  confirm,
}: PrintersSettingsTabProps) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const { refreshHardwarePrinter } = usePrinterStore();

  const [printerForm, setPrinterForm] = useState<PrinterForm>(emptyPrinterForm);
  const [showPrinterForm, setShowPrinterForm] = useState(false);
  const [editingPrinterId, setEditingPrinterId] = useState<string | null>(null);
  const [savingPrinter, setSavingPrinter] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);
  const [detectedPrinters, setDetectedPrinters] = useState<DetectedPrinter[]>([]);
  const [detectingPrinters, setDetectingPrinters] = useState(false);
  const [addingDetectedName, setAddingDetectedName] = useState<string | null>(null);
  const [installedPrintersOpen, setInstalledPrintersOpen] = useState(false);
  const [cashDrawerMethodsOpen, setCashDrawerMethodsOpen] = useState(false);

  const normalizePrinterWidthValue = (value?: string | null): string => {
    if (value === '58mm') return 'cols-32';
    if (value === '58mm-36') return 'cols-36';
    if (value === '80mm-42') return 'cols-42';
    if (value === '80mm') return 'cols-48';
    return /^cols-(32|36|40|42|44|48)$/.test(value || '') ? value! : 'cols-42';
  };

  const printWidthLabel = (value?: string | null): string => {
    const cols = normalizePrinterWidthValue(value).replace('cols-', '');
    return t('printColumnsShort', { cols });
  };

  const printerErrorMessage = (err: unknown, fallback: string): string => {
    if (axios.isAxiosError(err)) {
      const apiError = err.response?.data?.error;
      if (typeof apiError === 'string' && apiError.trim()) return `${fallback}: ${apiError}`;
    }
    return fallback;
  };

  const fetchPrinters = async (signal?: AbortSignal) => {
    try {
      const res = await api.get('/printers', signal ? { signal } : undefined);
      if (!signal?.aborted) setHwPrinters(res.data.printers || []);
    } catch {
      // ignore
    }
  };

  const fetchDetectedPrinters = useCallback(async (signal?: AbortSignal) => {
    setDetectingPrinters(true);
    try {
      const res = await api.get('/printers/detect', signal ? { signal } : undefined);
      if (!signal?.aborted) setDetectedPrinters(res.data.printers || []);
    } catch {
      if (!signal?.aborted) setDetectedPrinters([]);
    } finally {
      if (!signal?.aborted) setDetectingPrinters(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => fetchDetectedPrinters(controller.signal));
    return () => controller.abort();
  }, [fetchDetectedPrinters, isActive]);

  const quickAddDetected = async (p: DetectedPrinter) => {
    setAddingDetectedName(p.name);
    try {
      const payload: {
        name: string;
        connection_type: 'network' | 'usb';
        paper_width: string;
        ip_address?: string;
        port?: number;
      } = {
        name: p.name,
        connection_type: p.connectionType === 'network' ? 'network' : 'usb',
        paper_width: normalizePrinterWidthValue(p.paperWidth),
      };
      if (p.connectionType === 'network') {
        payload.ip_address = p.ipAddress || '';
        payload.port = p.port || 9100;
      }
      await api.post('/printers', payload);
      toast.success(t('printerQuickAdded', { name: p.name }));
      fetchPrinters();
      refreshHardwarePrinter();
    } catch {
      toast.error(t('printerAddFailed'));
    } finally {
      setAddingDetectedName(null);
    }
  };

  const openAddPrinter = () => {
    setPrinterForm(emptyPrinterForm);
    setEditingPrinterId(null);
    setShowPrinterForm(true);
  };

  const openEditPrinter = (p: HwPrinter) => {
    setPrinterForm({
      name: p.name,
      connection_type: p.connection_type,
      ip_address: p.ip_address || '',
      port: String(p.port || 9100),
      paper_width: normalizePrinterWidthValue(p.paper_width),
    });
    setEditingPrinterId(p.id);
    setShowPrinterForm(true);
  };

  const savePrinterHw = async () => {
    if (!printerForm.name) {
      toast.error(t('printerNameRequired'));
      return;
    }
    setSavingPrinter(true);
    try {
      const payload = {
        name: printerForm.name,
        connection_type: printerForm.connection_type,
        ip_address: printerForm.connection_type === 'network' ? printerForm.ip_address : undefined,
        port: printerForm.connection_type === 'network' ? Number(printerForm.port) : undefined,
        paper_width: printerForm.paper_width,
      };
      if (editingPrinterId) {
        await api.put(`/printers/${editingPrinterId}`, payload);
        toast.success(t('printerUpdated'));
      } else {
        await api.post('/printers', payload);
        toast.success(t('printerSaved'));
      }
      fetchPrinters();
      refreshHardwarePrinter();
      setShowPrinterForm(false);
    } catch (err) {
      toast.error(printerErrorMessage(err, t('printerSaveFailed')));
    } finally {
      setSavingPrinter(false);
    }
  };

  const deletePrinterHw = async (id: string) => {
    if (!await confirm(t('printerDeleteConfirm'), { destructive: true, confirmLabel: tCommon('delete') })) return;
    try {
      await api.delete(`/printers/${id}`);
      toast.success(t('printerDeleted'));
      fetchPrinters();
      refreshHardwarePrinter();
    } catch {
      toast.error(t('printerDeleteFailed'));
    }
  };

  const setDefaultPrinter = async (id: string) => {
    try {
      await api.post(`/printers/${id}/set-default`);
      toast.success(t('defaultPrinterSet'));
      fetchPrinters();
      refreshHardwarePrinter();
    } catch {
      toast.error(t('actionFailed'));
    }
  };

  const testPrinterHw = async (printer: HwPrinter) => {
    if (printer.connection_type === 'webusb') {
      toast(t('webusbTestHint'));
      return;
    }
    setTestingPrinterId(printer.id);
    try {
      await api.post(`/printers/${printer.id}/test`);
      toast.success(t('testPrintSent'));
    } catch (err) {
      toast.error(printerErrorMessage(err, t('testPrintFailed')));
    } finally {
      setTestingPrinterId(null);
    }
  };

  return (
    <SettingsTabShell maxWidth="wide">
      <div className="space-y-6">
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Printer size={20} className="text-muted-foreground" />
              <h2 className="font-semibold text-foreground">{t('printers')}</h2>
            </div>
            {!showPrinterForm && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { void fetchDetectedPrinters(); }}
                  disabled={detectingPrinters}
                  title={t('refreshList')}
                  className="flex items-center gap-2 px-3 py-2 text-sm border border-border text-muted-foreground rounded-lg hover:bg-muted font-medium disabled:opacity-50"
                >
                  <RefreshCw size={14} className={detectingPrinters ? 'animate-spin' : ''} /> {t('refresh')}
                </button>
                <button
                  onClick={openAddPrinter}
                  className="flex items-center gap-2 px-4 py-2 text-sm border border-border text-muted-foreground rounded-lg hover:bg-muted font-medium"
                >
                  <Plus size={14} /> {t('addPrinterManually')}
                </button>
              </div>
            )}
          </div>

          {/* Detected (OS-installed) printers - one-click add */}
          {!showPrinterForm && (
            <div className="mb-5">
              <button
                type="button"
                onClick={() => setInstalledPrintersOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-3 border-y border-border py-3 text-start"
                aria-expanded={installedPrintersOpen}
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('installedOnThisComputer')} ({detectedPrinters.length})
                </span>
                <ChevronDown
                  size={16}
                  className={`text-muted-foreground transition-transform ${
                    installedPrintersOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>
              {installedPrintersOpen &&
                (detectingPrinters && detectedPrinters.length === 0 ? (
                  <div className="py-6 text-center text-muted-foreground text-sm">
                    {t('scanningForPrinters')}
                  </div>
                ) : detectedPrinters.length === 0 ? (
                  <div className="mt-2 py-6 text-center text-muted-foreground text-sm border border-dashed border-border rounded-lg">
                    {t('noInstalledPrinters')}
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    {detectedPrinters.map((p) => {
                      const alreadyAdded = hwPrinters.some(
                        (h) => h.name.toLowerCase() === p.name.toLowerCase()
                      );
                      const isAdding = addingDetectedName === p.name;
                      const dotColor =
                        p.status === 'idle'
                          ? 'bg-green-500'
                          : p.status === 'printing'
                          ? 'bg-yellow-500'
                          : 'bg-gray-300 dark:bg-muted';
                      const statusLabel =
                        p.status === 'idle'
                          ? t('printerOnline')
                          : p.status === 'printing'
                          ? t('printerPrinting')
                          : t('printerOffline');
                      return (
                        <div
                          key={p.name}
                          className="flex items-center gap-3 rounded-xl border border-border p-3"
                        >
                          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-muted shrink-0">
                            {p.connectionType === 'network' ? (
                              <Wifi size={18} className="text-muted-foreground" />
                            ) : (
                              <Usb size={18} className="text-muted-foreground" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-foreground text-sm truncate">{p.name}</span>
                              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                                {statusLabel}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">
                              {p.make !== 'Unknown' ? `${p.make} ${p.model}` : p.model}
                              {p.connectionType === 'network' && p.ipAddress ? (
                                <>
                                  {' · '}
                                  <Ltr>
                                    {p.ipAddress}
                                    {p.port ? ':' + p.port : ''}
                                  </Ltr>
                                </>
                              ) : (
                                ''
                              )}
                              {p.paperWidth ? ` · ${printWidthLabel(p.paperWidth)}` : ''}
                              {p.profileId ? ` · ${t('printerSupportedProfile')}` : ''}
                            </p>
                          </div>
                          {alreadyAdded ? (
                            <span className="text-xs text-muted-foreground px-3 py-1.5 flex items-center gap-1">
                              <CheckCircle2 size={14} className="text-green-500" /> {t('printerAdded')}
                            </span>
                          ) : (
                            <button
                              onClick={() => quickAddDetected(p)}
                              disabled={isAdding}
                              className="px-3 py-1.5 text-xs bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium flex items-center gap-1"
                            >
                              <Plus size={13} /> {isAdding ? t('printerAdding') : tCommon('add')}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
            </div>
          )}

          {/* Configured printer list */}
          {hwPrinters.length === 0 && !showPrinterForm && (
            <div className="py-6 text-center text-muted-foreground">
              <p className="text-sm">{t('noPrintersConfigured')}</p>
              <p className="text-xs mt-1">{t('printerHint')}</p>
            </div>
          )}

          {hwPrinters.length > 0 && !showPrinterForm && (
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {t('configuredPrinters')}
            </h3>
          )}
          <div className="space-y-3">
            {hwPrinters.map((p) => (
              <div
                key={p.id}
                className={`flex items-center gap-3 rounded-xl border p-4 ${
                  p.is_default ? 'border-brand bg-brand/5' : 'border-border'
                }`}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-muted shrink-0">
                  {p.connection_type === 'network' ? (
                    <Wifi size={18} className="text-muted-foreground" />
                  ) : p.connection_type === 'webusb' ? (
                    <Usb size={18} className="text-blue-500" />
                  ) : (
                    <Usb size={18} className="text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground text-sm">{p.name}</span>
                    {p.is_default === 1 && (
                      <span className="text-[10px] bg-brand/10 text-brand px-2 py-0.5 rounded-full font-medium">
                        {t('defaultPrinter')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {p.connection_type === 'network' ? (
                      <Ltr>
                        {p.ip_address}:{p.port}
                      </Ltr>
                    ) : p.connection_type === 'usb' ? (
                      t('connectionUsb')
                    ) : (
                      t('browserWebusb')
                    )}
                    {' · '}
                    {printWidthLabel(p.paper_width)}
                    {p.profile_name ? ` · ${p.profile_name}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => testPrinterHw(p)}
                    disabled={testingPrinterId === p.id}
                    title={t('testPrint')}
                    className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    <TestTube2 size={15} />
                  </button>
                  {p.is_default !== 1 && (
                    <button
                      onClick={() => setDefaultPrinter(p.id)}
                      title={t('setAsDefault')}
                      className="p-2 rounded-lg hover:bg-yellow-50 dark:hover:bg-yellow-950/40 text-muted-foreground hover:text-yellow-600 dark:hover:text-yellow-400"
                    >
                      <Star size={15} />
                    </button>
                  )}
                  <button
                    onClick={() => openEditPrinter(p)}
                    title={t('edit')}
                    className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
                  >
                    <Settings size={15} />
                  </button>
                  <button
                    onClick={() => deletePrinterHw(p.id)}
                    title={t('delete')}
                    className="p-2 rounded-lg hover:bg-red-50 text-red-600 hover:text-red-700"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Add / Edit form */}
          {showPrinterForm && (
            <div className="mt-5 pt-5 border-t border-border">
              <h3 className="font-semibold text-foreground text-sm mb-4">
                {editingPrinterId ? t('editPrinter') : t('addPrinter')}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">{t('printerName')}</label>
                  <input
                    type="text"
                    value={printerForm.name}
                    onChange={(e) => setPrinterForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder={t('printerNamePlaceholder')}
                    list="detected-printer-names"
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  />
                  <datalist id="detected-printer-names">
                    {detectedPrinters.map((dp) => (
                      <option key={dp.name} value={dp.name} />
                    ))}
                  </datalist>
                  {printerForm.connection_type !== 'webusb' &&
                    printerForm.name.trim() &&
                    detectedPrinters.length > 0 &&
                    !detectedPrinters.some((dp) => dp.name === printerForm.name) && (
                      <p className="mt-1 text-xs text-amber-600">{t('printerNameMismatchWarning')}</p>
                    )}
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">{t('connectionType')}</label>
                  <select
                    value={printerForm.connection_type}
                    onChange={(e) =>
                      setPrinterForm((p) => ({
                        ...p,
                        connection_type: e.target.value as HwPrinter['connection_type'],
                      }))
                    }
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  >
                    <option value="network">{t('connectionNetwork')}</option>
                    <option value="usb">{t('connectionUsb')}</option>
                    <option value="webusb">{t('connectionWebusb')}</option>
                  </select>
                </div>

                {printerForm.connection_type === 'network' && (
                  <>
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1">{t('ipAddress')}</label>
                      <input
                        type="text"
                        value={printerForm.ip_address}
                        onChange={(e) => setPrinterForm((p) => ({ ...p, ip_address: e.target.value }))}
                        placeholder={t('ipAddressPlaceholder')}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                        dir="ltr"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1">{t('port')}</label>
                      <input
                        type="number"
                        value={printerForm.port}
                        onChange={(e) => setPrinterForm((p) => ({ ...p, port: e.target.value }))}
                        placeholder={t('portPlaceholder')}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                      />
                    </div>
                  </>
                )}

                {printerForm.connection_type === 'webusb' && (
                  <div className="md:col-span-2 bg-blue-50 dark:bg-blue-950/40 rounded-lg p-3 text-sm text-blue-700 dark:text-blue-300">
                    {t('webusbHint')}
                  </div>
                )}

                <div>
                  <label className="block text-xs text-muted-foreground mb-1">{t('paperWidth')}</label>
                  <select
                    value={printerForm.paper_width}
                    onChange={(e) => setPrinterForm((p) => ({ ...p, paper_width: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  >
                    <option value="cols-32">{t('printColumns32')}</option>
                    <option value="cols-36">{t('printColumns36')}</option>
                    <option value="cols-40">{t('printColumns40')}</option>
                    <option value="cols-42">{t('printColumns42')}</option>
                    <option value="cols-44">{t('printColumns44')}</option>
                    <option value="cols-48">{t('printColumns48')}</option>
                  </select>
                </div>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  onClick={savePrinterHw}
                  disabled={savingPrinter}
                  className="px-5 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium"
                >
                  {savingPrinter ? t('saving') : editingPrinterId ? tCommon('update') : t('addPrinter')}
                </button>
                <button
                  onClick={() => setShowPrinterForm(false)}
                  className="px-5 py-2 text-sm border border-border text-muted-foreground rounded-lg hover:bg-muted font-medium"
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/40 rounded-xl p-4 text-sm text-amber-800 dark:text-amber-300">
          <strong>{t('defaultPrinterTipTitle')}</strong> {t('defaultPrinterTipBody')}
        </div>

        {/* Print Options */}
        <div className="pt-4 border-t border-border">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('tabPrinting')}
          </h2>
        </div>

        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <Printer size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('printing')}</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground">{t('enablePrinter')}</p>
                <p className="text-sm text-muted-foreground">{t('enablePrinterHint')}</p>
              </div>
              <Toggle
                value={printingForm.printerEnabled}
                onChange={(v) => {
                  markHydrationTouched('printerEnabled');
                  setPrintingForm((p) => ({ ...p, printerEnabled: v }));
                }}
              />
            </div>
            <div className="border-t border-border pt-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground">{t('sendPulseToCashDrawer')}</p>
                  <p className="text-sm text-muted-foreground">{t('sendPulseToCashDrawerHint')}</p>
                </div>
                <Toggle
                  value={!!printingForm.cashDrawerPulseEnabled}
                  onChange={(v) => {
                    markHydrationTouched('cashDrawerPulseEnabled');
                    setPrintingForm((p) => ({ ...p, cashDrawerPulseEnabled: v }));
                  }}
                />
              </div>
              {printingForm.cashDrawerPulseEnabled && (
                <div className="mt-3 rounded-lg border border-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setCashDrawerMethodsOpen((open) => !open)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-start text-sm font-medium text-foreground hover:bg-muted"
                  >
                    <span>{t('cashDrawerPulsePaymentOptions')}</span>
                    <ChevronDown
                      size={16}
                      className={`text-muted-foreground transition-transform ${
                        cashDrawerMethodsOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {cashDrawerMethodsOpen && (
                    <div className="border-t border-border bg-muted/30 px-3 py-2 space-y-2">
                      {([
                        ['cash', t('paymentMethodCash')],
                        ['card', t('paymentMethodCard')],
                        ...pulseCustomMethods.map((name): [string, string] => [name, name]),
                      ] as [string, string][]).map(([value, label]) => (
                        <label key={value} className="flex items-center gap-2 text-sm text-foreground">
                          <input
                            type="checkbox"
                            checked={printingForm.cashDrawerPulseMethods.includes(value)}
                            onChange={(e) => {
                              markHydrationTouched('cashDrawerPulseMethods');
                              setPrintingForm((p) => ({
                                ...p,
                                cashDrawerPulseMethods: e.target.checked
                                  ? [...p.cashDrawerPulseMethods, value]
                                  : p.cashDrawerPulseMethods.filter((method) => method !== value),
                              }));
                            }}
                            className="h-4 w-4 rounded border-border text-brand focus:ring-brand"
                          />
                          {label}
                        </label>
                      ))}
                      <p className="pt-1 text-xs text-muted-foreground">
                        {t('cashDrawerPulsePaymentOptionsHint')}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div>
              <p className="font-medium text-foreground mb-2">{t('printMethod')}</p>
              <select
                value={printingForm.printMethod}
                onChange={(e) => {
                  markHydrationTouched('printMethod');
                  setPrintingForm((p) => ({ ...p, printMethod: e.target.value as 'escpos' | 'browser' }));
                }}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              >
                <option value="escpos">{t('printMethodEscpos')}</option>
                <option value="browser">{t('printMethodBrowser')}</option>
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {printingForm.printMethod === 'escpos'
                  ? t('printMethodEscposHint')
                  : t('printMethodBrowserHint')}
              </p>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground">{t('kotPrintingEnabledToggle')}</p>
                <p className="text-sm text-muted-foreground">{t('kotPrintingEnabledToggleHint')}</p>
              </div>
              <Toggle
                value={kotPrintingEnabledSetting}
                onChange={(v) => {
                  if (!savingKotPrintingEnabled) saveKotPrintingEnabled(v);
                }}
              />
            </div>
            <div
              className={`flex items-center justify-between gap-4 ${
                !kotPrintingEnabledSetting ? 'opacity-50' : ''
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground">{t('autoPrintKot')}</p>
                <p className="text-sm text-muted-foreground">
                  {kotPrintingEnabledSetting ? t('autoPrintKotHint') : t('autoPrintKotDisabledHint')}
                </p>
              </div>
              <Toggle
                value={printingForm.autoPrintKot && kotPrintingEnabledSetting}
                onChange={(v) => {
                  if (kotPrintingEnabledSetting) {
                    markHydrationTouched('autoPrintKot');
                    setPrintingForm((p) => ({ ...p, autoPrintKot: v }));
                  }
                }}
              />
            </div>
            {!kdsEnabledSetting && !kotPrintingEnabledSetting && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/40 rounded-lg">
                <AlertTriangle size={16} className="text-amber-600 dark:text-amber-300 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {t('kitchenWorkflowBothOffNote')}
                </p>
              </div>
            )}
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground">{t('autoPrintBill')}</p>
                <p className="text-sm text-muted-foreground">{t('autoPrintBillHint')}</p>
              </div>
              <Toggle
                value={printingForm.autoPrintBill}
                onChange={(v) => {
                  markHydrationTouched('autoPrintBill');
                  setPrintingForm((p) => ({ ...p, autoPrintBill: v }));
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground">{t('printerUnicode')}</p>
                <p className="text-sm text-muted-foreground">{t('printerUnicodeHint')}</p>
              </div>
              <Toggle
                value={printingForm.printerUseUnicode}
                onChange={(v) => {
                  markHydrationTouched('printerUseUnicode');
                  setPrintingForm((p) => ({ ...p, printerUseUnicode: v }));
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground">{t('printerArabicShaping')}</p>
                <p className="text-sm text-muted-foreground">{t('printerArabicShapingHint')}</p>
              </div>
              <Toggle
                value={printingForm.printerArabicShaping}
                onChange={(v) => {
                  markHydrationTouched('printerArabicShaping');
                  setPrintingForm((p) => ({ ...p, printerArabicShaping: v }));
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground">{t('trimDecimals')}</p>
                <p className="text-sm text-muted-foreground">{t('trimDecimalsHint')}</p>
              </div>
              <Toggle
                value={printingForm.printerTrimDecimals}
                onChange={(v) => {
                  markHydrationTouched('printerTrimDecimals');
                  setPrintingForm((p) => ({ ...p, printerTrimDecimals: v }));
                }}
              />
            </div>
            <div className="pt-4 border-t border-border">
              <p className="font-medium text-foreground mb-1">{t('receiptLanguage')}</p>
              <p className="text-sm text-muted-foreground mb-3">{t('receiptLanguageHint')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                <div>
                  <label
                    htmlFor="receipt-primary-language"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {t('receiptLanguage')}
                  </label>
                  <select
                    id="receipt-primary-language"
                    value={printingForm.receiptPrimaryLanguage}
                    onChange={(e) => {
                      markHydrationTouched('receiptPrimaryLanguage');
                      setPrintingForm((p) => ({ ...p, receiptPrimaryLanguage: e.target.value }));
                    }}
                    className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                  >
                    <option value="inherit">{t('sameAsStore')}</option>
                    {SELECTABLE_LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>
                        {LANGUAGES[lang].nativeName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="receipt-second-language"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {t('secondReceiptLanguage')}
                  </label>
                  <select
                    id="receipt-second-language"
                    value={printingForm.receiptSecondLanguage}
                    onChange={(e) => {
                      markHydrationTouched('receiptSecondLanguage');
                      setPrintingForm((p) => ({ ...p, receiptSecondLanguage: e.target.value }));
                    }}
                    className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                  >
                    <option value="none">{t('secondLanguageNone')}</option>
                    {SELECTABLE_LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>
                        {LANGUAGES[lang].nativeName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="kot-language" className="block text-sm font-medium text-foreground mb-1">
                    {t('kotPrintLanguage')}
                  </label>
                  <select
                    id="kot-language"
                    value={printingForm.kotLanguage}
                    onChange={(e) => {
                      markHydrationTouched('kotLanguage');
                      setPrintingForm((p) => ({ ...p, kotLanguage: e.target.value }));
                    }}
                    className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                  >
                    <option value="inherit">{t('sameAsStore')}</option>
                    {SELECTABLE_LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>
                        {LANGUAGES[lang].nativeName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="z-report-primary-language"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {t('zReportLanguage')}
                  </label>
                  <select
                    id="z-report-primary-language"
                    value={printingForm.zReportPrimaryLanguage}
                    onChange={(e) => {
                      markHydrationTouched('zReportPrimaryLanguage');
                      setPrintingForm((p) => ({ ...p, zReportPrimaryLanguage: e.target.value }));
                    }}
                    className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                  >
                    <option value="inherit">{t('sameAsStore')}</option>
                    {SELECTABLE_LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>
                        {LANGUAGES[lang].nativeName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="z-report-second-language"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {t('secondZReportLanguage')}
                  </label>
                  <select
                    id="z-report-second-language"
                    value={printingForm.zReportSecondLanguage}
                    onChange={(e) => {
                      markHydrationTouched('zReportSecondLanguage');
                      setPrintingForm((p) => ({ ...p, zReportSecondLanguage: e.target.value }));
                    }}
                    className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                  >
                    <option value="none">{t('secondLanguageNone')}</option>
                    {SELECTABLE_LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>
                        {LANGUAGES[lang].nativeName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">{t('kotPrintLanguageHint')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('zReportLanguageHint')}</p>
            </div>
            <div className="pt-4 border-t border-border">
              <p className="font-medium text-foreground mb-1">{t('billContent')}</p>
              <p className="text-sm text-muted-foreground mb-3">{t('billContentHint')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                {(
                  [
                    { label: t('showRestaurantName'), key: 'billShowName' as const },
                    { label: t('showRestaurantAddress'), key: 'billShowAddress' as const },
                    { label: t('showRestaurantPhone'), key: 'billShowPhone' as const },
                    { label: t('showTaxId'), key: 'billShowTaxId' as const },
                    { label: t('showTaxBreakdown'), key: 'billShowTaxBreakdown' as const },
                    { label: t('showCustomerName'), key: 'billShowCustomerName' as const },
                    { label: t('showCustomerPhone'), key: 'billShowCustomerPhone' as const },
                    { label: t('showTableNumber'), key: 'billShowTableNumber' as const },
                  ] as const
                ).map((item) => (
                  <div key={item.key} className="flex min-h-11 items-center justify-between gap-3 py-1">
                    <span className="text-sm text-foreground">{item.label}</span>
                    <Toggle
                      value={printingForm[item.key]}
                      onChange={(value) => {
                        markHydrationTouched(item.key);
                        setPrintingForm((previous) => ({ ...previous, [item.key]: value }));
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 border-t border-border pt-4">
                <label
                  htmlFor="footer-message"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  {t('footerMessage')}
                </label>
                <textarea
                  id="footer-message"
                  rows={2}
                  placeholder={t('footerMessagePlaceholder')}
                  value={billForm.billFooterMessage}
                  onChange={(e) => {
                    markHydrationTouched('billFooterMessage');
                    setBillForm((p) => ({ ...p, billFooterMessage: e.target.value }));
                  }}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand resize-none"
                />
                <p className="text-xs text-muted-foreground mt-1">{t('footerMessageHint')}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <Share2 size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('whatsappSharing')}</h2>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-foreground">{t('enableWhatsappShare')}</p>
              <p className="text-sm text-muted-foreground">{t('enableWhatsappShareHint')}</p>
            </div>
            <Toggle
              value={printingForm.whatsappShareEnabled}
              onChange={(v) => {
                markHydrationTouched('whatsappShareEnabled');
                setPrintingForm((p) => ({ ...p, whatsappShareEnabled: v }));
              }}
            />
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <FileText size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('billTemplate')}</h2>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {billTemplateCards.map((card) => {
              const isSelected = isTemplateCardSelected(billForm, card);
              return (
                <button
                  key={card.id}
                  onClick={() => {
                    markHydrationTouched('billTemplate');
                    markHydrationTouched('billTemplateSource');
                    setBillForm((p) => ({
                      ...p,
                      billTemplate: card.id,
                      billTemplateSource: card.selectionSource,
                    }));
                  }}
                  className={`text-start rounded-xl border-2 p-4 transition-all ${
                    isSelected
                      ? 'border-brand bg-brand/5'
                      : 'border-border hover:border-gray-300 dark:border-border bg-card'
                  }`}
                >
                  <p className="font-semibold text-foreground mb-2 flex items-center gap-2">
                    <span className="flex-1">{card.nameKey ? t(card.nameKey) : card.displayName}</span>
                    {card.source === 'merchant' && card.originBadgeKey && (
                      <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                        {t(card.originBadgeKey)}
                      </span>
                    )}
                  </p>
                  <pre className="font-mono text-[9px] leading-tight text-muted-foreground bg-muted p-2 rounded overflow-hidden mb-3 whitespace-pre">
                    {card.preview}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    {card.source === 'plugin' || card.source === 'merchant'
                      ? card.description
                      : card.id === 'classic'
                      ? t('billTemplateClassicDesc')
                      : t('billTemplateCompactDesc')}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </SettingsTabShell>
  );
}
