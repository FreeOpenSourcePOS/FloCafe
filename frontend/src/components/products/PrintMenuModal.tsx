'use client';

import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Printer } from 'lucide-react';
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
import { usePrinterStore } from '@/hooks/usePrinter';
import { printerService } from '@/lib/printer/PrinterService';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { formatDateForTenant } from '@/lib/countries';
import type { Category, Product } from '@/lib/types';
import { buildMenuWebPrintHtml, MenuPopupBlockedError, printMenuInBrowser, type MenuWebPrintSection } from '@/lib/printer/menu-web-print';

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

function isOutOfStock(product: Product): boolean {
  return product.track_inventory && Number(product.stock_quantity) <= 0;
}

export default function PrintMenuModal({ open, onOpenChange }: Props) {
  const t = useTranslations('products');
  const tCommon = useTranslations('common');
  const tPrint = useTranslations('print.menu');
  const tSettings = useTranslations('settings');
  const tenant = useAuthStore((state) => state.currentTenant);
  const formatCurrency = useFormatCurrency();
  const hardwarePrinter = usePrinterStore((state) => state.hardwarePrinter);
  const webusbPrinter = usePrinterStore((state) => state.webusbPrinter);
  const refreshHardwarePrinter = usePrinterStore((state) => state.refreshHardwarePrinter);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [includeOutOfStock, setIncludeOutOfStock] = useState(false);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [includeDescriptions, setIncludeDescriptions] = useState(false);
  const [includeModifiers, setIncludeModifiers] = useState(false);
  const [pageSize, setPageSize] = useState<'A4' | 'Letter'>('A4');
  const [printing, setPrinting] = useState(false);
  const printer = hardwarePrinter ?? webusbPrinter;

  useEffect(() => {
    if (!open) return;
    void refreshHardwarePrinter();
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

  const printBrowserFallback = async (selectedFilters: PrintFilters, targetWindow?: Window | null) => {
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
      return false;
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
    const html = buildMenuWebPrintHtml({
      businessName: tenant?.business_name || 'Store',
      printedAt,
      sections,
      itemCount,
      menuTitle: tPrint('title'),
      totalItemsLabel: tPrint('totalItems'),
      pageSize,
    });
    printMenuInBrowser(html, targetWindow);
    toast.success(t('menuPrintedSuccess'));
    return true;
  };

  const handlePrint = async () => {
    if (printing) return;
    setPrinting(true);
    // Preserve the user gesture for browsers that block asynchronous popups.
    let reservedWindow: Window | null = null;
    try {
      if (typeof window !== 'undefined') {
        reservedWindow = window.open('', '_blank');
      }
    } catch {
      reservedWindow = null;
    }

    try {
      const response = await api.post('/printers/print-menu', filters);
      if (response.data.webusb === true) {
        const bytes = response.data.bytes;
        if (!Array.isArray(bytes) || !bytes.every((byte: unknown) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255)) {
          throw new Error('Invalid printer data');
        }
        if (!printerService.isConnected) await printerService.tryReconnect();
        if (!printerService.isConnected) throw new Error('WebUSB printer is not connected');
        await printerService.print(new Uint8Array(bytes));
      }
      if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
      toast.success(t('menuPrintedSuccess'));
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
        return;
      }
      if (status === 401 || status === 403) {
        if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
        toast.error(t('menuPrintFailed'));
        return;
      }
      if (code === 'printer_not_configured' || status === 502 || (status !== undefined && status >= 500) || status === undefined) {
        try {
          if (await printBrowserFallback(filters, reservedWindow)) {
            setDialogOpen(false);
          } else if (reservedWindow && !reservedWindow.closed) {
            reservedWindow.close();
          }
        } catch (popupError) {
          if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
          toast.error(popupError instanceof MenuPopupBlockedError ? t('menuPopupBlocked') : t('menuPrintFailed'));
        }
        return;
      }
      if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
      toast.error(t('menuPrintFailed'));
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
      className="touch-target flex min-h-14 w-full items-center justify-between rounded-lg border border-border px-4 text-start text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
    >
      <span>{label}</span>
      <span className={`flex size-6 shrink-0 items-center justify-center rounded border ${checked ? 'border-brand bg-brand text-white' : 'border-input bg-background'}`}>
        {checked && <Check size={16} aria-hidden="true" />}
      </span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader className="text-start">
          <DialogTitle className="flex items-center gap-2">
            <Printer size={18} aria-hidden="true" /> {t('printMenu')}
          </DialogTitle>
          <DialogDescription>{t('printMenuDescription')}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {filterRow(t('includeInactiveItems'), includeInactive, setIncludeInactive)}
          {filterRow(t('includeOutOfStockItems'), includeOutOfStock, setIncludeOutOfStock)}
          {filterRow(t('includeHiddenItems'), includeHidden, setIncludeHidden)}
          {filterRow(t('includeDescriptions'), includeDescriptions, setIncludeDescriptions)}
          {filterRow(t('includeModifiers'), includeModifiers, setIncludeModifiers)}
          <label className="flex items-center justify-between text-sm">
            {t('systemBrowserPrint')}: {tSettings('paperSize')}
            <select aria-label={tSettings('paperSize')} value={pageSize} disabled={printing} onChange={(event) => setPageSize(event.target.value as 'A4' | 'Letter')} className="min-h-11 rounded-md border border-input bg-background px-3">
              <option value="A4">A4</option>
              <option value="Letter">Letter</option>
            </select>
          </label>
        </div>

        <p className="text-xs text-muted-foreground">
          {t('printerDestination')}: {printer?.name || t('systemBrowserPrint')}
        </p>

        <DialogFooter className="flex-row justify-end">
          <Button variant="outline" className="min-h-11" disabled={printing} onClick={() => setDialogOpen(false)}>
            {tCommon('cancel')}
          </Button>
          <Button className="min-h-11" disabled={printing} onClick={handlePrint}>
            {printing ? <LoaderCircle className="me-2 animate-spin" size={16} aria-hidden="true" /> : <Printer className="me-2" size={16} aria-hidden="true" />}
            {t('printMenu')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
