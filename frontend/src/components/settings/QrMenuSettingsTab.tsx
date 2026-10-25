'use client';

import { useEffect, useRef, useState } from 'react';
import { Copy, Download, ExternalLink, LoaderCircle, Printer, QrCode, Upload } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Category, Product, ProductVariant } from '@/lib/types';
import { activeVariants, isVariantSoldOut } from '@/lib/product-variants';
import {
  buildMenuWebPrintHtml,
  buildQrTableCardHtml,
  printMenuInBrowser,
  type MenuTemplate,
  type MenuWebPrintSection,
} from '@/lib/printer/menu-web-print';
import { SettingsTabShell } from './SettingsTabShell';

type Preferences = {
  template: MenuTemplate;
  pageSize: 'A4' | 'Letter';
  includeDescriptions: boolean;
  includeModifiers: boolean;
  includePhotos: boolean;
  includeOutOfStock: boolean;
  includeInactive: boolean;
  includeHidden: boolean;
};

type QrMenuStatus = {
  configured: boolean;
  connected: boolean;
  published: boolean;
  file_name: string | null;
  web_view_link: string | null;
  sharing_enabled: boolean;
  source: 'generated' | 'uploaded' | null;
  updated_at: string | null;
  qr_data_url: string | null;
  qr_download_data_url: string | null;
  generator_prefs: Preferences;
};

const MAX_PDF_BYTES = 15 * 1024 * 1024;

function arrayBufferToDataUrl(buffer: ArrayBuffer, contentType: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${contentType};base64,${btoa(binary)}`;
}

export function QrMenuSettingsTab({
  canConnectDrive,
  connectingDrive,
  onConnectDrive,
}: {
  canConnectDrive: boolean;
  connectingDrive: boolean;
  onConnectDrive: () => void;
}) {
  const t = useTranslations('qrMenu');
  const tenant = useAuthStore((state) => state.currentTenant);
  const formatCurrency = useFormatCurrency();
  const uploadRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<QrMenuStatus | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [receiptLogo, setReceiptLogo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/settings/google-drive/qr-menu')
      .then((response) => {
        if (cancelled) return;
        setStatus(response.data);
        setPrefs(response.data.generator_prefs);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('loadFailed'));
      });
    api
      .get('/settings')
      .then((response) => setReceiptLogo(response.data?.receipt_logo || null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [t]);

  const setPreference = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPrefs((current) => (current ? { ...current, [key]: value } : current));
  };

  const buildCatalogHtml = async (): Promise<string> => {
    if (!prefs) throw new Error('Preferences unavailable');
    const [productResponse, categoryResponse] = await Promise.all([
      api.get('/products'),
      api.get('/categories'),
    ]);
    const products = (productResponse.data.products || []) as Product[];
    const categories = (categoryResponse.data.categories || []) as Category[];
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const included = products
      .filter(
        (product) =>
          (prefs.includeInactive || product.is_active) &&
          (prefs.includeHidden ||
            !product.category_id ||
            categoryById.get(product.category_id)?.is_active === true),
      )
      .flatMap((product) => {
        const variants = activeVariants(product.variants);
        if (variants.length === 0)
          return prefs.includeOutOfStock ||
            !(product.track_inventory && Number(product.stock_quantity) <= 0)
            ? [{ product }]
            : [];
        return variants
          .filter((variant) => prefs.includeOutOfStock || !isVariantSoldOut(variant))
          .map((variant) => ({ product, variant }));
      });
    const photos = new Map<string, string>();
    if (prefs.includePhotos) {
      await Promise.all(
        [
          ...new Set(
            included.filter(({ product }) => product.has_image).map(({ product }) => product.id),
          ),
        ].map(async (id) => {
          try {
            const response = await api.get(`/products/${encodeURIComponent(id)}/image`, {
              responseType: 'arraybuffer',
            });
            photos.set(
              id,
              arrayBufferToDataUrl(
                response.data,
                String(response.headers['content-type'] || 'image/png'),
              ),
            );
          } catch {}
        }),
      );
    }
    const mapProduct = ({ product, variant }: { product: Product; variant?: ProductVariant }) => ({
      name: variant ? `${product.name} (${variant.name})` : product.name,
      price: formatCurrency(Number(variant ? variant.price : product.price)),
      imageUrl: photos.get(product.id) || null,
      details: [
        ...(prefs.includeDescriptions && product.description ? [product.description] : []),
        ...(prefs.includeModifiers
          ? (product.addon_groups || []).map(
              (group) =>
                `${group.name}: ${(group.addons || [])
                  .filter((addon) => addon.is_active)
                  .map((addon) => `${addon.name} (${formatCurrency(Number(addon.price))})`)
                  .join(', ')}`,
            )
          : []),
      ],
    });
    const sections: MenuWebPrintSection[] = categories
      .map((category) => ({
        name: category.name,
        products: included
          .filter(({ product }) => product.category_id === category.id)
          .map(mapProduct),
      }))
      .filter((section) => section.products.length > 0);
    const uncategorized = included
      .filter(({ product }) => !product.category_id || !categoryById.has(product.category_id))
      .map(mapProduct);
    if (uncategorized.length) sections.push({ name: null, products: uncategorized });
    const itemCount = sections.reduce((total, section) => total + section.products.length, 0);
    if (!itemCount) throw new Error(t('noProducts'));
    return buildMenuWebPrintHtml({
      businessName: tenant?.business_name || 'Store',
      printedAt: '',
      sections,
      itemCount,
      menuTitle: t('menuTitle'),
      totalItemsLabel: '',
      pageSize: prefs.pageSize,
      template: prefs.template,
      customerFacing: true,
      logoDataUrl: receiptLogo,
    });
  };

  const publishGenerated = async () => {
    if (!prefs || busy) return;
    setBusy(true);
    try {
      const html = await buildCatalogHtml();
      const response = await api.post('/settings/google-drive/qr-menu/generate', {
        html,
        pageSize: prefs.pageSize,
        preferences: prefs,
      });
      setStatus(response.data);
      setPrefs(response.data.generator_prefs);
      toast.success(t('published'));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message === t('noProducts')
          ? error.message
          : t('publishFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const uploadPdf = async (file: File) => {
    if (file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf'))
      return toast.error(t('pdfOnly'));
    if (file.size > MAX_PDF_BYTES) return toast.error(t('pdfTooLarge'));
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('invalid');
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      const response = await api.post('/settings/google-drive/qr-menu/upload', {
        fileName: file.name,
        mimeType: 'application/pdf',
        data: btoa(binary),
      });
      setStatus(response.data);
      setPrefs(response.data.generator_prefs);
      toast.success(t('published'));
    } catch {
      toast.error(t('pdfInvalid'));
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  };

  const toggleSharing = async () => {
    if (!status || busy) return;
    setBusy(true);
    try {
      const response = await api.put('/settings/google-drive/qr-menu/sharing', {
        enabled: !status.sharing_enabled,
      });
      setStatus(response.data);
      toast.success(response.data.sharing_enabled ? t('sharingResumed') : t('sharingPaused'));
    } catch {
      toast.error(t('sharingFailed'));
    } finally {
      setBusy(false);
    }
  };

  const downloadQr = () => {
    if (!status?.qr_download_data_url) return;
    const anchor = document.createElement('a');
    anchor.href = status.qr_download_data_url;
    anchor.download = 'qr-menu.png';
    anchor.click();
  };

  const printCard = () => {
    if (!status?.qr_download_data_url) return;
    printMenuInBrowser(
      buildQrTableCardHtml({
        businessName: tenant?.business_name || 'Store',
        logoDataUrl: receiptLogo,
        qrDataUrl: status.qr_download_data_url,
        scanPrompt: t('scanPrompt'),
      }),
    );
  };

  if (!status || !prefs)
    return (
      <SettingsTabShell>
        <div className="flex justify-center p-12">
          <LoaderCircle className="animate-spin" />
        </div>
      </SettingsTabShell>
    );
  if (!status.connected)
    return (
      <SettingsTabShell>
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {status.configured ? t('connectHint') : t('notConfigured')}
          </p>
          {canConnectDrive && status.configured && (
            <Button className="mt-4" disabled={connectingDrive} onClick={onConnectDrive}>
              {connectingDrive && <LoaderCircle className="me-2 animate-spin" size={16} />}
              {t('connectDrive')}
            </Button>
          )}
        </div>
      </SettingsTabShell>
    );

  return (
    <SettingsTabShell>
      <div className="space-y-5">
        {status.published && (
          <section className="rounded-xl border border-border bg-card p-6">
            <div className="flex flex-col gap-5 md:flex-row">
              <div className="shrink-0 rounded-lg bg-white p-3">
                {status.qr_data_url && (
                  <img src={status.qr_data_url} alt={t('qrAlt')} className="size-48" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold">{t('liveMenu')}</h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">{status.file_name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {status.source === 'uploaded' ? t('customPdf') : t('generatedMenu')} ·{' '}
                  {status.updated_at ? new Date(status.updated_at).toLocaleString() : ''}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard.writeText(status.web_view_link || '');
                      toast.success(t('copyLink'));
                    }}
                  >
                    <Copy size={16} className="me-2" />
                    {t('copyLink')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      window.open(status.web_view_link || '', '_blank', 'noopener,noreferrer')
                    }
                  >
                    <ExternalLink size={16} className="me-2" />
                    {t('openMenu')}
                  </Button>
                  <Button variant="outline" onClick={downloadQr}>
                    <Download size={16} className="me-2" />
                    {t('downloadQr')}
                  </Button>
                  <Button variant="outline" onClick={printCard}>
                    <Printer size={16} className="me-2" />
                    {t('printCard')}
                  </Button>
                  <Button
                    variant={status.sharing_enabled ? 'destructive' : 'default'}
                    disabled={busy}
                    onClick={toggleSharing}
                  >
                    {status.sharing_enabled ? t('pauseSharing') : t('resumeSharing')}
                  </Button>
                </div>
              </div>
            </div>
          </section>
        )}
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <QrCode size={20} />
            <h2 className="text-lg font-semibold">
              {status.published ? t('updateMenu') : t('publishMenu')}
            </h2>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              {t('template')}
              <select
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3"
                value={prefs.template}
                onChange={(event) => setPreference('template', event.target.value as MenuTemplate)}
              >
                <option value="mobile-cafe">{t('mobileCafe')}</option>
                <option value="classic-bistro">{t('classicBistro')}</option>
                <option value="standard">{t('standard')}</option>
              </select>
            </label>
            <label className="text-sm">
              {t('pageSize')}
              <select
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3"
                value={prefs.pageSize}
                onChange={(event) =>
                  setPreference('pageSize', event.target.value as 'A4' | 'Letter')
                }
              >
                <option>A4</option>
                <option>Letter</option>
              </select>
            </label>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {(
              [
                'includeDescriptions',
                'includeModifiers',
                'includePhotos',
                'includeOutOfStock',
                'includeInactive',
                'includeHidden',
              ] as const
            ).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={prefs[key]}
                  onChange={(event) => setPreference(key, event.target.checked)}
                />
                {t(key)}
              </label>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={publishGenerated}>
              {busy ? (
                <LoaderCircle className="me-2 animate-spin" size={16} />
              ) : (
                <QrCode className="me-2" size={16} />
              )}
              {status.published ? t('republish') : t('publishGenerated')}
            </Button>
            <input
              ref={uploadRef}
              className="hidden"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadPdf(file);
              }}
            />
            <Button variant="outline" disabled={busy} onClick={() => uploadRef.current?.click()}>
              <Upload className="me-2" size={16} />
              {status.published ? t('replaceWithPdf') : t('uploadPdf')}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('stableLinkHint')}</p>
        </section>
      </div>
    </SettingsTabShell>
  );
}
