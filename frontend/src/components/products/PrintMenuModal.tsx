'use client';

import { useEffect, useState } from 'react';
import { Check, FileDown, FileText, LoaderCircle, Printer, Receipt } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuthStore } from '@/store/auth';
import { usePrinterStore, type HardwarePrinter } from '@/hooks/usePrinter';
import { printerService } from '@/lib/printer/PrinterService';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { formatDateForTenant } from '@/lib/countries';
import type { Category, Product } from '@/lib/types';
import { buildMenuWebPrintHtml, MenuPopupBlockedError, printMenuInBrowser, reservePrintGesture, type MenuWebPrintSection } from '@/lib/printer/menu-web-print';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PrintFilters {
  includeInactive: boolean;
  includeOutOfStock: boolean;
  includeHidden: boolean;
  includeDescriptions: boolean;
  includeModifiers: boolean;
}

/** Where the rendered menu goes: thermal roll, system print dialog, or a PDF file. */
type PrintDestination = 'receipt' | 'paper' | 'pdf';

const DESTINATIONS: Array<{ id: PrintDestination; labelKey: 'printToReceipt' | 'printToPaper' | 'printToPdf'; Icon: typeof Printer }> = [
  { id: 'receipt', labelKey: 'printToReceipt', Icon: Receipt },
  { id: 'paper', labelKey: 'printToPaper', Icon: FileText },
  { id: 'pdf', labelKey: 'printToPdf', Icon: FileDown },
];

function isOutOfStock(product: Product): boolean {
  return product.track_inventory && Number(product.stock_quantity) <= 0;
}

export default function PrintMenuModal({ open, onOpenChange }: Props) {
  const t = useTranslations('products');
  const tCommon = useTranslations('common');
  const tPrint = useTranslations('print.menu');
  const tSettings = useTranslations('settings');
  const tPos = useTranslations('pos');
  const tenant = useAuthStore((state) => state.currentTenant);
  const formatCurrency = useFormatCurrency();
  const refreshHardwarePrinter = usePrinterStore((state) => state.refreshHardwarePrinter);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [includeOutOfStock, setIncludeOutOfStock] = useState(false);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [includeDescriptions, setIncludeDescriptions] = useState(false);
  const [includeModifiers, setIncludeModifiers] = useState(false);
  const [destination, setDestination] = useState<PrintDestination>('paper');
  const [pageSize, setPageSize] = useState<'A4' | 'Letter'>('A4');
  const [paperWidth, setPaperWidth] = useState<58 | 80>(58);
  const [printers, setPrinters] = useState<HardwarePrinter[]>([]);
  const [selectedPrinterId, setSelectedPrinterId] = useState('');
  const [printing, setPrinting] = useState(false);

  // Loads the configured printers when the dialog opens; the request is
  // inlined so state only settles in async continuations.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void refreshHardwarePrinter();
    api.get('/printers')
      .then((res) => {
        if (cancelled) return;
        const list = (res.data?.printers || []) as HardwarePrinter[];
        setPrinters(list);
        setSelectedPrinterId((current) => {
          if (current && list.some((printer) => printer.id === current)) return current;
          const preferred = list.find((printer) => printer.is_default === 1)
            ?? list.find((printer) => printer.connection_type !== 'webusb')
            ?? list[0];
          return preferred ? preferred.id : '';
        });
      })
      .catch(() => {
        if (cancelled) return;
        setPrinters([]);
        setSelectedPrinterId('');
      });
    return () => { cancelled = true; };
  }, [open, refreshHardwarePrinter]);

  const setDialogOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      setIncludeInactive(false);
      setIncludeOutOfStock(false);
      setIncludeHidden(false);
      setIncludeDescriptions(false);
      setIncludeModifiers(false);
    }
    onOpenChange(nextOpen);
  };

  const filters: PrintFilters = { includeInactive, includeOutOfStock, includeHidden, includeDescriptions, includeModifiers };

  /** Renders the selected catalog into the standalone print HTML both paper
   *  printing and PDF export share. */
  const buildMenuHtml = async (selectedFilters: PrintFilters): Promise<string | null> => {
    const [productResponse, categoryResponse] = await Promise.all([
      api.get('/products'),
      api.get('/categories'),
    ]);
    const products = (productResponse.data.products || []) as Product[];
    const categories = (categoryResponse.data.categories || []) as Category[];
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const included = products.filter((product) =>
      (selectedFilters.includeInactive || product.is_active)
      && (selectedFilters.includeOutOfStock || !isOutOfStock(product))
      && (selectedFilters.includeHidden || !product.category_id || categoryById.get(product.category_id)?.is_active === true));
    const toPrintProduct = (product: Product) => ({
      name: product.name,
      price: formatCurrency(Number(product.price)),
      details: [
        ...(selectedFilters.includeDescriptions && product.description ? [product.description] : []),
        ...(selectedFilters.includeModifiers ? (product.addon_groups || []).map((group) =>
          `${group.name}: ${(group.addons || []).filter((addon) => addon.is_active).map((addon) => `${addon.name} (${formatCurrency(Number(addon.price))})`).join(', ')}`) : []),
      ],
    });
    const sections: MenuWebPrintSection[] = categories
      .map((category) => ({
        name: category.name,
        products: included
          .filter((product) => product.category_id === category.id)
          .map(toPrintProduct),
      }))
      .filter((section) => section.products.length > 0);
    const uncategorized = included
      .filter((product) => !product.category_id || !categoryById.has(product.category_id))
      .map(toPrintProduct);
    if (uncategorized.length > 0) sections.push({ name: null, products: uncategorized });
    const itemCount = sections.reduce((total, section) => total + section.products.length, 0);
    if (itemCount === 0) {
      toast.error(t('noProductsToPrint'));
      return null;
    }

    const printedAt = formatDateForTenant(
      new Date(),
      tenant?.country || '',
      tenant?.timezone || 'UTC',
      {
        currencyDisplay: tenant?.currency_display,
        digits: tenant?.number_digits,
        calendar: tenant?.calendar,
      },
      { dateStyle: 'medium', timeStyle: 'short' },
    );
    return buildMenuWebPrintHtml({
      businessName: tenant?.business_name || 'Store',
      printedAt,
      sections,
      itemCount,
      menuTitle: tPrint('title'),
      totalItemsLabel: tPrint('totalItems'),
      pageSize,
    });
  };

  /** System print dialog: the browser path used by paper output and by the
   *  browser fallback when no thermal transport is available. */
  const printOnPaper = async (selectedFilters: PrintFilters, targetWindow?: Window | null): Promise<boolean> => {
    const html = await buildMenuHtml(selectedFilters);
    if (html === null) return false;
    printMenuInBrowser(html, targetWindow);
    toast.success(t('menuPrintedSuccess'));
    return true;
  };

  /** PDF export. Electron renders the HTML offscreen and asks where to save;
   *  a plain browser falls back to the print dialog's "Save as PDF". */
  const savePdf = async (selectedFilters: PrintFilters): Promise<boolean> => {
    const html = await buildMenuHtml(selectedFilters);
    if (html === null) return false;
    const saveHtmlAsPdf = window.electronAPI?.saveHtmlAsPdf;
    if (!saveHtmlAsPdf) {
      printMenuInBrowser(html);
      toast.success(tCommon('done'));
      return true;
    }
    const result = await saveHtmlAsPdf({
      html,
      defaultFileName: `${tenant?.business_name || 'menu'}-menu.pdf`,
      pageSize,
    });
    if (result?.canceled) return false;
    if (!result?.success) throw new Error(result?.error || t('menuPrintFailed'));
    toast.success(tCommon('done'));
    return true;
  };

  /** Sends ESC/POS to the chosen receipt printer; WebUSB printers receive the
   *  encoded bytes over the browser transport instead. */
  const printToReceipt = async (selectedFilters: PrintFilters, targetWindow?: Window | null): Promise<boolean> => {
    const response = await api.post('/printers/print-menu', {
      ...selectedFilters,
      ...(selectedPrinterId ? { printerId: selectedPrinterId } : {}),
      paperWidth,
    });
    if (response.data.webusb === true) {
      const bytes = response.data.bytes;
      if (!Array.isArray(bytes) || !bytes.every((byte: unknown) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255)) {
        throw new Error('Invalid printer data');
      }
      if (!printerService.isConnected) await printerService.tryReconnect();
      if (!printerService.isConnected) throw new Error('WebUSB printer is not connected');
      await printerService.print(new Uint8Array(bytes));
    }
    if (targetWindow && !targetWindow.closed) targetWindow.close();
    toast.success(t('menuPrintedSuccess'));
    return true;
  };

  const handlePrint = async () => {
    if (printing) return;
    setPrinting(true);

    if (destination === 'paper' || destination === 'pdf') {
      try {
        const printed = destination === 'paper'
          ? await printOnPaper(filters)
          : await savePdf(filters);
        if (printed) setDialogOpen(false);
      } catch (error) {
        toast.error(error instanceof MenuPopupBlockedError ? t('menuPopupBlocked') : t('menuPrintFailed'));
      } finally {
        setPrinting(false);
      }
      return;
    }

    // Preserve the user gesture for browsers that block asynchronous popups:
    // a failed thermal print falls back to the system print dialog.
    const reservedWindow = reservePrintGesture();
    try {
      await printToReceipt(filters, reservedWindow);
      setDialogOpen(false);
    } catch (error) {
      const failure = error as {
        response?: { status?: number; data?: { code?: string } };
      };
      const status = failure.response?.status;
      const code = failure.response?.data?.code;
      if (code === 'no_products_to_print') {
        if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
        toast.error(t('noProductsToPrint'));
      } else if (status === 401 || status === 403) {
        if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
        toast.error(t('menuPrintFailed'));
      } else if (code === 'printer_not_configured' || code === 'printer_not_found' || status === 502 || (status !== undefined && status >= 500) || status === undefined) {
        try {
          if (await printOnPaper(filters, reservedWindow)) {
            setDialogOpen(false);
          } else if (reservedWindow && !reservedWindow.closed) {
            reservedWindow.close();
          }
        } catch (popupError) {
          if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
          toast.error(popupError instanceof MenuPopupBlockedError ? t('menuPopupBlocked') : t('menuPrintFailed'));
        }
      } else {
        if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
        toast.error(t('menuPrintFailed'));
      }
    } finally {
      setPrinting(false);
    }
  };

  const filterRow = (label: string, checked: boolean, onChange: (value: boolean) => void) => (
    <button
      key={label}
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={printing}
      onClick={() => onChange(!checked)}
      className="touch-target flex min-h-12 w-full items-center justify-between gap-6 px-4 text-start text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">{label}</span>
      <span className={`flex size-6 shrink-0 items-center justify-center rounded border ${checked ? 'border-brand bg-brand text-white' : 'border-input bg-background'}`}>
        {checked && <Check size={16} aria-hidden="true" />}
      </span>
    </button>
  );

  const usesPaper = destination === 'paper' || destination === 'pdf';
  // A missing picker is not a dead end: the receipt path still asks the
  // backend, which falls back to the configured default printer and, when
  // there is none, into the system print dialog.
  const noListedPrinter = destination === 'receipt' && printers.length === 0;
  const primaryIcon = destination === 'pdf'
    ? <FileDown className="me-2" size={16} aria-hidden="true" />
    : <Printer className="me-2" size={16} aria-hidden="true" />;

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogContent className="max-w-xl">
        <DialogHeader className="text-start">
          <DialogTitle className="flex items-center gap-2">
            <Printer size={18} aria-hidden="true" /> {t('printMenu')}
          </DialogTitle>
          <DialogDescription>{t('printMenuDescription')}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto pe-1">
          <div className="divide-y divide-border rounded-lg border border-border">
            {filterRow(t('includeInactiveItems'), includeInactive, setIncludeInactive)}
            {filterRow(t('includeOutOfStockItems'), includeOutOfStock, setIncludeOutOfStock)}
            {filterRow(t('includeHiddenItems'), includeHidden, setIncludeHidden)}
            {filterRow(t('includeDescriptions'), includeDescriptions, setIncludeDescriptions)}
            {filterRow(t('includeModifiers'), includeModifiers, setIncludeModifiers)}
          </div>

          <div className="space-y-3 rounded-lg border border-border p-4">
            <span className="block text-sm font-medium text-foreground">{t('printDestination')}</span>
            <div role="radiogroup" aria-label={t('printDestination')} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {DESTINATIONS.map(({ id, labelKey, Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={destination === id}
                  disabled={printing}
                  onClick={() => setDestination(id)}
                  className={`touch-target flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border px-3 text-center text-xs font-medium transition-colors disabled:opacity-50 ${
                    destination === id
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <Icon size={18} aria-hidden="true" />
                  {t(labelKey)}
                </button>
              ))}
            </div>

            {usesPaper ? (
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>{tSettings('paperSize')}</span>
                <select
                  aria-label={tSettings('paperSize')}
                  value={pageSize}
                  disabled={printing}
                  onChange={(event) => setPageSize(event.target.value as 'A4' | 'Letter')}
                  className="min-h-11 rounded-md border border-input bg-background px-3"
                >
                  <option value="A4">A4</option>
                  <option value="Letter">Letter</option>
                </select>
              </label>
            ) : (
              <>
                <label className="flex items-center justify-between gap-4 text-sm">
                  <span>{t('printerDestination')}</span>
                  <select
                    aria-label={t('printerDestination')}
                    value={selectedPrinterId}
                    disabled={printing || printers.length === 0}
                    onChange={(event) => setSelectedPrinterId(event.target.value)}
                    className="min-h-11 max-w-[60%] rounded-md border border-input bg-background px-3"
                  >
                    {printers.map((printer) => (
                      <option key={printer.id} value={printer.id}>{printer.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center justify-between gap-4 text-sm">
                  <span>{tSettings('paperSize')}</span>
                  <select
                    aria-label={tSettings('paperSize')}
                    value={paperWidth}
                    disabled={printing}
                    onChange={(event) => setPaperWidth(Number(event.target.value) === 80 ? 80 : 58)}
                    className="min-h-11 rounded-md border border-input bg-background px-3"
                  >
                    <option value={58}>{tSettings('paperSize58')}</option>
                    <option value={80}>{tSettings('paperSize80')}</option>
                  </select>
                </label>
                {noListedPrinter && (
                  <p className="text-xs text-muted-foreground">{tPos('noPrinters')}</p>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter className="flex-row justify-end">
          <Button variant="outline" className="min-h-11" disabled={printing} onClick={() => setDialogOpen(false)}>
            {tCommon('cancel')}
          </Button>
          <Button className="min-h-11" disabled={printing} onClick={handlePrint}>
            {printing ? <LoaderCircle className="me-2 animate-spin" size={16} aria-hidden="true" /> : primaryIcon}
            {destination === 'pdf' ? t('printToPdf') : t('printMenu')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
