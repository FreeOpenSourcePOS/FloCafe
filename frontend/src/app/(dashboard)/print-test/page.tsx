'use client';

import { useMemo, useState } from 'react';
import { Printer, FileText, MessageCircle, Download, Usb, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePrinterStore } from '@/hooks/usePrinter';
import { showPrintLanguageLoadErrorsToast, showPrintWarningsToast } from '@/lib/printer/warnings-toast';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useAuthStore } from '@/store/auth';
import { printerService } from '@/lib/printer/PrinterService';
import { createTestBill, createTestOrder, createTestTenant, createTestCustomer } from '@/lib/printer/test-data';
import { printWebBill, generateBillHtml } from '@/lib/printer/web-print';
import { ensurePrintLanguagesLoaded, resolveBillPrintLanguages } from '@/lib/printer/print-document';
import { generateKotHtml } from '@/lib/printer/kot-web-print';
import { shareBillViaWhatsApp, getWhatsAppMessage } from '@/lib/whatsapp-share';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
type TestMode = 'receipt' | 'tax' | 'kot' | 'web-print' | 'whatsapp';
type PaperWidth = 58 | 80;

export default function PrintTestPage() {
  const [testMode, setTestMode] = useState<TestMode>('receipt');
  const [paperWidth, setPaperWidth] = useState<PaperWidth>(58);
  const [testing, setTesting] = useState(false);

  const { printBill, printTaxBill, printKot, printMethod, setPrintMethod, downloadLastReceipt, lastPrintedBytes, status } = usePrinterStore();
  const currentTenant = useAuthStore((s) => s.currentTenant);
  const kotPrintingEnabled = usePosSettingsStore((s) => s.kotPrintingEnabled);
  const printerPaperSize = usePosSettingsStore((s) => s.printerPaperSize);
  const t = useTranslations('printTest');
  const tCommon = useTranslations('common');
  const effectiveTestMode: TestMode = !kotPrintingEnabled && testMode === 'kot' ? 'receipt' : testMode;

  const testBill = useMemo(() => createTestBill(), []);
  const testOrder = useMemo(() => createTestOrder(), []);
  const testTenant = useMemo(
    () => createTestTenant({ timezone: currentTenant?.timezone || 'Asia/Kolkata' }),
    [currentTenant?.timezone],
  );
  const testCustomer = useMemo(() => createTestCustomer(), []);

  const handlePrint = async () => {
    setTesting(true);
    try {
      switch (effectiveTestMode) {
        case 'receipt':
          if (printMethod === 'browser') {
            // Browser test surface runs through the real document-driven
            // web-print path (#444).
            const printWarnings = await printWebBill(testBill, testTenant, {
              paperSize: paperWidth === 80 ? 'thermal80' : 'thermal58',
            });
            toast.success(t('browserDialogOpened'));
            showPrintWarningsToast(printWarnings);
          } else {
            const printWarnings = await printBill(testBill, testTenant, { paperWidth });
            toast.success(t('receiptPrinted'));
            showPrintWarningsToast(printWarnings);
          }
          break;
        case 'tax':
          if (printMethod === 'browser') {
            const printWarnings = await printWebBill(testBill, testTenant, {
              paperSize: paperWidth === 80 ? 'thermal80' : 'thermal58',
              includeTaxId: true,
              taxRegistrationNumber: 'TAXID-0001',
              address: '123 Main Street, Mumbai - 400001',
              phone: '+91 9876543210',
            });
            toast.success(t('browserDialogOpened'));
            showPrintWarningsToast(printWarnings);
          } else {
            const printWarnings = await printTaxBill(testBill, testTenant, {
              paperWidth,
              taxRegistrationNumber: 'TAXID-0001',
              address: '123 Main Street, Mumbai - 400001',
              phone: '+91 9876543210',
            });
            toast.success(t('taxBillPrinted'));
            showPrintWarningsToast(printWarnings);
          }
          break;
        case 'kot':
          // Block manual KOT test print when KOT printing is disabled.
          if (!kotPrintingEnabled) {
            toast.error(t('failedWithReason', { message: t('kotDisabled') }));
            break;
          }
          if (printMethod === 'browser') {
            // Render semantic KOT HTML and preload ticket locale if different from UI language.
            const { resolveKotTicketLanguage } = await import('@/lib/printer/kot-web-print');
            const kotLanguage = resolveKotTicketLanguage();
            const failedLanguages = await ensurePrintLanguagesLoaded([kotLanguage]);
            const html = generateKotHtml(testOrder, { paperWidth, language: kotLanguage, stationName: t('kitchenStation'), timezone: testTenant.timezone });
            await printerService.printViaBrowser(html, paperWidth);
            toast.success(t('browserDialogOpened'));
            showPrintWarningsToast(failedLanguages.map((language) => ({
              field: 'kot language',
              text: language,
              message: t('kotLanguageLoadError', { language }),
              kind: 'locale' as const,
            })));
          } else {
            const printWarnings = await printKot(testOrder, { paperWidth, stationName: t('kitchenStation') });
            toast.success(t('kotPrinted'));
            showPrintWarningsToast(printWarnings);
          }
          break;
        case 'web-print': {
          const printWarnings = await printWebBill(testBill, testTenant, { paperSize: printerPaperSize, includeTaxId: true });
          toast.success(t('webPrintDialogOpened'));
          showPrintWarningsToast(printWarnings);
          break;
        }
        case 'whatsapp':
          shareBillViaWhatsApp(testBill, testCustomer, testTenant, {
            pointsEarned: 50,
            walletBalance: 200,
          });
          toast.success(t('whatsappOpened'));
          break;
      }
    } catch {
      toast.error(t('failedWithReason', { message: tCommon('somethingWrong') }));
    } finally {
      setTesting(false);
    }
  };

  const handleDownloadHtml = async () => {
    const languages = resolveBillPrintLanguages();
    const failedLanguages = await ensurePrintLanguagesLoaded(languages);
    if (failedLanguages.length > 0) {
      showPrintLanguageLoadErrorsToast(failedLanguages);
      return;
    }
    const html = generateBillHtml(testBill, testTenant, {
      paperSize: printerPaperSize,
      includeTaxId: true,
      taxRegistrationNumber: 'TAXID-0001',
      address: '123 Main Street, Mumbai - 400001',
      phone: '+91 9876543210',
      languages,
    });

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bill-${printerPaperSize}-preview.html`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t('htmlDownloaded'));
  };

  const handleCopyWhatsappText = async () => {
    const message = getWhatsAppMessage(testBill, testTenant, {
      pointsEarned: 50,
      walletBalance: 200,
    });
    await navigator.clipboard.writeText(message);
    toast.success(t('whatsappCopied'));
  };

  const testOptions: { value: TestMode; label: string; icon: React.ElementType }[] = [
    { value: 'receipt', label: t('optionBasicReceipt'), icon: Printer },
    { value: 'tax', label: t('optionTaxBill'), icon: Printer },
    // Hidden entirely when KOT printing is disabled — this is a manual
    // "Print KOT" action, which must never be reachable in that state (#133).
    ...(kotPrintingEnabled ? [{ value: 'kot' as TestMode, label: t('optionKot'), icon: Printer }] : []),
    { value: 'web-print', label: t('optionWebPrint'), icon: FileText },
    { value: 'whatsapp', label: t('optionWhatsapp'), icon: MessageCircle },
  ];

  return (
    <div className="min-h-screen bg-muted p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Printer size={28} className="text-brand" />
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        </div>

        <div className="bg-card rounded-xl border border-border p-6 mb-6">
          <h2 className="font-semibold text-foreground mb-4">{t('selectTestType')}</h2>
          <div className="grid grid-cols-2 gap-2">
            {testOptions.map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  onClick={() => setTestMode(opt.value)}
                  className={`flex items-center gap-2 p-3 rounded-lg border transition-colors ${
                    effectiveTestMode === opt.value
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-border hover:border-gray-300 dark:border-border'
                  }`}
                >
                  <Icon size={16} />
                  <span className="text-sm font-medium">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-6 mb-6">
          <h2 className="font-semibold text-foreground mb-4">{t('printerSettings')}</h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('paperWidthLabel')}
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setPaperWidth(58)}
                  className={`px-4 py-2 rounded-lg border transition-colors ${
                    paperWidth === 58
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-border hover:border-gray-300 dark:border-border'
                  }`}
                >
                  {t('paperWidth58')}
                </button>
                <button
                  onClick={() => setPaperWidth(80)}
                  className={`px-4 py-2 rounded-lg border transition-colors ${
                    paperWidth === 80
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-border hover:border-gray-300 dark:border-border'
                  }`}
                >
                  {t('paperWidth80')}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('printMethodLabel')}
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setPrintMethod('escpos')}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
                    printMethod === 'escpos'
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-border hover:border-gray-300 dark:border-border'
                  }`}
                >
                  <Usb size={16} />
                  {t('escpos')}
                </button>
                <button
                  onClick={() => setPrintMethod('browser')}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
                    printMethod === 'browser'
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-border hover:border-gray-300 dark:border-border'
                  }`}
                >
                  <Globe size={16} />
                  {t('browserPrint')}
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {printMethod === 'escpos' 
                  ? t('escposHint', { status })
                  : t('browserHint')}
              </p>
            </div>

            {printMethod === 'escpos' && lastPrintedBytes && (
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">
                  {t('lastPrintedBytes', { bytes: lastPrintedBytes.length })}
                </p>
                <button
                  onClick={downloadLastReceipt}
                  className="mt-2 text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <Download size={14} /> {t('downloadBin')}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            onClick={handlePrint}
            disabled={testing}
            className="flex-1"
            size="lg"
          >
            {testing ? t('printing') : t('runTest')}
          </Button>

          {effectiveTestMode === 'web-print' && (
            <Button
              onClick={handleDownloadHtml}
              variant="outline"
              size="lg"
            >
              <Download size={18} className="me-2" />
              {t('downloadHtml')}
            </Button>
          )}

          {effectiveTestMode === 'whatsapp' && (
            <Button
              onClick={handleCopyWhatsappText}
              variant="outline"
              size="lg"
            >
              {t('copyText')}
            </Button>
          )}
        </div>

        <div className="mt-6 p-4 bg-muted rounded-lg">
          <h3 className="font-medium text-foreground mb-2">{t('dataPreview')}</h3>
          <pre className="text-xs text-muted-foreground overflow-x-auto">
            {JSON.stringify({
              bill: testBill.bill_number,
              total: testBill.total,
              items: testOrder.items?.length,
              customer: testCustomer.name,
            }, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
