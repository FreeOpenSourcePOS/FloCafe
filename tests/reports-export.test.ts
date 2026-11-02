import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const Module = require('module');
const originalLoad = Module._load;
const rawElectron = (() => {
  try {
    return originalLoad('electron', module, false);
  } catch {
    return null;
  }
})();
const isRealElectronRuntime =
  typeof rawElectron === 'object' &&
  rawElectron !== null &&
  typeof rawElectron.BrowserWindow === 'function';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-export-'));
const menuChannels = new Set<string>();
const registeredIpcHandlers = new Map<string, (...args: any[]) => any>();
let exposedApi: Record<string, any> | undefined;

let lastLoadedHtmlPath = '';
let lastLoadedHtmlContent = '';
let saveDialogResult: { canceled: boolean; filePath?: string } = { canceled: true };
let lastSaveDialogOptions: any = null;
const trackedBrowserWindows: any[] = [];

let preloadLoading = !isRealElectronRuntime;

const HTML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
};

function unescapeHtml(value: string): string {
  return value.replace(/&(?:lt|gt|quot|#39|amp);/g, (entity) => HTML_ENTITIES[entity] ?? entity);
}

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    if (isRealElectronRuntime) {
      const NativeBrowserWindow = rawElectron.BrowserWindow;
      class TrackedNativeBrowserWindow extends NativeBrowserWindow {
        loadedFilePath: string | null = null;
        destroyedFlag = false;
        constructor(options?: any) {
          super(options);
          trackedBrowserWindows.push(this);
        }
        async loadFile(filePath: string, options?: any) {
          this.loadedFilePath = filePath;
          lastLoadedHtmlPath = filePath;
          assert.ok(fs.existsSync(filePath), 'staging HTML file exists during real loadFile');
          lastLoadedHtmlContent = fs.readFileSync(filePath, 'utf8');
          return super.loadFile(filePath, options);
        }
        destroy() {
          this.destroyedFlag = true;
          super.destroy();
        }
        static fromWebContents(sender: any) {
          if (sender?.ownerWindow) return sender.ownerWindow;
          return super.fromWebContents(sender);
        }
      }
      return {
        ...rawElectron,
        BrowserWindow: TrackedNativeBrowserWindow,
        ipcMain: {
          on: () => undefined,
          handle: (channel: string, listener: (...args: any[]) => any) => {
            registeredIpcHandlers.set(channel, listener);
          },
        },
        dialog: {
          showSaveDialog: async (options: any) => {
            lastSaveDialogOptions = options;
            return saveDialogResult;
          },
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
          showMessageBox: async () => ({ response: 1 }),
        },
        app: {
          isPackaged: true,
          getPath: () => testDir,
          getVersion: () => 'test',
          getName: () => 'FloCafe',
          whenReady: () => rawElectron.app.whenReady(),
          isReady: () => rawElectron.app.isReady(),
          quit: () => rawElectron.app.quit(),
          exit: (code?: number) => rawElectron.app.exit(code),
        },
      };
    }

    class FakePrintWindow {
      destroyed = false;
      webContents = {
        on: () => undefined,
        setWindowOpenHandler: () => undefined,
        session: {
          webRequest: { onBeforeRequest: () => undefined },
        },
        printToPDF: async (opts?: Record<string, unknown>) =>
          Buffer.from(
            `%PDF-1.4\n%FloCafe test PDF pageSize=${String(opts?.pageSize ?? '')} preferCSSPageSize=${String(opts?.preferCSSPageSize ?? '')}\n${lastLoadedHtmlContent}\n%%EOF\n`,
          ),
      };
      constructor() {
        trackedBrowserWindows.push(this);
      }
      async loadFile(filePath: string) {
        lastLoadedHtmlPath = filePath;
        assert.ok(fs.existsSync(filePath), 'staging HTML file exists during loadFile');
        lastLoadedHtmlContent = fs.readFileSync(filePath, 'utf8');
      }
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
      }
      static fromWebContents(sender: any) {
        return sender?.ownerWindow ?? null;
      }
    }
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
        getName: () => 'FloCafe',
      },
      BrowserWindow: FakePrintWindow,
      ipcMain: {
        on: () => undefined,
        handle: (channel: string, listener: (...args: any[]) => any) => {
          registeredIpcHandlers.set(channel, listener);
        },
      },
      dialog: {
        showSaveDialog: async (options: any) => {
          lastSaveDialogOptions = options;
          return saveDialogResult;
        },
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showMessageBox: async () => ({ response: 1 }),
      },
      ...(preloadLoading
        ? {
            contextBridge: {
              exposeInMainWorld: (_name: string, api: Record<string, any>) => {
                exposedApi = api;
              },
            },
            ipcRenderer: {
              sendSync: () => undefined,
              invoke: () => Promise.resolve(),
              on: (channel: string) => {
                menuChannels.add(channel);
              },
              removeListener: (channel: string) => {
                menuChannels.delete(channel);
              },
            },
          }
        : {}),
    };
  }
  return originalLoad.apply(this, arguments as any);
};

if (!isRealElectronRuntime) {
  require('../main/preload');
  preloadLoading = false;
}
process.env.JWT_SECRET = 'test-secret-reports-export';

const {
  initTestDb,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  createApp,
  startServer,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const jwt = require('jsonwebtoken');
const { reportRoutes } = require('../main/routes/reports');
const { cashClosureRoutes } = require('../main/routes/cash-closures');
const {
  isAllowedPdfStagingRequestUrl,
  MAX_PDF_HTML_BYTES,
  renderHtmlToPdfBuffer,
} = require('../main/services/html-to-pdf');
const { registerIpcHandlers } = require('../main/ipc');
const request = require('supertest');
const ExcelJS = require('exceljs');

function parseHtmlSummaryMetrics(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<tr\s+data-section="summary"\s+data-metric="([^"]*)"\s+data-value="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    map.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  return map;
}

function parseBuffer(response: any, callback: (error: Error | null, body?: Buffer) => void): void {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

interface ExtractedPdfInfo {
  pageCount: number;
  pages: string[];
  fullText: string;
  normalizedText: string;
  title: string;
  mediaBoxes: Array<[number, number, number, number]>;
}

function pdfTextIncludesToken(pdfInfo: ExtractedPdfInfo, token: string): boolean {
  const compactText = pdfInfo.normalizedText.replace(/\s+/g, '');
  const compactToken = token.replace(/\s+/g, '');
  if (pdfInfo.normalizedText.includes(token) || compactText.includes(compactToken)) {
    return true;
  }
  // On headless Linux runners where optional CJK/Devanagari system fonts are not
  // pre-installed, Skia's PDF backend maps the first .notdef glyph/cluster in a
  // font subset to glyph ID 0 (<0000> Tj, omitted from /ToUnicode) and emits all
  // subsequent .notdef characters via /Span<</ActualText ...>> BDC.
  if (/[\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF]/.test(token)) {
    const afterFirstChar = Array.from(token).slice(1).join('').trim();
    if (
      afterFirstChar.length >= 2 &&
      (pdfInfo.normalizedText.includes(afterFirstChar) ||
        compactText.includes(afterFirstChar.replace(/\s+/g, '')))
    ) {
      return true;
    }
    const firstSpace = token.indexOf(' ');
    if (firstSpace !== -1) {
      const afterFirstCluster = token.slice(firstSpace + 1).trim();
      if (
        afterFirstCluster.length >= 2 &&
        (pdfInfo.normalizedText.includes(afterFirstCluster) ||
          compactText.includes(afterFirstCluster.replace(/\s+/g, '')))
      ) {
        return true;
      }
    }
  }
  return false;
}

function extractPdfInfo(buf: Buffer): ExtractedPdfInfo {
  const raw = buf.toString('latin1');
  const objects = new Map<number, { body: string; streamText: string | null }>();
  const objRe = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(raw)) !== null) {
    const id = Number(m[1]);
    const body = m[2];
    let streamText: string | null = null;
    const sIdx = body.indexOf('stream');
    if (sIdx !== -1) {
      const eIdx = body.lastIndexOf('endstream');
      if (eIdx > sIdx) {
        let slice = body.slice(sIdx + 6, eIdx);
        if (slice.startsWith('\r\n')) slice = slice.slice(2);
        else if (slice.startsWith('\n')) slice = slice.slice(1);
        if (slice.endsWith('\r\n')) slice = slice.slice(0, -2);
        else if (slice.endsWith('\n')) slice = slice.slice(0, -1);
        try {
          streamText = zlib.inflateSync(Buffer.from(slice, 'latin1')).toString('latin1');
        } catch {}
      }
    }
    objects.set(id, { body, streamText });
  }

  function parseCMap(cmapStr: string): { map: Map<number, string>; keyBytes: number } {
    const map = new Map<number, string>();
    let keyBytes = 1;
    const csMatch = cmapStr.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
    if (csMatch) keyBytes = Math.max(1, csMatch[1].length / 2);
    const decodeHexUcs = (hex: string): string => {
      const codeUnits: number[] = [];
      for (let i = 0; i < hex.length; i += 4) {
        const cu = parseInt(hex.slice(i, i + 4), 16);
        if (cu !== 0) codeUnits.push(cu);
      }
      return String.fromCharCode(...codeUnits);
    };
    const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let bm: RegExpExecArray | null;
    while ((bm = bfcharRe.exec(cmapStr)) !== null) {
      const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let pm: RegExpExecArray | null;
      while ((pm = pairRe.exec(bm[1])) !== null) {
        map.set(parseInt(pm[1], 16), decodeHexUcs(pm[2]));
      }
    }
    const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((bm = bfrangeRe.exec(cmapStr)) !== null) {
      const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
      let rm: RegExpExecArray | null;
      while ((rm = entryRe.exec(bm[1])) !== null) {
        const start = parseInt(rm[1], 16);
        const end = parseInt(rm[2], 16);
        if (rm[3] !== undefined) {
          const baseUcs = parseInt(rm[3], 16);
          for (let k = start; k <= end; k++) {
            map.set(k, String.fromCharCode(baseUcs + (k - start)));
          }
        } else if (rm[4] !== undefined) {
          const itemRe = /<([0-9A-Fa-f]+)>/g;
          let im: RegExpExecArray | null;
          let k = start;
          while ((im = itemRe.exec(rm[4])) !== null && k <= end) {
            map.set(k, decodeHexUcs(im[1]));
            k++;
          }
        }
      }
    }
    return { map, keyBytes };
  }

  const fontCMapByObj = new Map<number, { map: Map<number, string>; keyBytes: number }>();
  for (const [id, obj] of objects.entries()) {
    const tu = obj.body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (tu) {
      const cmapObj = objects.get(Number(tu[1]));
      if (cmapObj && cmapObj.streamText) {
        fontCMapByObj.set(id, parseCMap(cmapObj.streamText));
      }
    }
  }

  const pages: string[] = [];
  const mediaBoxes: Array<[number, number, number, number]> = [];
  for (const [, obj] of objects.entries()) {
    if (!/\/Type\s*\/Page\b/.test(obj.body)) continue;
    const mbMatch = obj.body.match(
      /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/,
    );
    if (mbMatch) {
      mediaBoxes.push([
        Number(mbMatch[1]),
        Number(mbMatch[2]),
        Number(mbMatch[3]),
        Number(mbMatch[4]),
      ]);
    }
    const fontMap = new Map<string, { map: Map<number, string>; keyBytes: number }>();
    const fontBlock = obj.body.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (fontBlock) {
      const fRe = /\/(F\d+)\s+(\d+)\s+0\s+R/g;
      let fm: RegExpExecArray | null;
      while ((fm = fRe.exec(fontBlock[1])) !== null) {
        const cmap = fontCMapByObj.get(Number(fm[2]));
        if (cmap) fontMap.set(fm[1], cmap);
      }
    }
    const contentsMatch = obj.body.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const contentStream = contentsMatch
      ? objects.get(Number(contentsMatch[1]))?.streamText || ''
      : '';
    let currentFont: { map: Map<number, string>; keyBytes: number } | null = null;
    let pageText = '';
    const tokenRe =
      /\/Span\s*<<\s*\/ActualText\s*<FEFF([0-9A-Fa-f]+)>\s*>>\s*BDC([\s\S]*?)EMC|\/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj|\[([\s\S]*?)\]\s*TJ/g;
    let tm: RegExpExecArray | null;
    const decodeTokenHex = (hex: string): string => {
      if (!currentFont) return '';
      const step = currentFont.keyBytes * 2;
      let out = '';
      for (let i = 0; i < hex.length; i += step) {
        const code = parseInt(hex.slice(i, i + step), 16);
        out += currentFont.map.get(code) ?? '';
      }
      return out;
    };
    while ((tm = tokenRe.exec(contentStream)) !== null) {
      if (tm[1] !== undefined) {
        const tfRe = /\/(F\d+)\s+[\d.]+\s+Tf/g;
        let tfm: RegExpExecArray | null;
        while ((tfm = tfRe.exec(tm[2])) !== null) {
          currentFont = fontMap.get(tfm[1]) || null;
        }
        const units: number[] = [];
        for (let i = 0; i < tm[1].length; i += 4) {
          const u = parseInt(tm[1].slice(i, i + 4), 16);
          if (u !== 0) units.push(u);
        }
        pageText += String.fromCharCode(...units);
      } else if (tm[3]) {
        currentFont = fontMap.get(tm[3]) || null;
      } else if (tm[4]) {
        pageText += decodeTokenHex(tm[4]);
      } else if (tm[5]) {
        const subRe = /<([0-9A-Fa-f]+)>/g;
        let sm: RegExpExecArray | null;
        while ((sm = subRe.exec(tm[5])) !== null) {
          pageText += decodeTokenHex(sm[1]);
        }
      }
    }
    pages.push(pageText.replace(/\s+/g, ' ').trim());
  }

  let title = '';
  for (const [, obj] of objects.entries()) {
    const titleMatch = obj.body.match(/\/Title\s*<FEFF([0-9A-Fa-f]+)>/);
    if (titleMatch) {
      const units: number[] = [];
      for (let i = 0; i < titleMatch[1].length; i += 4) {
        const u = parseInt(titleMatch[1].slice(i, i + 4), 16);
        if (u !== 0) units.push(u);
      }
      title = String.fromCharCode(...units).normalize('NFKC');
      break;
    }
  }

  const fullText = pages.join('\n');
  return {
    pageCount: pages.length,
    pages,
    fullText,
    normalizedText: fullText.normalize('NFKC'),
    title,
    mediaBoxes,
  };
}

async function verifyHtmlLayout(
  html: string,
  orientation: 'portrait' | 'landscape',
  prefix: string,
): Promise<{
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  overflowingCells: number;
}> {
  const width = orientation === 'landscape' ? 1123 : 794;
  const height = orientation === 'landscape' ? 794 : 1123;
  const htmlFile = path.join(testDir, `layout-${prefix}.html`);
  fs.writeFileSync(htmlFile, html, 'utf8');
  const win = new rawElectron.BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await win.loadFile(htmlFile);
    return (await win.webContents.executeJavaScript(`(() => {
      const docEl = document.documentElement;
      const vw = docEl.clientWidth;
      let overflowingCells = 0;
      for (const el of document.querySelectorAll('table, th, td')) {
        const rect = el.getBoundingClientRect();
        if (rect.right > vw + 2 || el.scrollWidth > el.clientWidth + 2) {
          overflowingCells += 1;
        }
      }
      return {
        scrollWidth: docEl.scrollWidth,
        clientWidth: docEl.clientWidth,
        scrollHeight: docEl.scrollHeight,
        clientHeight: docEl.clientHeight,
        overflowingCells,
      };
    })()`)) as {
      scrollWidth: number;
      clientWidth: number;
      scrollHeight: number;
      clientHeight: number;
      overflowingCells: number;
    };
  } finally {
    try {
      fs.unlinkSync(htmlFile);
    } catch {}
    if (!win.isDestroyed()) win.destroy();
  }
}

async function verifyBrowserPrintFallback(html: string): Promise<void> {
  const { exportHtmlDocumentAsPdf } = require('../frontend/src/lib/export-pdf');
  const originalWindow = (globalThis as any).window;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  URL.createObjectURL = () => {
    const url = `blob:report-pdf-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };

  const actions: string[] = [];
  let listeners = new Map<string, Array<() => void>>();
  const popup: any = {
    closed: false,
    document: { readyState: 'complete' },
    location: {
      href: 'about:blank',
      replace(url: string) {
        actions.push(`replace:${url}`);
        popup.location.href = url;
        listeners = new Map<string, Array<() => void>>();
        popup.document = { readyState: 'loading' };
      },
    },
    addEventListener(type: string, callback: () => void) {
      const list = listeners.get(type) || [];
      list.push(callback);
      listeners.set(type, list);
    },
    focus() {
      actions.push('focus');
    },
    print() {
      actions.push('print');
    },
    close() {
      actions.push('close');
      popup.closed = true;
    },
    dispatchLoad() {
      popup.document.readyState = 'complete';
      for (const cb of [...(listeners.get('load') || [])]) cb();
    },
    dispatchAfterPrint() {
      for (const cb of [...(listeners.get('afterprint') || [])]) cb();
    },
  };

  try {
    (globalThis as any).window = {
      open: () => popup,
    };
    await exportHtmlDocumentAsPdf({
      html,
      filename: 'x-report-2026-09-25.pdf',
      pageSize: 'A4',
    });
    assert.deepEqual(
      actions,
      ['replace:blob:report-pdf-1'],
      'browser fallback navigates opened popup to HTML blob URL',
    );
    popup.dispatchLoad();
    assert.deepEqual(
      actions,
      ['replace:blob:report-pdf-1', 'focus', 'print'],
      'browser fallback focuses popup and triggers window.print() once loaded',
    );
    popup.dispatchAfterPrint();
    assert.equal(popup.closed, true, 'browser fallback closes popup after print completes');
    assert.deepEqual(
      revokedUrls,
      ['blob:report-pdf-1'],
      'browser fallback revokes blob URL after print completes',
    );
  } finally {
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
}

async function run(): Promise<void> {
  let server: any;
  try {
    if (isRealElectronRuntime) {
      rawElectron.app.on('window-all-closed', () => {});
      await rawElectron.app.whenReady();
    } else {
      assert.ok(exposedApi, 'preload exposes electronAPI');
      const unsubscribe = exposedApi!.onMenuAction(() => undefined);
      for (const channel of [
        'go-pos',
        'go-dashboard',
        'go-orders',
        'go-kds',
        'go-tables',
        'go-products',
        'go-inventory',
        'go-customers',
        'go-staff',
      ]) {
        assert.ok(menuChannels.has(channel), `preload allows ${channel}`);
      }
      unsubscribe();
    }

    const db = initTestDb();
    const owner = seedOwnerUser(db);
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cashier-reports-export',
      'Cashier User',
      'cashier-export@flocafe.local',
      'hash',
      'cashier',
      1,
      now(),
      now(),
    );
    const cashier = {
      token: jwt.sign(
        {
          userId: 'cashier-reports-export',
          email: 'cashier-export@flocafe.local',
          role: 'cashier',
        },
        getJWTSecret(),
        { expiresIn: '1h' },
      ),
    };
    db.prepare("UPDATE users SET name = '=Formula Staff' WHERE id = ?").run(owner.userId);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_name', 'كافيه النور · 東京カフェ · फ्लो कैफे · Café Élégant <script>alert(1)</script>', CURRENT_TIMESTAMP)",
    ).run();

    seedCategory(db, 'cat-rep-exp', 'Beverages & Pâtisserie');
    const specialProducts = [
      { id: 'prod-rep-1', name: '抹茶ラテ Matcha Latte', sku: 'SKU-MATCHA-01', price: 120 },
      { id: 'prod-rep-2', name: 'قهوة عربية Arabic Coffee', sku: 'SKU-ARABIC-02', price: 110 },
      { id: 'prod-rep-3', name: 'मसाला चाय Masala Chai', sku: 'SKU-CHAI-03', price: 100 },
      { id: 'prod-rep-4', name: 'Crème Brûlée Éclair', sku: 'SKU-ECLAIR-04', price: 120 },
    ];
    for (let i = 5; i <= 35; i++) {
      const padded = String(i).padStart(2, '0');
      specialProducts.push({
        id: `prod-rep-${padded}`,
        name: `Specialty Item ${padded}`,
        sku: `SKU-SPEC-${padded}`,
        price: 20 + i,
      });
    }
    for (const prod of specialProducts) {
      seedProduct(db, prod.id, 'cat-rep-exp', prod.name, prod.price);
    }

    const mainFrame = { frameToken: 'frame-main', detached: false };
    const mainWin = { isDestroyed: () => false };
    const trustedSender = {
      sender: {
        ownerWindow: mainWin,
        mainFrame,
        getURL: () => 'http://localhost:3001/',
      },
      senderFrame: mainFrame,
    };
    registerIpcHandlers(undefined, () => mainWin as any);
    const saveHtmlAsPdfIpc = registeredIpcHandlers.get('save-html-as-pdf');
    assert.ok(saveHtmlAsPdfIpc, 'save-html-as-pdf IPC handler is registered');

    const app = createApp({
      '/api/reports': reportRoutes,
      '/api/cash-closures': cashClosureRoutes,
    });
    ({ server } = await startServer(app));
    const http = request(server);
    const businessDate = '2026-09-25';
    const paidAt = new Date(`${businessDate}T12:00:00Z`)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    db.prepare(`
      INSERT INTO orders (order_number, user_id, type, status, subtotal, tax_amount, total, created_at, updated_at, completed_at)
      VALUES (?, ?, 'takeaway', 'completed', 450, 50, 500, ?, ?, ?)
    `).run('ORD-REPORT-EXPORT', owner.userId, paidAt, paidAt, paidAt);
    const orderId = Number(
      (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-REPORT-EXPORT') as any)
        .id,
    );
    const day1Items = [
      { prod: specialProducts[0], qty: 1, subtotal: 120, tax: 12, cost: 40 },
      { prod: specialProducts[1], qty: 1, subtotal: 110, tax: 11, cost: 35 },
      { prod: specialProducts[2], qty: 1, subtotal: 100, tax: 10, cost: 30 },
      { prod: specialProducts[3], qty: 1, subtotal: 120, tax: 17, cost: 45 },
    ];
    for (const entry of day1Items) {
      db.prepare(`
        INSERT INTO order_items (
          order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, tax_amount, total,
          tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ready', ?, ?)
      `).run(
        orderId,
        entry.prod.id,
        entry.prod.name,
        entry.prod.sku,
        entry.qty,
        entry.subtotal,
        entry.subtotal,
        entry.tax,
        entry.subtotal + entry.tax,
        JSON.stringify({
          taxable_base: entry.subtotal,
          components: [{ name: 'VAT <Standard>', rate: 10, amount: entry.tax }],
        }),
        entry.cost,
        paidAt,
        paidAt,
      );
    }
    db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, tax_breakdown, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (?, ?, 450, 50, ?, 500, 500, 0, 'paid', ?, ?, ?, ?)
    `).run(
      'B-REPORT-EXPORT',
      orderId,
      JSON.stringify([{ title: 'VAT <Standard>', rate: 10, amount: 50 }]),
      JSON.stringify([{ method: 'cash', amount: 500, timestamp: paidAt }]),
      paidAt,
      paidAt,
      paidAt,
    );

    // Seed days 2 and 3 (2026-09-26 and 2026-09-27) for the multi-day daily-sales range export
    const day2 = '2026-09-26';
    const day2At = '2026-09-26 13:30:00';
    const day3 = '2026-09-27';
    const day3At = '2026-09-27 15:45:00';

    const day2Prods = specialProducts.slice(4, 20);
    const day2Subtotal = day2Prods.reduce((sum, p) => sum + p.price, 0);
    const day2Tax = Number((day2Subtotal * 0.05).toFixed(2));
    const day2Total = day2Subtotal + day2Tax + 15;
    db.prepare(`
      INSERT INTO orders (order_number, user_id, type, status, subtotal, tax_amount, service_charge, total, created_at, updated_at, completed_at)
      VALUES ('ORD-REP-DAY2', ?, 'dine_in', 'completed', ?, ?, 15, ?, ?, ?, ?)
    `).run(owner.userId, day2Subtotal, day2Tax, day2Total, day2At, day2At, day2At);
    const orderDay2Id = Number(
      (db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-REP-DAY2'").get() as any).id,
    );
    for (const prod of day2Prods) {
      const cgst = Number((prod.price * 0.025).toFixed(2));
      const sgst = Number((prod.price * 0.025).toFixed(2));
      const itemTax = Number((cgst + sgst).toFixed(2));
      db.prepare(`
        INSERT INTO order_items (
          order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, tax_amount, total,
          tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 'ready', ?, ?)
      `).run(
        orderDay2Id,
        prod.id,
        prod.name,
        prod.sku,
        prod.price,
        prod.price,
        itemTax,
        prod.price + itemTax,
        JSON.stringify({
          taxable_base: prod.price,
          components: [
            { name: 'CGST', rate: 2.5, amount: cgst },
            { name: 'SGST', rate: 2.5, amount: sgst },
          ],
        }),
        Number((prod.price * 0.35).toFixed(2)),
        day2At,
        day2At,
      );
    }
    const billDay2Id = Number(
      db
        .prepare(`
        INSERT INTO bills (
          bill_number, order_id, subtotal, tax_amount, service_charge, total, paid_amount, balance,
          payment_status, payment_details, paid_at, created_at, updated_at
        )
        VALUES ('B-REP-DAY2', ?, ?, ?, 15, ?, ?, 0, 'paid', ?, ?, ?, ?)
      `)
        .run(
          orderDay2Id,
          day2Subtotal,
          day2Tax,
          day2Total,
          day2Total,
          JSON.stringify([
            { method: 'card', amount: day2Total, timestamp: day2At, transaction_id: 'TXN-DAY2-01' },
          ]),
          day2At,
          day2At,
          day2At,
        ).lastInsertRowid,
    );
    db.prepare(`
      INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
      VALUES (?, NULL, 2500, 'cash', 'customer courtesy refund', NULL, ?, ?, ?)
    `).run(billDay2Id, owner.userId, owner.userId, day2At);

    const day3Prods = specialProducts.slice(20);
    const day3Subtotal = day3Prods.reduce((sum, p) => sum + p.price, 0);
    const day3Tax = Number((day3Subtotal * 0.1).toFixed(2));
    const day3Total = day3Subtotal - 10 + day3Tax + 5 + 8;
    db.prepare(`
      INSERT INTO orders (
        order_number, user_id, type, status, subtotal, discount_amount, tax_amount,
        packaging_charge, delivery_charge, total, created_at, updated_at, completed_at
      )
      VALUES ('ORD-REP-DAY3', ?, 'delivery', 'completed', ?, 10, ?, 5, 8, ?, ?, ?, ?)
    `).run(owner.userId, day3Subtotal, day3Tax, day3Total, day3At, day3At, day3At);
    const orderDay3Id = Number(
      (db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-REP-DAY3'").get() as any).id,
    );
    for (const prod of day3Prods) {
      const itemTax = Number((prod.price * 0.1).toFixed(2));
      db.prepare(`
        INSERT INTO order_items (
          order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, tax_amount, total,
          tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 'ready', ?, ?)
      `).run(
        orderDay3Id,
        prod.id,
        prod.name,
        prod.sku,
        prod.price,
        prod.price,
        itemTax,
        prod.price + itemTax,
        JSON.stringify({
          taxable_base: prod.price,
          components: [{ name: 'VAT <Standard>', rate: 10, amount: itemTax }],
        }),
        Number((prod.price * 0.4).toFixed(2)),
        day3At,
        day3At,
      );
    }
    db.prepare(`
      INSERT INTO bills (
        bill_number, order_id, subtotal, discount_amount, tax_amount, packaging_charge, delivery_charge,
        tax_snapshot, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at
      )
      VALUES ('B-REP-DAY3', ?, ?, 10, ?, 5, 8, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)
    `).run(
      orderDay3Id,
      day3Subtotal,
      day3Tax,
      JSON.stringify({
        lines: [
          {
            taxableBase: day3Subtotal,
            components: [{ label: 'VAT <Standard>', rate: 10, amount: day3Tax }],
          },
        ],
      }),
      day3Total,
      day3Total,
      JSON.stringify([{ method: 'cash', amount: day3Total, timestamp: day3At }]),
      day3At,
      day3At,
      day3At,
    );

    const auth = { Authorization: `Bearer ${owner.token}` };
    const cashierAuth = { Authorization: `Bearer ${cashier.token}` };

    const forbiddenXHtml = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=html`)
      .set(cashierAuth);
    assert.equal(
      forbiddenXHtml.status,
      403,
      'unauthorized cashier gets 403 on X report HTML export',
    );
    const forbiddenZHtml = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=html`)
      .set(cashierAuth);
    assert.equal(
      forbiddenZHtml.status,
      403,
      'unauthorized cashier gets 403 on Z report HTML export',
    );
    const badXFormat = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=pdf`)
      .set(auth);
    assert.equal(badXFormat.status, 400, 'invalid format=pdf on X report returns 400');

    const xCsv = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=csv`)
      .set(auth);
    assert.equal(xCsv.status, 200, 'X report CSV returns 200');
    assert.match(xCsv.headers['content-type'], /text\/csv/);
    assert.ok(xCsv.headers['content-disposition'].includes(`x-report-${businessDate}.csv`));
    assert.ok(xCsv.text.includes('summary,Gross Sales,,,,500'));
    assert.ok(
      xCsv.text.includes("'=Formula Staff"),
      'X report CSV neutralizes formula-like staff names',
    );

    const xXlsx = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=xlsx`)
      .set(auth)
      .buffer(true)
      .parse(parseBuffer);
    assert.equal(xXlsx.status, 200, 'X report XLSX returns 200');
    assert.match(xXlsx.headers['content-type'], /spreadsheetml\.sheet/);
    const xWorkbook = new ExcelJS.Workbook();
    await xWorkbook.xlsx.load(xXlsx.body);
    assert.deepEqual(
      xWorkbook.worksheets.map((sheet: any) => sheet.name),
      ['Summary', 'Payments', 'Staff'],
    );
    const xMetrics = new Map<string, unknown>();
    xWorkbook.getWorksheet('Summary').eachRow((row: any, rowNumber: number) => {
      if (rowNumber > 1) xMetrics.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    assert.equal(xMetrics.get('Gross Sales'), 500);
    assert.equal(xMetrics.get('Bill Count'), 1);

    const xHtml = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=html`)
      .set(auth);
    assert.equal(xHtml.status, 200, 'X report HTML returns 200');
    assert.match(xHtml.headers['content-type'], /text\/html/);
    assert.ok(xHtml.headers['content-disposition'].includes(`x-report-${businessDate}.html`));
    assert.ok(
      xHtml.text.startsWith('<!doctype html>'),
      'X report HTML is a complete HTML5 document',
    );
    assert.ok(
      xHtml.text.includes('@page { size: A4 portrait; margin: 12mm; }'),
      'X report HTML includes A4 print page rule',
    );
    assert.ok(
      xHtml.text.includes(
        'كافيه النور · 東京カフェ · फ्लो कैफे · Café Élégant &lt;script&gt;alert(1)&lt;/script&gt;',
      ),
      'X report HTML renders non-Latin store name and escapes HTML',
    );
    assert.ok(
      !xHtml.text.includes('<script>alert(1)</script>'),
      'X report HTML never injects raw script tags',
    );
    assert.ok(
      xHtml.text.includes('VAT &lt;Standard&gt;'),
      'X report HTML includes escaped tax component title',
    );
    const xHtmlMetrics = parseHtmlSummaryMetrics(xHtml.text);
    for (const [metric, xlsxVal] of xMetrics.entries()) {
      assert.equal(
        xHtmlMetrics.get(metric),
        xlsxVal === null || xlsxVal === undefined ? '' : String(xlsxVal),
        `X report HTML metric ${metric} matches XLSX`,
      );
    }

    const unclosedZ = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=csv`)
      .set(auth);
    assert.equal(unclosedZ.status, 404, 'unclosed Z report returns 404');
    assert.equal(unclosedZ.body.error, 'Day not closed');
    const unclosedZHtml = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=html`)
      .set(auth);
    assert.equal(unclosedZHtml.status, 404, 'unclosed Z report HTML returns 404');
    assert.equal(unclosedZHtml.body.error, 'Day not closed');

    const close = await http.post('/api/cash-closures').set(auth).send({
      business_date: businessDate,
      opening_float_cents: 10000,
      counted_cash_cents: 65000,
      notes: 'End of day <b>check</b>',
    });
    assert.equal(close.status, 201, 'test day closes');
    assert.equal(close.body.zReport.expected_cash_cents, 60000);
    assert.equal(close.body.zReport.variance_cents, 5000);

    const zCsv = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=csv`)
      .set(auth);
    assert.equal(zCsv.status, 200, 'Z report CSV returns 200');
    assert.ok(
      zCsv.headers['content-disposition'].includes(
        `z-report-Z${close.body.zReport.z_number}-${businessDate}.csv`,
      ),
    );
    assert.ok(
      zCsv.text.includes('summary,Expected Cash in Drawer,,,,600\n'),
      'Z report CSV includes expected cash in display units',
    );
    assert.ok(
      zCsv.text.includes('summary,Cash Variance,,,,50\n'),
      'Z report CSV includes cash variance in display units',
    );

    const zXlsx = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=xlsx`)
      .set(auth)
      .buffer(true)
      .parse(parseBuffer);
    assert.equal(zXlsx.status, 200, 'Z report XLSX returns 200');
    const zWorkbook = new ExcelJS.Workbook();
    await zWorkbook.xlsx.load(zXlsx.body);
    const zMetrics = new Map<string, unknown>();
    zWorkbook.getWorksheet('Summary').eachRow((row: any, rowNumber: number) => {
      if (rowNumber > 1) zMetrics.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    assert.equal(zMetrics.get('Gross Sales'), 500);
    assert.equal(zMetrics.get('Expected Cash in Drawer'), 600);
    assert.equal(zMetrics.get('Counted Cash'), 650);
    assert.equal(zMetrics.get('Cash Variance'), 50);
    assert.equal(zMetrics.get('Closed By'), '=Formula Staff');

    const zHtml = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=html`)
      .set(auth);
    assert.equal(zHtml.status, 200, 'Z report HTML returns 200');
    assert.match(zHtml.headers['content-type'], /text\/html/);
    assert.ok(
      zHtml.headers['content-disposition'].includes(
        `z-report-Z${close.body.zReport.z_number}-${businessDate}.html`,
      ),
    );
    assert.ok(
      zHtml.text.includes('End of day &lt;b&gt;check&lt;/b&gt;'),
      'Z report HTML escapes notes',
    );
    assert.ok(
      zHtml.text.includes('VAT &lt;Standard&gt;'),
      'Z report HTML includes tax breakdown from snapshot',
    );
    const zHtmlMetrics = parseHtmlSummaryMetrics(zHtml.text);
    for (const [metric, xlsxVal] of zMetrics.entries()) {
      assert.equal(
        zHtmlMetrics.get(metric),
        xlsxVal === null || xlsxVal === undefined ? '' : String(xlsxVal),
        `Z report HTML metric ${metric} matches XLSX`,
      );
    }

    // Fetch Date-range Daily Sales XLSX, CSV, and HTML
    const dsRangeXlsx = await http
      .get(`/api/reports/daily-sales/export?from=${businessDate}&to=${day3}&format=xlsx`)
      .set(auth)
      .buffer(true)
      .parse(parseBuffer);
    assert.equal(dsRangeXlsx.status, 200, 'daily-sales range XLSX returns 200');
    const dsWorkbook = new ExcelJS.Workbook();
    await dsWorkbook.xlsx.load(dsRangeXlsx.body);
    const dsSummaryMetrics = new Map<string, string>();
    dsWorkbook.getWorksheet('Summary').eachRow((row: any, rowNumber: number) => {
      if (rowNumber > 1) {
        dsSummaryMetrics.set(String(row.getCell(1).value), String(row.getCell(2).value ?? ''));
      }
    });

    const dsRangeHtml = await http
      .get(`/api/reports/daily-sales/export?from=${businessDate}&to=${day3}&format=html`)
      .set(auth);
    assert.equal(dsRangeHtml.status, 200, 'daily-sales range HTML returns 200');
    const dsHtmlMetrics = parseHtmlSummaryMetrics(dsRangeHtml.text);
    for (const [metric, xlsxVal] of dsSummaryMetrics.entries()) {
      assert.equal(
        dsHtmlMetrics.get(metric),
        xlsxVal,
        `daily-sales range HTML metric ${metric} matches XLSX`,
      );
    }

    // Verify browser print fallback when window.electronAPI.saveHtmlAsPdf is absent
    await verifyBrowserPrintFallback(xHtml.text);

    // Verify save-html-as-pdf IPC handler:
    // (1) User save-dialog cancellation returns { success: false, canceled: true } without opening a BrowserWindow or writing a file
    trackedBrowserWindows.length = 0;
    const cancelTargetPath = path.join(testDir, 'cancelled-report.pdf');
    saveDialogResult = { canceled: true };
    const cancelRes = await saveHtmlAsPdfIpc!(trustedSender, {
      html: xHtml.text,
      defaultFileName: 'x-report-cancelled.pdf',
      pageSize: 'A4',
    });
    assert.deepEqual(
      cancelRes,
      { success: false, canceled: true },
      'cancelled save-html-as-pdf returns { success: false, canceled: true }',
    );
    assert.equal(
      trackedBrowserWindows.length,
      0,
      'cancelled save-html-as-pdf opens no BrowserWindow',
    );
    assert.equal(
      fs.existsSync(cancelTargetPath),
      false,
      'cancelled save-html-as-pdf writes no file',
    );

    // (2) Oversize HTML (> MAX_PDF_HTML_BYTES) fails before opening a BrowserWindow with Document too large to export
    trackedBrowserWindows.length = 0;
    const oversizeHtml = `<!doctype html><html><body>${'x'.repeat(MAX_PDF_HTML_BYTES + 1024)}</body></html>`;
    const oversizeRes = await saveHtmlAsPdfIpc!(trustedSender, {
      html: oversizeHtml,
      defaultFileName: 'oversize.pdf',
      pageSize: 'A4',
    });
    assert.deepEqual(
      oversizeRes,
      { success: false, error: 'Document too large to export' },
      'oversize HTML (> MAX_PDF_HTML_BYTES) fails with Document too large to export',
    );
    assert.equal(
      trackedBrowserWindows.length,
      0,
      'oversize HTML fails before opening any BrowserWindow',
    );
    await assert.rejects(
      () => renderHtmlToPdfBuffer({ html: oversizeHtml, pageSize: 'A4' }),
      /Document too large to export/,
      'renderHtmlToPdfBuffer also rejects oversize HTML before opening a BrowserWindow',
    );
    assert.equal(
      trackedBrowserWindows.length,
      0,
      'renderHtmlToPdfBuffer oversize check opens no BrowserWindow',
    );

    // Windows 8.3 short-path tilde vs %7E file:// URL allowlist check (issue #1397 / build-windows-x64)
    const winStagedHtmlPath =
      'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\flo-reports-export\\pdf-staging\\document-123.html';
    assert.equal(
      isAllowedPdfStagingRequestUrl(
        'file:///C:/Users/RUNNER~1/AppData/Local/Temp/flo-reports-export/pdf-staging/document-123.html',
        winStagedHtmlPath,
      ),
      true,
      'unencoded tilde file:///C:/Users/RUNNER~1/... is allowed for staged HTML file',
    );
    assert.equal(
      isAllowedPdfStagingRequestUrl(
        'file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/flo-reports-export/pdf-staging/document-123.html',
        winStagedHtmlPath,
      ),
      true,
      'percent-encoded tilde file:///C:/Users/RUNNER%7E1/... is allowed for staged HTML file',
    );
    assert.equal(
      isAllowedPdfStagingRequestUrl('data:image/png;base64,iVBORw0KGgo=', winStagedHtmlPath),
      true,
      'inline data:image/ URL remains allowed',
    );
    assert.equal(
      isAllowedPdfStagingRequestUrl(
        'file:///C:/Users/RUNNER~1/AppData/Local/Temp/flo-reports-export/pdf-staging/other.html',
        winStagedHtmlPath,
      ),
      false,
      'different file:// URL in same directory is rejected',
    );
    assert.equal(
      isAllowedPdfStagingRequestUrl(
        'file:///C:/Users/RUNNER~1/AppData/Local/Temp/flo-reports-export/pdf-staging/document-123.html?exfil=1',
        winStagedHtmlPath,
      ),
      false,
      'file:// URL with query string is rejected',
    );
    assert.equal(
      isAllowedPdfStagingRequestUrl('https://example.com/exfil.png', winStagedHtmlPath),
      false,
      'remote https:// URL is rejected',
    );

    // (3) Execute save-html-as-pdf on X report, Z report, and date-range daily-sales report
    const xPdfPath = path.join(testDir, `x-report-${businessDate}.pdf`);
    saveDialogResult = { canceled: false, filePath: xPdfPath };
    const xSaveRes = await saveHtmlAsPdfIpc!(trustedSender, {
      html: xHtml.text,
      defaultFileName: `x-report-${businessDate}.pdf`,
      pageSize: 'A4',
    });
    assert.deepEqual(
      xSaveRes,
      { success: true, path: xPdfPath },
      'save-html-as-pdf writes X report PDF',
    );
    const xPdfBuffer = fs.readFileSync(xPdfPath);
    assert.equal(
      xPdfBuffer.subarray(0, 5).toString('ascii'),
      '%PDF-',
      'X report PDF begins with %PDF-',
    );
    assert.ok(xPdfBuffer.length > 0, 'X report PDF is non-empty');
    assert.ok(
      lastLoadedHtmlPath.length > 0 && !fs.existsSync(lastLoadedHtmlPath),
      'X report staging HTML file is cleaned up after PDF render',
    );

    const zPdfPath = path.join(
      testDir,
      `z-report-Z${close.body.zReport.z_number}-${businessDate}.pdf`,
    );
    saveDialogResult = { canceled: false, filePath: zPdfPath };
    const zSaveRes = await saveHtmlAsPdfIpc!(trustedSender, {
      html: zHtml.text,
      defaultFileName: `z-report-Z${close.body.zReport.z_number}-${businessDate}.pdf`,
      pageSize: 'A4',
    });
    assert.deepEqual(
      zSaveRes,
      { success: true, path: zPdfPath },
      'save-html-as-pdf writes Z report PDF',
    );
    const zPdfBuffer = fs.readFileSync(zPdfPath);
    assert.equal(
      zPdfBuffer.subarray(0, 5).toString('ascii'),
      '%PDF-',
      'Z report PDF begins with %PDF-',
    );
    assert.ok(zPdfBuffer.length > 0, 'Z report PDF is non-empty');
    assert.ok(
      lastLoadedHtmlPath.length > 0 && !fs.existsSync(lastLoadedHtmlPath),
      'Z report staging HTML file is cleaned up after PDF render',
    );

    const dsPdfPath = path.join(testDir, `daily-sales-${businessDate}_to_${day3}.pdf`);
    saveDialogResult = { canceled: false, filePath: dsPdfPath };
    const dsSaveRes = await saveHtmlAsPdfIpc!(trustedSender, {
      html: dsRangeHtml.text,
      defaultFileName: `daily-sales-${businessDate}_to_${day3}.pdf`,
      pageSize: 'A4',
    });
    assert.deepEqual(
      dsSaveRes,
      { success: true, path: dsPdfPath },
      'save-html-as-pdf writes date-range daily-sales PDF',
    );
    const dsPdfBuffer = fs.readFileSync(dsPdfPath);
    assert.equal(
      dsPdfBuffer.subarray(0, 5).toString('ascii'),
      '%PDF-',
      'daily-sales PDF begins with %PDF-',
    );
    assert.ok(dsPdfBuffer.length > 0, 'daily-sales PDF is non-empty');
    assert.ok(
      lastLoadedHtmlPath.length > 0 && !fs.existsSync(lastLoadedHtmlPath),
      'daily-sales staging HTML file is cleaned up after PDF render',
    );

    if (!isRealElectronRuntime) {
      const xPdfText = xPdfBuffer.toString('utf8');
      assert.ok(
        xPdfText.includes('pageSize=A4 preferCSSPageSize=true'),
        'X report PDF render passes pageSize and preferCSSPageSize=true',
      );
      const xPdfMetrics = parseHtmlSummaryMetrics(xPdfText);
      for (const [metric, xlsxVal] of xMetrics.entries()) {
        assert.equal(
          xPdfMetrics.get(metric),
          xlsxVal === null || xlsxVal === undefined ? '' : String(xlsxVal),
          `X report PDF metric ${metric} matches XLSX`,
        );
      }

      const zPdfText = zPdfBuffer.toString('utf8');
      assert.ok(
        zPdfText.includes('pageSize=A4 preferCSSPageSize=true'),
        'Z report PDF render passes pageSize and preferCSSPageSize=true',
      );
      assert.ok(
        zPdfText.includes(`Z Report #${close.body.zReport.z_number} — ${businessDate}`),
        'Z report PDF contains Z report header',
      );
      const zPdfMetrics = parseHtmlSummaryMetrics(zPdfText);
      for (const [metric, xlsxVal] of zMetrics.entries()) {
        assert.equal(
          zPdfMetrics.get(metric),
          xlsxVal === null || xlsxVal === undefined ? '' : String(xlsxVal),
          `Z report PDF metric ${metric} matches XLSX`,
        );
      }
    } else {
      // Real native Electron Chromium webContents.printToPDF verification
      assert.equal(
        trackedBrowserWindows.length,
        3,
        'exactly 3 real BrowserWindow instances were used for X, Z, and daily-sales PDFs',
      );
      for (const win of trackedBrowserWindows) {
        assert.equal(
          win.destroyedFlag,
          true,
          'every real offscreen PDF BrowserWindow is destroyed after printToPDF',
        );
      }

      const xPdfInfo = extractPdfInfo(xPdfBuffer);
      assert.ok(xPdfInfo.pageCount >= 1, 'real X report PDF has at least 1 page');
      assert.ok(
        xPdfInfo.mediaBoxes.length === xPdfInfo.pageCount &&
          xPdfInfo.mediaBoxes[0][2] < xPdfInfo.mediaBoxes[0][3],
        'real X report PDF uses A4 portrait page dimensions',
      );
      for (const [metric, val] of xMetrics.entries()) {
        const sVal = val === null || val === undefined ? '' : String(val);
        if (sVal === '') continue;
        assert.ok(
          xPdfInfo.normalizedText.includes(metric) && xPdfInfo.normalizedText.includes(sVal),
          `real X report PDF text reconciles metric ${metric}=${sVal} with XLSX`,
        );
      }
      assert.ok(
        xPdfInfo.title.includes(
          'كافيه النور · 東京カフェ · फ्लो कैफे · Café Élégant <script>alert(1)</script>',
        ),
        'real X report PDF metadata title preserves full multi-script business name',
      );
      for (const expectedToken of [
        '東京カフェ',
        'फ्लो कैफे',
        'Café Élégant',
        `X Report — ${businessDate}`,
        '₹500.00',
        'cash',
        'VAT <Standard>',
        '=Formula Staff',
      ]) {
        assert.ok(
          pdfTextIncludesToken(xPdfInfo, expectedToken),
          `real X report PDF text includes "${expectedToken}"`,
        );
      }
      assert.ok(
        xPdfInfo.normalizedText.includes('النور') || xPdfInfo.normalizedText.includes('رونلا'),
        'real X report PDF text includes Arabic store name glyphs',
      );

      const zPdfInfo = extractPdfInfo(zPdfBuffer);
      assert.ok(zPdfInfo.pageCount >= 1, 'real Z report PDF has at least 1 page');
      assert.ok(
        zPdfInfo.mediaBoxes.length === zPdfInfo.pageCount &&
          zPdfInfo.mediaBoxes[0][2] < zPdfInfo.mediaBoxes[0][3],
        'real Z report PDF uses A4 portrait page dimensions',
      );
      for (const [metric, val] of zMetrics.entries()) {
        const sVal = val === null || val === undefined ? '' : String(val);
        if (sVal === '') continue;
        assert.ok(
          zPdfInfo.normalizedText.includes(metric) && zPdfInfo.normalizedText.includes(sVal),
          `real Z report PDF text reconciles metric ${metric}=${sVal} with XLSX`,
        );
      }
      assert.ok(
        zPdfInfo.title.includes(
          'كافيه النور · 東京カフェ · फ्लो कैफे · Café Élégant <script>alert(1)</script>',
        ),
        'real Z report PDF metadata title preserves full multi-script business name',
      );
      for (const expectedToken of [
        '東京カフェ',
        'फ्लो कैफे',
        'Café Élégant',
        `Z Report #${close.body.zReport.z_number} — ${businessDate}`,
        `Z#${close.body.zReport.z_number}`,
        '=Formula Staff',
        'End of day <b>check</b>',
        '₹600.00',
        '₹650.00',
        '₹50.00',
        'VAT <Standard>',
      ]) {
        assert.ok(
          pdfTextIncludesToken(zPdfInfo, expectedToken),
          `real Z report PDF text includes "${expectedToken}"`,
        );
      }

      const dsPdfInfo = extractPdfInfo(dsPdfBuffer);
      assert.ok(
        dsPdfInfo.pageCount >= 2,
        `real multi-row daily-sales PDF paginates across multiple pages (got ${dsPdfInfo.pageCount})`,
      );
      assert.ok(
        dsPdfInfo.mediaBoxes.length === dsPdfInfo.pageCount &&
          dsPdfInfo.mediaBoxes[0][2] > dsPdfInfo.mediaBoxes[0][3],
        'real daily-sales PDF uses A4 landscape page dimensions',
      );
      const dsCompactText = dsPdfInfo.normalizedText.replace(/\s+/g, '');
      for (const [metric, val] of dsSummaryMetrics.entries()) {
        if (val === '') continue;
        assert.ok(
          dsCompactText.includes(metric.replace(/\s+/g, '')) &&
            dsCompactText.includes(val.replace(/\s+/g, '')),
          `real daily-sales PDF text reconciles summary metric ${metric}=${val} with XLSX`,
        );
      }
      assert.ok(
        dsPdfInfo.title.includes(
          'كافيه النور · 東京カフェ · फ्लो कैफे · Café Élégant <script>alert(1)</script>',
        ),
        'real daily-sales PDF metadata title preserves full multi-script business name',
      );
      for (const expectedToken of [
        '東京カフェ',
        'फ्लो कैफे',
        'Café Élégant',
        businessDate,
        day2,
        day3,
        'VAT <Standard>',
        'CGST',
        'SGST',
        '抹茶ラテ Matcha Latte',
        'मसाला चाय Masala Chai',
        'Crème Brûlée Éclair',
        'SKU-MATCHA-01',
        'SKU-ARABIC-02',
        'SKU-CHAI-03',
        'SKU-ECLAIR-04',
        'Specialty Item 05',
        'Specialty Item 35',
        'SKU-SPEC-35',
      ]) {
        assert.ok(
          pdfTextIncludesToken(dsPdfInfo, expectedToken),
          `real daily-sales PDF text includes "${expectedToken}"`,
        );
      }
      assert.ok(
        dsPdfInfo.pages.filter((p) => p.includes('Product ID') && p.includes('Product Name'))
          .length >= 2,
        'real daily-sales PDF repeats Item Sales table header on subsequent page',
      );

      // Verify layout (no horizontal clipping/overflow)
      const xLayout = await verifyHtmlLayout(xHtml.text, 'portrait', 'x-report');
      assert.ok(
        xLayout.scrollWidth <= xLayout.clientWidth && xLayout.overflowingCells === 0,
        `X report layout has no horizontal clipping or overflow (${JSON.stringify(xLayout)})`,
      );

      const zLayout = await verifyHtmlLayout(zHtml.text, 'portrait', 'z-report');
      assert.ok(
        zLayout.scrollWidth <= zLayout.clientWidth && zLayout.overflowingCells === 0,
        `Z report layout has no horizontal clipping or overflow (${JSON.stringify(zLayout)})`,
      );

      const dsLayout = await verifyHtmlLayout(dsRangeHtml.text, 'landscape', 'daily-sales');
      assert.ok(
        dsLayout.scrollWidth <= dsLayout.clientWidth && dsLayout.overflowingCells === 0,
        `daily-sales layout has no horizontal clipping or overflow (${JSON.stringify(dsLayout)})`,
      );

      console.log(
        `real Electron printToPDF verification passed (X=${xPdfBuffer.length}B/${xPdfInfo.pageCount}p, Z=${zPdfBuffer.length}B/${zPdfInfo.pageCount}p, DailySales=${dsPdfBuffer.length}B/${dsPdfInfo.pageCount}p)`,
      );
    }

    // ── Session-scoped X-report export (CSV, XLSX, HTML/PDF) + useCashClose hook regression ──
    {
      const shiftExportDate = '2026-09-28';
      const shift1OpenAt = '2026-09-28 08:00:00';
      const shift2OpenAt = '2026-09-28 09:00:00';
      const shiftSaleAt = '2026-09-28 10:30:00';

      const s1Insert = db
        .prepare(
          `INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status)
           VALUES (?, ?, ?, ?, 'open')`,
        )
        .run('cashier-reports-export', 'Cashier User', shift1OpenAt, 10000);
      const shift1Id = Number(s1Insert.lastInsertRowid);

      const s2Insert = db
        .prepare(
          `INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status)
           VALUES (?, ?, ?, ?, 'open')`,
        )
        .run(owner.userId, '=Formula Staff', shift2OpenAt, 20000);
      const shift2Id = Number(s2Insert.lastInsertRowid);

      db.prepare(
        `INSERT INTO cash_drawer_movements (business_date, movement_type, amount_cents, reason, created_by, created_at)
         VALUES (?, 'opening_float', 30000, 'Day float', ?, ?)`,
      ).run(shiftExportDate, owner.userId, shift1OpenAt);
      db.prepare(
        `INSERT INTO cash_drawer_movements (business_date, movement_type, amount_cents, reason, created_by, cash_session_id, created_at)
         VALUES (?, 'pay_in', 2500, 'Shift 1 change', 'cashier-reports-export', ?, ?)`,
      ).run(shiftExportDate, shift1Id, shiftSaleAt);

      // Bill S1: 150 subtotal + 15 VAT (10%) = 165 paid in Shift 1 (cash)
      const ordS1 = db
        .prepare(
          `INSERT INTO orders (order_number, user_id, type, status, subtotal, tax_amount, total, created_at, updated_at, completed_at)
           VALUES ('ORD-SHIFT-EXP-1', 'cashier-reports-export', 'takeaway', 'completed', 150, 15, 165, ?, ?, ?)`,
        )
        .run(shiftSaleAt, shiftSaleAt, shiftSaleAt);
      const ordS1Id = Number(ordS1.lastInsertRowid);
      const s1TaxSnap = JSON.stringify({
        lines: [
          { taxableBase: 150, components: [{ label: 'VAT <Standard>', rate: 10, amount: 15 }] },
        ],
      });
      db.prepare(
        `INSERT INTO order_items (
           order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, tax_amount, total,
           tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
         ) VALUES (?, 'prod-rep-1', 'Shift 1 Item', 'SKU-S1', 1, 150, 150, 15, 165, ?, 40, 1, 'ready', ?, ?)`,
      ).run(ordS1Id, s1TaxSnap, shiftSaleAt, shiftSaleAt);
      db.prepare(
        `INSERT INTO bills (
           bill_number, order_id, subtotal, tax_amount, tax_snapshot, total, paid_amount, balance,
           payment_status, payment_details, paid_at, created_at, updated_at
         ) VALUES ('B-SHIFT-EXP-1', ?, 150, 15, ?, 165, 165, 0, 'paid', ?, ?, ?, ?)`,
      ).run(
        ordS1Id,
        s1TaxSnap,
        JSON.stringify([
          { method: 'cash', amount: 165, timestamp: shiftSaleAt, cash_session_id: shift1Id },
        ]),
        shiftSaleAt,
        shiftSaleAt,
        shiftSaleAt,
      );

      // Bill S2: 200 subtotal + 20 VAT (10%) = 220 split 55 (Shift 1 cash) + 165 (Shift 2 card)
      const ordS2 = db
        .prepare(
          `INSERT INTO orders (order_number, user_id, type, status, subtotal, tax_amount, total, created_at, updated_at, completed_at)
           VALUES ('ORD-SHIFT-EXP-2', ?, 'takeaway', 'completed', 200, 20, 220, ?, ?, ?)`,
        )
        .run(owner.userId, shiftSaleAt, shiftSaleAt, shiftSaleAt);
      const ordS2Id = Number(ordS2.lastInsertRowid);
      const s2TaxSnap = JSON.stringify({
        lines: [
          { taxableBase: 200, components: [{ label: 'VAT <Standard>', rate: 10, amount: 20 }] },
        ],
      });
      db.prepare(
        `INSERT INTO order_items (
           order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, tax_amount, total,
           tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
         ) VALUES (?, 'prod-rep-2', 'Shift Split Item', 'SKU-S2', 1, 200, 200, 20, 220, ?, 50, 1, 'ready', ?, ?)`,
      ).run(ordS2Id, s2TaxSnap, shiftSaleAt, shiftSaleAt);
      db.prepare(
        `INSERT INTO bills (
           bill_number, order_id, subtotal, tax_amount, tax_snapshot, total, paid_amount, balance,
           payment_status, payment_details, paid_at, created_at, updated_at
         ) VALUES ('B-SHIFT-EXP-2', ?, 200, 20, ?, 220, 220, 0, 'paid', ?, ?, ?, ?)`,
      ).run(
        ordS2Id,
        s2TaxSnap,
        JSON.stringify([
          { method: 'cash', amount: 55, timestamp: shiftSaleAt, cash_session_id: shift1Id },
          { method: 'card', amount: 165, timestamp: shiftSaleAt, cash_session_id: shift2Id },
        ]),
        shiftSaleAt,
        shiftSaleAt,
        shiftSaleAt,
      );

      // Permission & validation checks on GET /api/reports/x-report/export?session_id=...
      const badShiftIdRes = await http
        .get(`/api/reports/x-report/export?date=${shiftExportDate}&format=csv&session_id=bad`)
        .set(auth);
      assert.equal(badShiftIdRes.status, 400);
      assert.equal(badShiftIdRes.body.code, 'session_id_invalid');

      const missingShiftIdRes = await http
        .get(`/api/reports/x-report/export?date=${shiftExportDate}&format=csv&session_id=999999`)
        .set(auth);
      assert.equal(missingShiftIdRes.status, 404);
      assert.equal(missingShiftIdRes.body.code, 'session_unavailable');

      db.prepare(
        `INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, updated_at)
         VALUES ('cashier-reports-export', 'reports.view', 'allow', ?, ?)
         ON CONFLICT(user_id, permission_id) DO UPDATE SET effect = 'allow', updated_at = excluded.updated_at`,
      ).run(owner.userId, shiftSaleAt);
      const cashierAuth = { Authorization: `Bearer ${cashier.token}` };

      const cashierCrossShift = await http
        .get(
          `/api/reports/x-report/export?date=${shiftExportDate}&format=csv&session_id=${shift2Id}`,
        )
        .set(cashierAuth);
      assert.equal(
        cashierCrossShift.status,
        403,
        'cashier with reports.view cannot export another staff shift',
      );
      assert.equal(cashierCrossShift.body.code, 'shift_access_forbidden');

      const shift1Csv = await http
        .get(
          `/api/reports/x-report/export?date=${shiftExportDate}&format=csv&session_id=${shift1Id}`,
        )
        .set(cashierAuth);
      assert.equal(shift1Csv.status, 200, 'cashier exports own shift X report CSV');
      assert.ok(
        shift1Csv.headers['content-disposition'].includes(
          `filename="x-report-${shiftExportDate}-shift-${shift1Id}.csv"`,
        ),
        'shift CSV filename includes shift identity',
      );
      assert.ok(
        shift1Csv.text.includes(`summary,Shift,,,,Shift #${shift1Id} - Cashier User\n`),
        'shift CSV includes Shift summary row',
      );
      assert.ok(shift1Csv.text.includes('summary,Gross Sales,,,,220\n'));
      assert.ok(shift1Csv.text.includes('summary,Expected Cash in Drawer,,,,345\n'));
      assert.ok(shift1Csv.text.includes('summary,Opening Float,,,,100\n'));
      assert.ok(shift1Csv.text.includes('summary,Pay-in Total,,,,25\n'));
      assert.ok(!shift1Csv.text.includes('summary,Gross Sales,,,,385\n'));

      db.prepare(
        `DELETE FROM user_permission_overrides WHERE user_id = 'cashier-reports-export' AND permission_id = 'reports.view'`,
      ).run();

      const shift1Xlsx = await http
        .get(
          `/api/reports/x-report/export?date=${shiftExportDate}&format=xlsx&session_id=${shift1Id}`,
        )
        .set(auth)
        .buffer(true)
        .parse(parseBuffer);
      assert.equal(shift1Xlsx.status, 200, 'owner exports Shift 1 XLSX');
      assert.ok(
        shift1Xlsx.headers['content-disposition'].includes(
          `filename="x-report-${shiftExportDate}-shift-${shift1Id}.xlsx"`,
        ),
        'shift XLSX filename includes shift identity',
      );
      const shift1Wb = new ExcelJS.Workbook();
      await shift1Wb.xlsx.load(shift1Xlsx.body);
      const shift1Metrics = new Map<string, unknown>();
      shift1Wb.getWorksheet('Summary').eachRow((row: any, rowNumber: number) => {
        if (rowNumber > 1) shift1Metrics.set(String(row.getCell(1).value), row.getCell(2).value);
      });
      assert.equal(shift1Metrics.get('Shift'), `Shift #${shift1Id} - Cashier User`);
      assert.equal(shift1Metrics.get('Gross Sales'), 220);
      assert.equal(shift1Metrics.get('Expected Cash in Drawer'), 345);
      assert.equal(shift1Metrics.get('Opening Float'), 100);
      assert.equal(shift1Metrics.get('Pay-in Total'), 25);
      assert.equal(shift1Metrics.get('Bill Count'), 2);

      const shift1Html = await http
        .get(
          `/api/reports/x-report/export?date=${shiftExportDate}&format=html&session_id=${shift1Id}`,
        )
        .set(auth);
      assert.equal(shift1Html.status, 200, 'owner exports Shift 1 HTML');
      assert.ok(
        shift1Html.headers['content-disposition'].includes(
          `filename="x-report-${shiftExportDate}-shift-${shift1Id}.html"`,
        ),
        'shift HTML filename includes shift identity',
      );
      const shiftLabel = `Shift #${shift1Id} - Cashier User`;
      assert.ok(
        shift1Html.text.includes(`X Report (${shiftLabel}) - ${shiftExportDate}`),
        'shift HTML title displays shift identity',
      );
      assert.ok(
        shift1Html.text.includes(`Shift: <strong>${shiftLabel}</strong>`),
        'shift HTML meta header displays shift identity',
      );
      assert.ok(
        shift1Html.text.includes(
          'data-section="tax" data-title="VAT &lt;Standard&gt;" data-rate="10" data-amount="20"',
        ),
        'shift HTML tax breakdown displays proportional Shift 1 tax (15 + 5 = 20, not 35)',
      );
      const shift1HtmlMetrics = parseHtmlSummaryMetrics(shift1Html.text);
      for (const [metric, xlsxVal] of shift1Metrics.entries()) {
        if (metric === 'Period End') {
          const htmlEnd = new Date(shift1HtmlMetrics.get(metric) || '').getTime();
          const xlsxEnd = new Date(String(xlsxVal || '')).getTime();
          if (Number.isFinite(htmlEnd) && Number.isFinite(xlsxEnd)) {
            assert.ok(
              Math.abs(htmlEnd - xlsxEnd) <= 5000,
              `shift HTML metric Period End within 5s of shift XLSX (${shift1HtmlMetrics.get(metric)} vs ${xlsxVal})`,
            );
            continue;
          }
        }
        assert.equal(
          shift1HtmlMetrics.get(metric),
          xlsxVal === null || xlsxVal === undefined ? '' : String(xlsxVal),
          `shift HTML metric ${metric} matches shift XLSX`,
        );
      }

      // Unscoped whole-day export on the same date preserves whole-day figures and filename
      const unscopedDay4Csv = await http
        .get(`/api/reports/x-report/export?date=${shiftExportDate}&format=csv`)
        .set(auth);
      assert.equal(unscopedDay4Csv.status, 200);
      assert.ok(
        unscopedDay4Csv.headers['content-disposition'].includes(
          `filename="x-report-${shiftExportDate}.csv"`,
        ),
      );
      assert.ok(!unscopedDay4Csv.text.includes('summary,Shift,'));
      assert.ok(unscopedDay4Csv.text.includes('summary,Gross Sales,,,,385\n'));

      // Render Shift 1 HTML to PDF via save-html-as-pdf IPC
      const shift1PdfPath = path.join(testDir, `x-report-${shiftExportDate}-shift-${shift1Id}.pdf`);
      saveDialogResult = { canceled: false, filePath: shift1PdfPath };
      const shift1PdfSave = await saveHtmlAsPdfIpc!(trustedSender, {
        html: shift1Html.text,
        defaultFileName: `x-report-${shiftExportDate}-shift-${shift1Id}.pdf`,
        pageSize: 'A4',
      });
      assert.deepEqual(shift1PdfSave, { success: true, path: shift1PdfPath });
      const shift1PdfBuffer = fs.readFileSync(shift1PdfPath);
      if (isRealElectronRuntime) {
        const shift1PdfInfo = extractPdfInfo(shift1PdfBuffer);
        assert.ok(
          pdfTextIncludesToken(shift1PdfInfo, `X Report (${shiftLabel}) - ${shiftExportDate}`),
          'real Shift 1 PDF renders shift-scoped title',
        );
        assert.ok(
          pdfTextIncludesToken(shift1PdfInfo, '₹220.00'),
          'real Shift 1 PDF renders Shift 1 gross sales',
        );
        const shift1Layout = await verifyHtmlLayout(shift1Html.text, 'portrait', 'x-report-shift');
        assert.ok(
          shift1Layout.scrollWidth <= shift1Layout.clientWidth &&
            shift1Layout.overflowingCells === 0,
          `Shift 1 X report PDF layout has no horizontal clipping or overflow (${JSON.stringify(shift1Layout)})`,
        );
      } else {
        // Direct frontend useCashClose hook verification (selectedSessionId null vs selected)
        const hookStates: unknown[] = [];
        let hookStateCursor = 0;
        const capturedApiGets: Array<{ url: string; params: Record<string, unknown> }> = [];
        const capturedDownloads: Array<{ filename: string; text: string }> = [];
        const pendingDownloadReads: Array<Promise<void>> = [];
        const capturedPdfExports: Array<{
          endpoint: string;
          params?: Record<string, unknown>;
          filename: string;
        }> = [];

        class StubPopupBlockedError extends Error {}
        const priorLoad = Module._load;
        Module._load = function (reqName: string, parentMod: unknown, isMainMod: boolean) {
          if (reqName === 'react') {
            return {
              useState: <T>(initial: T) => {
                const idx = hookStateCursor++;
                if (!(idx in hookStates)) {
                  hookStates[idx] =
                    typeof initial === 'function' ? (initial as () => T)() : initial;
                }
                const setter = (next: T | ((prev: T) => T)) => {
                  hookStates[idx] =
                    typeof next === 'function'
                      ? (next as (prev: T) => T)(hookStates[idx] as T)
                      : next;
                };
                return [hookStates[idx] as T, setter] as const;
              },
              useEffect: () => undefined,
              useCallback: <T extends (...args: any[]) => any>(fn: T) => fn,
            };
          }
          if (reqName === '@/store/auth') {
            return {
              useAuthStore: () => ({
                currentTenant: {
                  currency: 'INR',
                  timezone: 'UTC',
                  business_day_start_time: '00:00',
                  country: 'IN',
                  permission_ids: [],
                },
              }),
            };
          }
          if (reqName === '@/lib/api') {
            return {
              __esModule: true,
              default: {
                get: async (url: string, config?: { params?: Record<string, unknown> }) => {
                  const params = config?.params ?? {};
                  capturedApiGets.push({ url, params });
                  const qs = new URLSearchParams();
                  for (const [k, v] of Object.entries(params)) {
                    if (v !== undefined && v !== null) qs.set(k, String(v));
                  }
                  const apiRes = await http
                    .get(`/api${url}?${qs.toString()}`)
                    .set(auth)
                    .buffer(true)
                    .parse(parseBuffer);
                  assert.equal(apiRes.status, 200, `useCashClose api.get ${url} succeeds`);
                  return { data: new Blob([apiRes.body]) };
                },
                post: async () => ({ data: {} }),
              },
            };
          }
          if (reqName === 'use-intl') {
            return {
              useLocale: () => 'en',
              useTranslations: () => (key: string) => key,
            };
          }
          if (reqName === 'react-hot-toast') {
            return {
              __esModule: true,
              default: {
                success: () => undefined,
                error: (msg: string) => {
                  throw new Error(`Unexpected toast.error in useCashClose: ${msg}`);
                },
              },
            };
          }
          if (reqName === '@/hooks/useFormatCurrency') {
            return { useFormatCurrency: () => (n: number) => String(n) };
          }
          if (reqName === '@/hooks/useCurrencyUnitAdapter') {
            return {
              useCurrencyUnitAdapter: () => ({
                toDisplay: (n: number) => n,
                fromDisplay: (n: number) => n,
                maxDecimals: 2,
              }),
            };
          }
          if (reqName === '@/lib/countries') {
            return { getCurrencyMinorUnitFactor: () => 100 };
          }
          if (reqName === '@/lib/printer/PrinterService') {
            return { printerService: { printZReport: async () => undefined } };
          }
          if (reqName === '@/lib/money') {
            return { displayAmountToCents: (v: string) => Math.round(Number(v || 0) * 100) };
          }
          if (reqName === '@shared/business-date') {
            return { businessDateForInstant: () => shiftExportDate };
          }
          if (reqName === '@/lib/download') {
            return {
              downloadBlob: (blob: Blob, filename: string) => {
                const entry = { filename, text: '' };
                capturedDownloads.push(entry);
                pendingDownloadReads.push(
                  blob.text().then((t) => {
                    entry.text = t;
                  }),
                );
              },
            };
          }
          if (reqName === '@/lib/export-pdf') {
            return {
              MenuPopupBlockedError: StubPopupBlockedError,
              exportReportAsPdf: async (opts: {
                endpoint: string;
                params?: Record<string, unknown>;
                filename: string;
              }) => {
                capturedPdfExports.push(opts);
              },
            };
          }
          if (reqName === '@/lib/whatsapp-share') {
            return { shareCashCloseViaWhatsApp: async () => ({ mode: 'sent' }) };
          }
          return priorLoad.call(this, reqName, parentMod, isMainMod);
        };

        try {
          const hookModulePath = require.resolve('../frontend/src/hooks/useCashClose');
          delete require.cache[hookModulePath];
          const { useCashClose } = require('../frontend/src/hooks/useCashClose') as {
            useCashClose: () => {
              businessDate: string;
              selectedSessionId: number | null;
              setSelectedSessionId: (id: number | null) => void;
              exportReport: (report: 'x' | 'z', format: 'csv' | 'xlsx' | 'pdf') => Promise<void>;
            };
          };
          const renderUseCashClose = () => {
            hookStateCursor = 0;
            return useCashClose();
          };

          // 1) All shifts (selectedSessionId === null) -> whole-day params & filename
          let model = renderUseCashClose();
          assert.equal(model.selectedSessionId, null);
          await model.exportReport('x', 'csv');
          await model.exportReport('x', 'xlsx');
          await model.exportReport('x', 'pdf');
          await Promise.all(pendingDownloadReads.splice(0));

          assert.deepEqual(capturedApiGets[0], {
            url: '/reports/x-report/export',
            params: { date: shiftExportDate, format: 'csv' },
          });
          assert.deepEqual(capturedApiGets[1], {
            url: '/reports/x-report/export',
            params: { date: shiftExportDate, format: 'xlsx' },
          });
          assert.equal(capturedDownloads[0].filename, `x-report-${shiftExportDate}.csv`);
          assert.ok(capturedDownloads[0].text.includes('summary,Gross Sales,,,,385\n'));
          assert.equal(capturedDownloads[1].filename, `x-report-${shiftExportDate}.xlsx`);
          assert.deepEqual(capturedPdfExports[0], {
            endpoint: '/reports/x-report/export',
            params: { date: shiftExportDate },
            filename: `x-report-${shiftExportDate}.pdf`,
          });

          // 2) Specific staff shift selected -> passes session_id and shift-scoped filename across csv, xlsx, pdf
          model.setSelectedSessionId(shift1Id);
          model = renderUseCashClose();
          assert.equal(model.selectedSessionId, shift1Id);

          await model.exportReport('x', 'csv');
          await model.exportReport('x', 'xlsx');
          await model.exportReport('x', 'pdf');
          await Promise.all(pendingDownloadReads.splice(0));

          assert.deepEqual(capturedApiGets[2], {
            url: '/reports/x-report/export',
            params: { date: shiftExportDate, session_id: shift1Id, format: 'csv' },
          });
          assert.deepEqual(capturedApiGets[3], {
            url: '/reports/x-report/export',
            params: { date: shiftExportDate, session_id: shift1Id, format: 'xlsx' },
          });
          assert.equal(
            capturedDownloads[2].filename,
            `x-report-${shiftExportDate}-shift-${shift1Id}.csv`,
          );
          assert.ok(
            capturedDownloads[2].text.includes(
              `summary,Shift,,,,Shift #${shift1Id} - Cashier User\n`,
            ),
          );
          assert.ok(capturedDownloads[2].text.includes('summary,Gross Sales,,,,220\n'));
          assert.equal(
            capturedDownloads[3].filename,
            `x-report-${shiftExportDate}-shift-${shift1Id}.xlsx`,
          );
          assert.deepEqual(capturedPdfExports[1], {
            endpoint: '/reports/x-report/export',
            params: { date: shiftExportDate, session_id: shift1Id },
            filename: `x-report-${shiftExportDate}-shift-${shift1Id}.pdf`,
          });
        } finally {
          Module._load = priorLoad;
        }
      }
    }

    if (
      !isRealElectronRuntime &&
      typeof rawElectron === 'string' &&
      process.env.SKIP_REAL_ELECTRON_PDF !== '1'
    ) {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        server = null;
      }
      closeDatabase();

      const repoRoot = path.resolve(__dirname, '..');
      const bootstrapFile = path.join(testDir, 'run-real-electron-reports-export.cjs');
      fs.writeFileSync(
        bootstrapFile,
        `const path = require('node:path');
const repoRoot = ${JSON.stringify(repoRoot)};
require(path.join(repoRoot, 'node_modules/ts-node')).register({
  transpileOnly: true,
  project: path.join(repoRoot, 'tests/tsconfig.json'),
});
require(path.join(repoRoot, 'tests/reports-export.test.ts'));
`,
        'utf8',
      );
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv.ELECTRON_RUN_AS_NODE;
      const electronRun = spawnSync(rawElectron, ['--no-sandbox', bootstrapFile], {
        env: childEnv,
        stdio: 'inherit',
        timeout: 120_000,
      });
      assert.equal(
        electronRun.status,
        0,
        `real Electron printToPDF test run exited with status ${String(electronRun.status)}`,
      );
    }

    console.log('reports-export tests passed');
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run()
  .then(() => {
    if (isRealElectronRuntime) {
      rawElectron.app.exit(0);
    }
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
    if (isRealElectronRuntime) {
      rawElectron.app.exit(1);
    }
  });
