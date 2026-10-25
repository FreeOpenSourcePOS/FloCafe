import { BrowserWindow, app } from 'electron';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_PDF_HTML_BYTES = 15 * 1024 * 1024;

export type PdfPageSize = 'A4' | 'Letter';

type HtmlToPdfRenderer = (input: { html: string; pageSize: PdfPageSize }) => Promise<Buffer>;

let rendererOverride: HtmlToPdfRenderer | null = null;

export function setHtmlToPdfRendererForTests(renderer: HtmlToPdfRenderer | null): void {
  rendererOverride = renderer;
}

export async function renderHtmlToPdfBuffer(input: {
  html: string;
  pageSize?: unknown;
}): Promise<Buffer> {
  if (typeof input.html !== 'string' || input.html.length === 0)
    throw new Error('Invalid PDF request');
  if (Buffer.byteLength(input.html, 'utf8') > MAX_PDF_HTML_BYTES)
    throw new Error('Document too large to export');

  const pageSize: PdfPageSize = input.pageSize === 'Letter' ? 'Letter' : 'A4';
  if (rendererOverride) return rendererOverride({ html: input.html, pageSize });

  const stagingDirectory = path.join(app.getPath('userData'), 'pdf-staging');
  fs.mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
  const htmlPath = path.join(stagingDirectory, `document-${crypto.randomUUID()}.html`);
  fs.writeFileSync(htmlPath, input.html, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const htmlUrl = pathToFileURL(htmlPath).href;

  const pdfWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
      partition: `qr-menu-pdf-${crypto.randomUUID()}`,
    },
  });
  pdfWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url === htmlUrl || details.url.startsWith('data:image/');
    callback({ cancel: !allowed });
  });
  pdfWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pdfWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  try {
    await pdfWindow.loadFile(htmlPath);
    return await pdfWindow.webContents.printToPDF({ printBackground: true, pageSize });
  } finally {
    try {
      fs.unlinkSync(htmlPath);
    } catch {}
    if (!pdfWindow.isDestroyed()) pdfWindow.destroy();
  }
}
