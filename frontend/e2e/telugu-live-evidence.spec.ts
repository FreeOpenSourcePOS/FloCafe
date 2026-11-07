import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { formatDailySalesWhatsAppMessage } = require('../../dist/main/services/daily-sales-export');

const LOCAL_EVIDENCE_BASE = path.join(os.homedir(), '.no-mistakes', 'evidence');
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  (fs.existsSync(LOCAL_EVIDENCE_BASE)
    ? path.join(LOCAL_EVIDENCE_BASE, '01M6TWNVZRE2MT9WHN20Z3GYKA')
    : path.join(os.tmpdir(), 'flocafe-telugu-e2e-evidence'));

function ensureEvidenceDir() {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
}

test.describe('Live Telugu (te / te-IN) E2E verification across FloCafe surfaces', () => {
  test('1. Setup wizard offers Telugu (తెలుగు / TE), switches html lang="te-IN" dir="ltr", and renders localized steps', async ({
    page,
  }) => {
    ensureEvidenceDir();
    await page.route('**/api/auth/setup/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needsSetup: true, masterPinAvailable: true }),
      });
    });

    await page.goto(`${E2E_BASE_URL}/setup`);
    const teluguBtn = page.locator('button', { hasText: 'తెలుగు' }).first();
    await expect(teluguBtn).toBeVisible();
    await expect(teluguBtn).toContainText('TE');
    await teluguBtn.click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'te-IN');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByText('FloCafe కు స్వాగతం')).toBeVisible();

    await page.locator('.max-h-72 button').first().click();
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, '01-setup-wizard-telugu.png'),
      fullPage: true,
    });
  });

  test('2. Main POS, Settings, Print-Test, Server App, KDS Standalone, Customer Display, Web Print Receipts, and WhatsApp Reports in Telugu', async ({
    page,
    browser,
    request,
  }) => {
    ensureEvidenceDir();
    const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${ownerToken}` };

    const createdCategoryIds: string[] = [];
    const createdProductIds: string[] = [];
    const createdOrderIds: number[] = [];
    let customerDisplayTokenId: string | number | null = null;

    const initialBizSettingsRes = await request.get(`${E2E_BASE_URL}/api/settings/business`, {
      headers,
    });
    expect(initialBizSettingsRes.ok()).toBeTruthy();
    const initialBizSettings = (await initialBizSettingsRes.json()) as { language?: string };
    const initialLanguage =
      typeof initialBizSettings.language === 'string' && initialBizSettings.language
        ? initialBizSettings.language
        : 'en';

    try {
      // Seed Telugu sample catalog items on the live API to verify POS, Server App, and KDS rendering
      const catMainRes = await request.post(`${E2E_BASE_URL}/api/categories`, {
        headers,
        data: { name: 'ప్రధాన వంటకాలు', color: '#4ECDC4', icon: '🍛', sort_order: 10 },
      });
      expect(catMainRes.ok()).toBeTruthy();
      const catMain = (await catMainRes.json()).category;
      createdCategoryIds.push(catMain.id);

      const catStartersRes = await request.post(`${E2E_BASE_URL}/api/categories`, {
        headers,
        data: { name: 'స్టార్టర్లు', color: '#FF6B6B', icon: '🍟', sort_order: 11 },
      });
      expect(catStartersRes.ok()).toBeTruthy();
      const catStarters = (await catStartersRes.json()).category;
      createdCategoryIds.push(catStarters.id);

      const prodBiryaniRes = await request.post(`${E2E_BASE_URL}/api/products`, {
        headers,
        data: {
          category_id: catMain.id,
          name: 'హైదరాబాదీ బిర్యానీ',
          price: 320,
          tax_category_id: 'standard',
          tax_behavior: 'exclusive',
          track_inventory: false,
          is_active: true,
        },
      });
      expect(prodBiryaniRes.ok()).toBeTruthy();
      const prodBiryani = (await prodBiryaniRes.json()).product;
      createdProductIds.push(prodBiryani.id);

      const prodPunuguluRes = await request.post(`${E2E_BASE_URL}/api/products`, {
        headers,
        data: {
          category_id: catStarters.id,
          name: 'పునుగులు',
          price: 250,
          tax_category_id: 'standard',
          tax_behavior: 'exclusive',
          track_inventory: false,
          is_active: true,
        },
      });
      expect(prodPunuguluRes.ok()).toBeTruthy();
      const prodPunugulu = (await prodPunuguluRes.json()).product;
      createdProductIds.push(prodPunugulu.id);

      // Log into Main POS as owner and switch language to Telugu ('te')
      await page.goto(`${E2E_BASE_URL}/auth/login`);
      await page.locator('#email').fill('owner@flo.local');
      await page.locator('#password').fill(E2E_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL('**/pos/**', { timeout: 20000 });

      await setLanguage(page, 'te');
      await page.goto(`${E2E_BASE_URL}/pos`);
      await expect(page.locator('html')).toHaveAttribute('lang', 'te-IN');
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

      const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      expect(fontFamily).toContain('Noto Sans Telugu');

      await expect(page.getByText('హైదరాబాదీ బిర్యానీ').first()).toBeVisible();
      await expect(page.getByText('పునుగులు').first()).toBeVisible();
      await page.getByText('హైదరాబాదీ బిర్యానీ').first().click();
      await page.getByText('పునుగులు').first().click();

      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '02-pos-telugu-seed-catalog.png'),
        fullPage: true,
      });

      // Verify Settings and /print-test in Telugu, plus live Web Print HTML & KOT & WhatsApp receipt
      await page.evaluate(() => {
        const raw = localStorage.getItem('pos-settings');
        const parsed = raw ? JSON.parse(raw) : { state: {}, version: 3 };
        parsed.state = {
          ...parsed.state,
          language: 'te',
          kotPrintingEnabled: true,
        };
        localStorage.setItem('pos-settings', JSON.stringify(parsed));
      });
      await page.goto(`${E2E_BASE_URL}/print-test`);
      const basicBtn = page.getByRole('button', { name: 'ప్రాథమిక రసీదు (థర్మల్)', exact: true });
      const webPrintBtn = page.getByRole('button', { name: 'వెబ్ ప్రింట్ (బ్రౌజర్)', exact: true });
      const whatsappBtn = page.getByRole('button', { name: 'WhatsApp షేర్', exact: true });
      const kotBtn = page.getByRole('button', { name: 'KOT (కిచెన్ టికెట్)', exact: true });
      await expect(basicBtn).toBeVisible();
      await expect(webPrintBtn).toBeVisible();
      await expect(whatsappBtn).toBeVisible();
      await expect(kotBtn).toBeVisible();
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '03-settings-and-print-test-telugu.png'),
        fullPage: true,
      });

      // Download live Web Print receipt HTML from /print-test in Telugu
      await webPrintBtn.click();
      const downloadBtn = page.getByRole('button', { name: 'HTML డౌన్లోడ్ చేయి', exact: true });
      await expect(downloadBtn).toBeVisible();
      const [download] = await Promise.all([page.waitForEvent('download'), downloadBtn.click()]);
      const receiptHtmlPath = path.join(EVIDENCE_DIR, '07-web-print-receipt-telugu.html');
      await download.saveAs(receiptHtmlPath);
      const billHtml = fs.readFileSync(receiptHtmlPath, 'utf8');
      expect(billHtml).toContain('lang="te-IN"');
      expect(billHtml).toContain('మీ సందర్శనకు ధన్యవాదాలు!');

      // Capture live KOT browser print HTML from /print-test in Telugu
      await kotBtn.click();
      await page.getByRole('button', { name: 'బ్రౌజర్ ప్రింట్', exact: true }).click();
      await page.evaluate(() => {
        const win = window as unknown as { __capturedKotHtml?: string };
        win.__capturedKotHtml = '';
        window.open = (() => {
          const doc = document.implementation.createHTMLDocument('KOT Preview');
          return {
            document: doc,
            focus: () => {},
            print: () => {
              win.__capturedKotHtml = doc.documentElement.outerHTML;
            },
            close: () => {},
          } as unknown as Window;
        }) as typeof window.open;
      });
      await page.getByRole('button', { name: 'టెస్ట్ రన్ చేయి', exact: true }).click();
      await expect
        .poll(async () =>
          page.evaluate(
            () => (window as unknown as { __capturedKotHtml?: string }).__capturedKotHtml || '',
          ),
        )
        .toContain('వంటగది');
      const kotHtml: string = await page.evaluate(
        () => (window as unknown as { __capturedKotHtml?: string }).__capturedKotHtml || '',
      );

      // Render Web Print Receipt and KOT side-by-side in Chromium
      const printContext = await browser.newContext({ viewport: { width: 960, height: 900 } });
      const printPage = await printContext.newPage();
      await printPage.setContent(`
        <!DOCTYPE html>
        <html lang="te-IN" dir="ltr">
        <head><meta charset="utf-8"><title>Telugu Print Preview</title></head>
        <body style="display:flex;gap:24px;padding:20px;background:#f3f4f6;align-items:flex-start;">
          <div style="background:#fff;padding:12px;border:1px solid #d1d5db;width:360px;">${billHtml}</div>
          <div style="background:#fff;padding:12px;border:1px solid #d1d5db;width:340px;">${kotHtml}</div>
        </body>
        </html>
      `);
      await expect(printPage.getByText('మీ సందర్శనకు ధన్యవాదాలు!')).toBeVisible();
      await expect(printPage.getByText('వంటగది').first()).toBeVisible();
      await printPage.screenshot({
        path: path.join(EVIDENCE_DIR, '07-web-print-receipt-and-kot-telugu.png'),
        fullPage: true,
      });
      await printContext.close();

      // Verify Server App (:3003/server-standalone) in Telugu and send a tableside order
      const fixtureTableName = 'TE-1';
      const tablesListRes = await request.get(`${E2E_BASE_URL}/api/tables`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      expect(tablesListRes.ok()).toBeTruthy();
      const tablesListBody = (await tablesListRes.json()) as {
        tables?: Array<{ id: string | number; number: string; is_active?: number | boolean }>;
      };
      let table = (tablesListBody.tables || []).find(
        (t) => t.number === fixtureTableName && t.is_active !== 0 && t.is_active !== false,
      );
      if (!table) {
        const tableRes = await request.post(`${E2E_BASE_URL}/api/tables`, {
          headers: { Authorization: `Bearer ${managerToken}` },
          data: { number: fixtureTableName, capacity: 4 },
        });
        expect(tableRes.ok()).toBeTruthy();
        table = ((await tableRes.json()) as { table: { id: string | number; number: string } })
          .table;
      }
      const tableName = table.number;

      const serverContext = await browser.newContext();
      const serverPage = await serverContext.newPage();
      await serverPage.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
      await serverPage.evaluate(
        ([tok]) => {
          localStorage.setItem('flocafe:server-app-token', tok);
          localStorage.setItem(
            'pos-settings',
            JSON.stringify({ state: { language: 'te' }, version: 3 }),
          );
        },
        [serverToken],
      );
      await serverPage.reload();
      await expect(serverPage.locator('html')).toHaveAttribute('lang', 'te-IN');
      await serverPage.getByRole('button', { name: new RegExp(tableName) }).click();
      const grid = serverPage.getByTestId('pos-product-grid');
      await expect(grid.getByPlaceholder('మెనూ వెతుకు')).toBeVisible();
      await grid.getByText('హైదరాబాదీ బిర్యానీ').first().click();
      await grid.getByText('పునుగులు').first().click();
      await serverPage.screenshot({
        path: path.join(EVIDENCE_DIR, '05-server-app-telugu.png'),
        fullPage: true,
      });
      await serverPage.getByRole('button', { name: 'వంటగదికి పంపు' }).first().click();
      await expect(serverPage.getByText('ఆర్డర్ పంపబడింది').first()).toBeVisible();
      await serverContext.close();

      // Track the created dine-in order
      const ordersRes = await request.get(`${E2E_BASE_URL}/api/orders`, {
        headers,
        params: { table_id: table.id, type: 'dine_in', per_page: 5 },
      });
      const { orders } = await ordersRes.json();
      for (const o of orders ?? []) {
        createdOrderIds.push(o.id);
      }

      // Create one preparing and one ready takeaway order for KDS and Customer Display
      const prepOrderRes = await request.post(`${E2E_BASE_URL}/api/orders`, {
        headers,
        data: {
          type: 'takeaway',
          items: [{ product_id: prodBiryani.id, quantity: 1 }],
        },
      });
      expect(prepOrderRes.status()).toBe(201);
      const prepOrder = (await prepOrderRes.json()).order;
      createdOrderIds.push(prepOrder.id);
      await request.patch(`${E2E_BASE_URL}/api/orders/${prepOrder.id}/status`, {
        headers,
        data: { status: 'preparing' },
      });

      const readyOrderRes = await request.post(`${E2E_BASE_URL}/api/orders`, {
        headers,
        data: {
          type: 'takeaway',
          items: [{ product_id: prodPunugulu.id, quantity: 2 }],
        },
      });
      expect(readyOrderRes.status()).toBe(201);
      const readyOrder = (await readyOrderRes.json()).order;
      createdOrderIds.push(readyOrder.id);
      await request.patch(`${E2E_BASE_URL}/api/orders/${readyOrder.id}/status`, {
        headers,
        data: { status: 'ready' },
      });

      // Verify Standalone KDS (:3002/kds-standalone) in Telugu
      const kdsContext = await browser.newContext();
      const kdsPage = await kdsContext.newPage();
      await kdsPage.addInitScript(() => {
        localStorage.setItem(
          'pos-settings',
          JSON.stringify({ state: { language: 'te' }, version: 3 }),
        );
      });
      await kdsPage.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
      await expect(kdsPage.getByTestId('kds-login-form')).toBeVisible();
      await kdsPage.getByTestId('kds-login-email').fill('manager@flo.local');
      await kdsPage.getByTestId('kds-login-password').fill(E2E_PASSWORD);
      await kdsPage.getByTestId('kds-login-submit').click();
      await expect(kdsPage.getByTestId('kds-workspace')).toBeVisible();
      await expect(kdsPage.locator('html')).toHaveAttribute('lang', 'te-IN');
      await expect(kdsPage.getByText('హైదరాబాదీ బిర్యానీ').first()).toBeVisible();
      await kdsPage.screenshot({
        path: path.join(EVIDENCE_DIR, '04-kds-standalone-telugu.png'),
        fullPage: true,
      });
      await kdsContext.close();

      // Verify Customer Display (/customer-display) in Telugu
      const pairRes = await request.post(`${E2E_BASE_URL}/api/settings/customer-display/tokens`, {
        headers,
        data: { label: 'Telugu Lobby Display' },
      });
      expect(pairRes.ok()).toBeTruthy();
      const pairData = await pairRes.json();
      const rawToken = pairData.token?.raw_token || pairData.raw_token || pairData.token;
      customerDisplayTokenId = pairData.token?.id || pairData.id || null;

      const cdContext = await browser.newContext();
      const cdPage = await cdContext.newPage();
      await cdPage.addInitScript(() => {
        localStorage.setItem(
          'pos-settings',
          JSON.stringify({ state: { language: 'te' }, version: 3 }),
        );
      });
      if (typeof rawToken === 'string' && rawToken.startsWith('cdt_')) {
        await cdPage.goto(`${E2E_BASE_URL}/customer-display/#token=${rawToken}`);
      } else {
        await cdPage.addInitScript((tok) => {
          localStorage.setItem('token', tok);
        }, ownerToken);
        await cdPage.goto(`${E2E_BASE_URL}/customer-display/`);
      }
      await expect(cdPage.locator('html')).toHaveAttribute('lang', 'te-IN');
      await expect(cdPage.getByText('సిద్ధమవుతోంది').first()).toBeVisible({ timeout: 15000 });
      await expect(cdPage.getByText('పికప్ కోసం సిద్ధంగా ఉంది').first()).toBeVisible({
        timeout: 15000,
      });
      await cdPage.screenshot({
        path: path.join(EVIDENCE_DIR, '06-customer-display-telugu.png'),
        fullPage: true,
      });
      await cdContext.close();

      // Verify live Daily Sales & Daily Invoices exports and WhatsApp Daily Sales report in Telugu
      const setLangRes = await request.put(`${E2E_BASE_URL}/api/settings/language`, {
        headers,
        data: { value: 'te' },
      });
      expect(setLangRes.ok()).toBeTruthy();

      const waDailySalesBody: string = formatDailySalesWhatsAppMessage(
        {
          summary: {
            business_date: '2026-11-07',
            from_date: '2026-11-07',
            to_date: '2026-11-07',
            day_count: 1,
            timezone: 'Asia/Kolkata',
            business_day_start: '00:00',
            currency: 'INR',
            order_count: 2,
            paid_bill_count: 2,
            gross_collected: 598.5,
            refunds_issued: 0,
            net_collected: 598.5,
            tax_total: 28.5,
            discount_total: 0,
            service_charge_total: 0,
            packaging_charge_total: 0,
            delivery_charge_total: 0,
            known_cost_net_item_sales: 570,
            ingredient_cost_total: 200,
            gross_profit_total: 370,
            gross_margin_percent: 64.91,
            cost_coverage_status: 'known',
            payment_methods: [
              { method: 'cash', total: 350 },
              { method: 'card', total: 248.5 },
            ],
            tax_warning: '',
          },
          days: [],
          taxes: [],
          items: [
            {
              product_id: prodBiryani.id,
              product_name: 'హైదరాబాదీ బిర్యానీ',
              product_sku: 'TE-BIR-1',
              quantity: 1,
              gross_item_sales: 320,
              item_discounts: 0,
              net_item_sales: 320,
              tax_amount: 16,
              ingredient_cost: 120,
              profit: 200,
              margin_percent: 62.5,
              cost_status: 'known',
            },
            {
              product_id: prodPunugulu.id,
              product_name: 'పునుగులు',
              product_sku: 'TE-PUN-1',
              quantity: 1,
              gross_item_sales: 250,
              item_discounts: 0,
              net_item_sales: 250,
              tax_amount: 12.5,
              ingredient_cost: 80,
              profit: 170,
              margin_percent: 68,
              cost_status: 'known',
            },
          ],
          payment_lines: [],
        },
        {
          language: 'te',
          locale: 'te-IN',
          businessName: 'FloCafe హైదరాబాద్',
        },
      );
      expect(waDailySalesBody).toContain('రోజువారీ అమ్మకాల నివేదిక');
      expect(waDailySalesBody).toContain('అమ్మకాల సారాంశం');
      expect(waDailySalesBody).toContain('నికర వసూళ్లు');
      expect(waDailySalesBody).toContain('చెల్లింపు విధానాలు');
      expect(waDailySalesBody).toContain('అగ్ర ఉత్పత్తులు');
      expect(waDailySalesBody).toContain('హైదరాబాదీ బిర్యానీ');

      const dailySalesHtmlRes = await request.get(
        `${E2E_BASE_URL}/api/reports/daily-sales/export?format=html`,
        { headers },
      );
      expect(dailySalesHtmlRes.ok()).toBeTruthy();
      const dailySalesHtml = await dailySalesHtmlRes.text();
      expect(dailySalesHtml).toContain('Noto Sans Telugu');
      expect(dailySalesHtml).toContain('Kohinoor Telugu');

      const dailyInvoicesHtmlRes = await request.get(
        `${E2E_BASE_URL}/api/reports/daily-invoices/export?format=html`,
        { headers },
      );
      expect(dailyInvoicesHtmlRes.ok()).toBeTruthy();
      const dailyInvoicesHtml = await dailyInvoicesHtmlRes.text();
      expect(dailyInvoicesHtml).toContain('Noto Sans Telugu');

      fs.writeFileSync(
        path.join(EVIDENCE_DIR, '08-whatsapp-reports-telugu.txt'),
        waDailySalesBody,
        'utf8',
      );

      const waContext = await browser.newContext({ viewport: { width: 960, height: 800 } });
      const waPage = await waContext.newPage();
      await waPage.setContent(`
        <!DOCTYPE html>
        <html lang="te-IN" dir="ltr">
        <head><meta charset="utf-8"><title>Telugu WhatsApp & Daily Sales Reports</title></head>
        <body style="display:flex;gap:24px;padding:20px;background:#e5ddd5;font-family:'Noto Sans Telugu',sans-serif;align-items:flex-start;">
          <pre style="background:#dcf8c6;padding:16px;border-radius:12px;white-space:pre-wrap;width:380px;font-family:'Noto Sans Telugu',monospace;font-size:13px;">${waDailySalesBody}</pre>
          <div style="background:#ffffff;padding:16px;border-radius:12px;width:500px;overflow:auto;">${dailySalesHtml}</div>
        </body>
        </html>
      `);
      await expect(waPage.getByText('రోజువారీ అమ్మకాల నివేదిక').first()).toBeVisible();
      await expect(waPage.getByText('అమ్మకాల సారాంశం').first()).toBeVisible();
      await waPage.screenshot({
        path: path.join(EVIDENCE_DIR, '08-whatsapp-reports-telugu.png'),
        fullPage: true,
      });
      await waContext.close();
    } finally {
      if (customerDisplayTokenId !== null) {
        const revokeRes = await request.delete(
          `${E2E_BASE_URL}/api/settings/customer-display/tokens/${customerDisplayTokenId}`,
          { headers },
        );
        expect(revokeRes.ok()).toBeTruthy();
      }
      const restoreLangRes = await request.put(`${E2E_BASE_URL}/api/settings/language`, {
        headers,
        data: { value: initialLanguage },
      });
      expect(restoreLangRes.ok()).toBeTruthy();
      await setLanguage(page, initialLanguage as 'en').catch(() => {});
      if (createdOrderIds.length > 0) {
        const setPinRes = await request.put(`${E2E_BASE_URL}/api/staff/e2e-manager`, {
          headers,
          data: { pin: '1111' },
        });
        expect(setPinRes.ok()).toBeTruthy();
        try {
          for (const orderId of createdOrderIds) {
            const cancelRes = await request.patch(`${E2E_BASE_URL}/api/orders/${orderId}/status`, {
              headers,
              data: {
                status: 'cancelled',
                override_pin: '1111',
                approver_id: 'e2e-manager',
              },
            });
            expect(cancelRes.ok()).toBeTruthy();
          }
        } finally {
          const clearPinRes = await request.put(`${E2E_BASE_URL}/api/staff/e2e-manager`, {
            headers,
            data: { pin: null },
          });
          expect(clearPinRes.ok()).toBeTruthy();
        }
      }
      for (const prodId of createdProductIds) {
        const delProdRes = await request.delete(`${E2E_BASE_URL}/api/products/${prodId}`, {
          headers,
        });
        expect(delProdRes.ok()).toBeTruthy();
      }
      for (const catId of createdCategoryIds) {
        const delCatRes = await request.delete(`${E2E_BASE_URL}/api/categories/${catId}`, {
          headers,
        });
        expect(delCatRes.ok()).toBeTruthy();
      }
    }
  });
});
