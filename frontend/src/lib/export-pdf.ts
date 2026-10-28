import api from '@/lib/api';
import { printMenuInBrowser, reservePrintGesture } from '@/lib/printer/menu-web-print';

export interface ExportReportPdfOptions {
  endpoint: string;
  params?: Record<string, string | number | undefined>;
  filename: string;
  pageSize?: 'A4' | 'Letter';
}

export async function exportReportAsPdf({
  endpoint,
  params,
  filename,
  pageSize = 'A4',
}: ExportReportPdfOptions): Promise<void> {
  const saveHtmlAsPdf =
    typeof window !== 'undefined' ? window.electronAPI?.saveHtmlAsPdf : undefined;
  let reservedWindow: Window | null = null;
  if (!saveHtmlAsPdf && typeof window !== 'undefined') {
    reservedWindow = reservePrintGesture(window);
    if (!reservedWindow && window.electronAPI) {
      try {
        reservedWindow = window.open('', '_blank');
      } catch {
        reservedWindow = null;
      }
    }
  }

  let handedOff = false;
  try {
    const res = await api.get<string>(endpoint, {
      params: { ...params, format: 'html' },
      responseType: 'text',
    });
    const html = typeof res.data === 'string' ? res.data : String(res.data ?? '');

    if (saveHtmlAsPdf) {
      const result = await saveHtmlAsPdf({
        html,
        defaultFileName: filename,
        pageSize,
      });
      if (result?.canceled) return;
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to export PDF');
      }
      return;
    }

    printMenuInBrowser(html, reservedWindow);
    handedOff = true;
  } finally {
    if (!handedOff && reservedWindow && !reservedWindow.closed) {
      reservedWindow.close();
    }
  }
}
