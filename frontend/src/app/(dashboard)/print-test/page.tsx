'use client';

import { useEffect, useState } from 'react';
import { Printer, FileText, MessageCircle, Download, Usb, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePrinterStore } from '@/hooks/usePrinter';
import { usePosSettingsStore } from '@/store/pos-settings';
import { printerService } from '@/lib/printer/PrinterService';
import { createTestBill, createTestOrder, createTestTenant, createTestCustomer } from '@/lib/printer/test-data';
import { printWebBill, generateBillHtml } from '@/lib/printer/web-print';
import { shareBillViaWhatsApp, getWhatsAppMessage } from '@/lib/whatsapp-share';
import { formatCurrencyForTenant, getCountryByCode } from '@/lib/countries';
import { formatDate } from '@/lib/printer/format-date';
import toast from 'react-hot-toast';

type TestMode = 'receipt' | 'gst' | 'kot' | 'web-a4' | 'web-a5' | 'whatsapp';
type PaperWidth = 58 | 80;

export default function PrintTestPage() {
  const [testMode, setTestMode] = useState<TestMode>('receipt');
  const [paperWidth, setPaperWidth] = useState<PaperWidth>(58);
  const [testing, setTesting] = useState(false);

  const { printBill, printGstBill, printKot, printMethod, setPrintMethod, downloadLastReceipt, lastPrintedBytes, status } = usePrinterStore();
  const kotPrintingEnabled = usePosSettingsStore((s) => s.kotPrintingEnabled);

  useEffect(() => {
    if (!kotPrintingEnabled && testMode === 'kot') setTestMode('receipt');
  }, [kotPrintingEnabled, testMode]);

  const testBill = createTestBill();
  const testOrder = createTestOrder();
  const testTenant = createTestTenant();
  const testCustomer = createTestCustomer();

  const handlePrint = async () => {
    setTesting(true);
    try {
      switch (testMode) {
        case 'receipt':
          if (printMethod === 'browser') {
            const html = generateThermalReceiptHtml(testBill, testTenant, paperWidth);
            await printerService.printViaBrowser(html, paperWidth);
            toast.success('Browser print dialog opened!');
          } else {
            await printBill(testBill, testTenant, { paperWidth });
            toast.success('Receipt printed!');
          }
          break;
        case 'gst':
          if (printMethod === 'browser') {
            const html = generateThermalReceiptHtml(testBill, testTenant, paperWidth, {
              gstin: '22AAAAA0000A1Z5',
              address: '123 Main Street, Mumbai - 400001',
              phone: '+91 9876543210',
            });
            await printerService.printViaBrowser(html, paperWidth);
            toast.success('Browser print dialog opened!');
          } else {
            await printGstBill(testBill, testTenant, {
              paperWidth,
              gstin: '22AAAAA0000A1Z5',
              address: '123 Main Street, Mumbai - 400001',
              phone: '+91 9876543210',
            });
            toast.success('GST Bill printed!');
          }
          break;
        case 'kot':
          // Manual "Print KOT" test action — must be blocked here too, since
          // the browser-print path below never goes through the printKot()
          // choke point that enforces kot_printing_enabled (issue #133).
          if (!kotPrintingEnabled) {
            toast.error('KOT printing is disabled for this business');
            break;
          }
          if (printMethod === 'browser') {
            const html = generateKotHtml(testOrder, paperWidth);
            await printerService.printViaBrowser(html, paperWidth);
            toast.success('Browser print dialog opened!');
          } else {
            await printKot(testOrder, { paperWidth });
            toast.success('KOT printed!');
          }
          break;
        case 'web-a4':
          printWebBill(testBill, testTenant, { paperSize: 'a4', includeGst: true });
          toast.success('A4 Print dialog opened');
          break;
        case 'web-a5':
          printWebBill(testBill, testTenant, { paperSize: 'a5', includeGst: true });
          toast.success('A5 Print dialog opened');
          break;
        case 'whatsapp':
          shareBillViaWhatsApp(testBill, testCustomer, testTenant, {
            pointsEarned: 50,
            walletBalance: 200,
          });
          toast.success('WhatsApp opened');
          break;
      }
    } catch (err) {
      toast.error(`Print failed: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const handleDownloadHtml = () => {
    const html = generateBillHtml(testBill, testTenant, {
      paperSize: 'a4',
      includeGst: true,
      gstin: '22AAAAA0000A1Z5',
      address: '123 Main Street, Mumbai - 400001',
      phone: '+91 9876543210',
    });

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bill-a4-preview.html';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('HTML downloaded');
  };

  const handleCopyWhatsappText = async () => {
    const message = getWhatsAppMessage(testBill, testTenant, {
      pointsEarned: 50,
      walletBalance: 200,
    });
    await navigator.clipboard.writeText(message);
    toast.success('WhatsApp message copied to clipboard');
  };

  const testOptions: { value: TestMode; label: string; icon: React.ElementType }[] = [
    { value: 'receipt', label: 'Basic Receipt (Thermal)', icon: Printer },
    { value: 'gst', label: 'GST Bill (Thermal)', icon: Printer },
    // Hidden entirely when KOT printing is disabled — this is a manual
    // "Print KOT" action, which must never be reachable in that state (#133).
    ...(kotPrintingEnabled ? [{ value: 'kot' as TestMode, label: 'KOT (Kitchen Ticket)', icon: Printer }] : []),
    { value: 'web-a4', label: 'A4 Web Print', icon: FileText },
    { value: 'web-a5', label: 'A5 Web Print', icon: FileText },
    { value: 'whatsapp', label: 'WhatsApp Share', icon: MessageCircle },
  ];

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Printer size={28} className="text-brand" />
          <h1 className="text-2xl font-bold text-gray-900">Printing Test Page</h1>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">Select Test Type</h2>
          <div className="grid grid-cols-2 gap-2">
            {testOptions.map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  onClick={() => setTestMode(opt.value)}
                  className={`flex items-center gap-2 p-3 rounded-lg border transition-colors ${
                    testMode === opt.value
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <Icon size={16} />
                  <span className="text-sm font-medium">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">Printer Settings</h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Paper Width
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setPaperWidth(58)}
                  className={`px-4 py-2 rounded-lg border transition-colors ${
                    paperWidth === 58
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  2.5&quot; (58mm)
                </button>
                <button
                  onClick={() => setPaperWidth(80)}
                  className={`px-4 py-2 rounded-lg border transition-colors ${
                    paperWidth === 80
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  3.5&quot; (80mm)
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Print Method
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setPrintMethod('escpos')}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
                    printMethod === 'escpos'
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <Usb size={16} />
                  ESCPOS (USB)
                </button>
                <button
                  onClick={() => setPrintMethod('browser')}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
                    printMethod === 'browser'
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <Globe size={16} />
                  Browser Print
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {printMethod === 'escpos' 
                  ? `Status: ${status} - Direct USB printing via WebUSB`
                  : 'Uses browser print dialog - works with any printer connected to computer'}
              </p>
            </div>

            {printMethod === 'escpos' && lastPrintedBytes && (
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-600">
                  Last printed: {lastPrintedBytes.length} bytes
                </p>
                <button
                  onClick={downloadLastReceipt}
                  className="mt-2 text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
                >
                  <Download size={14} /> Download .bin
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
            {testing ? 'Printing...' : 'Run Test'}
          </Button>

          {(testMode === 'web-a4' || testMode === 'web-a5') && (
            <Button
              onClick={handleDownloadHtml}
              variant="outline"
              size="lg"
            >
              <Download size={18} className="mr-2" />
              Download HTML
            </Button>
          )}

          {testMode === 'whatsapp' && (
            <Button
              onClick={handleCopyWhatsappText}
              variant="outline"
              size="lg"
            >
              Copy Text
            </Button>
          )}
        </div>

        <div className="mt-6 p-4 bg-gray-100 rounded-lg">
          <h3 className="font-medium text-gray-700 mb-2">Test Data Preview</h3>
          <pre className="text-xs text-gray-600 overflow-x-auto">
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

function generateThermalReceiptHtml(
  bill: ReturnType<typeof createTestBill>,
  tenant: ReturnType<typeof createTestTenant>,
  paperWidth: 58 | 80,
  options?: { gstin?: string; address?: string; phone?: string }
): string {
  const fontSize = paperWidth === 58 ? '10px' : '12px';
  const padding = paperWidth === 58 ? '4px' : '6px';
  
  const fmtCurrency = (amount: number) => formatCurrencyForTenant(amount, tenant.country, tenant.currency);
  
  const items = bill.order?.items || [];
  const rows = items.map((item, idx) => `
    <tr>
      <td style="font-size:${fontSize};padding:${padding};">${idx + 1}. ${item.product_name}</td>
      <td style="font-size:${fontSize};padding:${padding};text-align:right;">${item.quantity}</td>
      <td style="font-size:${fontSize};padding:${padding};text-align:right;">${fmtCurrency(item.unit_price)}</td>
      <td style="font-size:${fontSize};padding:${padding};text-align:right;">${fmtCurrency(item.subtotal)}</td>
    </tr>
  `).join('');

  const cgst = bill.tax_breakdown?.find(t => t.title === 'CGST')?.amount || 0;
  const sgst = bill.tax_breakdown?.find(t => t.title === 'SGST')?.amount || 0;

  return `
    <div style="text-align:center;padding:${padding};font-family:'Courier New',monospace;font-size:${fontSize};">
      <h2 style="margin:0;font-size:${paperWidth === 58 ? '14px' : '16px'};">${tenant.business_name}</h2>
      ${options?.address ? `<p style="margin:2px 0;font-size:${fontSize};">${options.address}</p>` : ''}
      ${options?.phone ? `<p style="margin:2px 0;font-size:${fontSize};">${options.phone}</p>` : ''}
      ${options?.gstin ? `<p style="margin:2px 0;font-size:${fontSize};">GSTIN: ${options.gstin}</p>` : ''}
      <hr style="border:1px dashed #000;margin:4px 0;">
      <p style="margin:2px 0;">Bill #: ${bill.bill_number}</p>
      <p style="margin:2px 0;">${formatDate(new Date().toISOString(), getCountryByCode(tenant.country ?? 'IN')?.locale)}</p>
      <hr style="border:1px dashed #000;margin:4px 0;">
      <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
        <thead>
          <tr>
            <th style="text-align:left;padding:${padding};">Item</th>
            <th style="text-align:right;padding:${padding};">Qty</th>
            <th style="text-align:right;padding:${padding};">Rate</th>
            <th style="text-align:right;padding:${padding};">Amt</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <hr style="border:1px dashed #000;margin:4px 0;">
      <table style="width:100%;font-size:${fontSize};">
        <tr>
          <td style="padding:${padding};">Subtotal</td>
          <td style="text-align:right;padding:${padding};">${fmtCurrency(bill.subtotal)}</td>
        </tr>
        ${bill.discount_amount > 0 ? `
        <tr>
          <td style="padding:${padding};">Discount</td>
          <td style="text-align:right;padding:${padding};">-${fmtCurrency(bill.discount_amount)}</td>
        </tr>
        ` : ''}
        <tr>
          <td style="padding:${padding};">CGST</td>
          <td style="text-align:right;padding:${padding};">${fmtCurrency(cgst)}</td>
        </tr>
        <tr>
          <td style="padding:${padding};">SGST</td>
          <td style="text-align:right;padding:${padding};">${fmtCurrency(sgst)}</td>
        </tr>
        <tr style="font-weight:bold;">
          <td style="padding:${padding};">TOTAL</td>
          <td style="text-align:right;padding:${padding};">${fmtCurrency(bill.total)}</td>
        </tr>
      </table>
      <hr style="border:1px dashed #000;margin:8px 0;">
      <p style="margin:4px 0;font-size:${fontSize};">Thank you for visiting!</p>
      <p style="margin:4px 0;font-size:${fontSize};">Please visit again</p>
    </div>
  `;
}

function generateKotHtml(
  order: ReturnType<typeof createTestOrder>,
  paperWidth: 58 | 80
): string {
  const fontSize = paperWidth === 58 ? '10px' : '12px';
  const padding = paperWidth === 58 ? '4px' : '6px';
  
  const items = order.items || [];
  const rows = items.map((item, idx) => `
    <tr>
      <td style="font-size:${fontSize};padding:${padding};">${idx + 1}. ${item.product_name}</td>
      <td style="font-size:${fontSize};padding:${padding};text-align:right;font-weight:bold;">${item.quantity}</td>
    </tr>
  `).join('');

  return `
    <div style="text-align:center;padding:${padding};font-family:'Courier New',monospace;font-size:${fontSize};">
      <h2 style="margin:0;font-size:${paperWidth === 58 ? '14px' : '16px'};">KOT</h2>
      <p style="margin:2px 0;">Order #: ${order.order_number}</p>
      <p style="margin:2px 0;">${formatDate(order.created_at, 'en-US')}</p>
      <hr style="border:1px dashed #000;margin:4px 0;">
      <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
        <tbody>
          ${rows}
        </tbody>
      </table>
      <hr style="border:1px dashed #000;margin:8px 0;">
    </div>
  `;
}
