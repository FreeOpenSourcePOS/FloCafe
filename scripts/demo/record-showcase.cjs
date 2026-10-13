'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const jwt = require('jsonwebtoken');
const { chromium } = require('../../frontend/node_modules/@playwright/test');
const {
  injectCursor,
  smoothClick,
  smoothMove,
  smoothMoveTo,
  smoothDrag,
} = require('./cursor-overlay.cjs');
const { transcodeMedia } = require('./media-pipeline.cjs');

const JWT_SECRET = 'showcase-secret-key-123';
const DOCS_SHOWCASE_DIR = path.resolve(__dirname, '../../docs/assets/showcase');
const DEFAULT_WEBSITE_ROOT = path.resolve(__dirname, '../../../flopos.com-showcase');
const explicitWebsiteDir = process.env.WEBSITE_SHOWCASE_DIR || process.env.FLO_SHOWCASE_WEBSITE_DIR;
const WEBSITE_SHOWCASE_DIR = explicitWebsiteDir
  ? path.resolve(explicitWebsiteDir)
  : fs.existsSync(DEFAULT_WEBSITE_ROOT)
    ? path.join(DEFAULT_WEBSITE_ROOT, 'media/showcase')
    : null;
const RAW_VIDEO_DIR = path.join(require('os').tmpdir(), 'flo-showcase-raw');

fs.mkdirSync(DOCS_SHOWCASE_DIR, { recursive: true });
if (WEBSITE_SHOWCASE_DIR) {
  fs.mkdirSync(WEBSITE_SHOWCASE_DIR, { recursive: true });
}
fs.mkdirSync(RAW_VIDEO_DIR, { recursive: true });

function getAuthToken(role = 'manager', userId = 'user-manager') {
  return jwt.sign({ userId, email: `${role}@harborbean.local`, role }, JWT_SECRET, {
    expiresIn: '4h',
  });
}

async function setupPageAuth(page, token, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ tok }) => {
      localStorage.setItem('token', tok);
      localStorage.setItem('flocafe:server-app-token', tok);
      localStorage.setItem(
        'pos-settings',
        JSON.stringify({ state: { language: 'en', orders_layout: 'split' } }),
      );
    },
    { tok: token },
  );
  await page.goto(url, { waitUntil: 'networkidle' });
  await injectCursor(page);
  await page.waitForTimeout(600);
}

// ── SCENE 1: High-Speed Counter POS (pos-checkout) ───────────────────────────
async function recordPosCheckout(browser) {
  console.log('\n=== Recording Scene 1: pos-checkout ===');
  const sceneDir = path.join(RAW_VIDEO_DIR, 'pos-checkout');
  fs.rmSync(sceneDir, { recursive: true, force: true });
  fs.mkdirSync(sceneDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: sceneDir, size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  const token = getAuthToken('cashier', 'user-cashier');
  await setupPageAuth(page, token, 'http://127.0.0.1:3001/pos');

  // Wait for product catalog to render
  const croissant = page.getByRole('button', { name: /Almond Croissant/i });
  await croissant.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(600);

  // Click Almond Croissant
  await smoothClick(page, croissant, { moveDuration: 550, postClickWait: 500 });

  // Click Nitro Cold Brew
  const coldBrew = page.getByRole('button', { name: /Nitro Cold Brew/i });
  await smoothClick(page, coldBrew, { moveDuration: 550, postClickWait: 600 });

  // Click Place Order button in cart
  const placeOrderBtn = page.getByRole('button', { name: 'Place Order' });
  await placeOrderBtn.waitFor({ state: 'visible' });
  await smoothClick(page, placeOrderBtn, { moveDuration: 650, postClickWait: 800 });

  // In modal, click Cash tender
  const cashBtn = page.getByRole('button', { name: 'Cash', exact: true });
  await cashBtn.waitFor({ state: 'visible' });
  await smoothClick(page, cashBtn, { moveDuration: 500, postClickWait: 500 });

  // Click Confirm Payment button
  const confirmBtn = page.getByRole('button', { name: /Confirm Payment/i });
  await confirmBtn.waitFor({ state: 'visible' });
  await smoothClick(page, confirmBtn, { moveDuration: 600, postClickWait: 1000 });

  // Assert payment success toast appears
  await page.waitForSelector('text=/Order #.* paid/i', { timeout: 8000 });

  // Assert no printer error or warning toast
  const warningToast = page.locator('text=/not printed|raster rendering failed/i');
  if (await warningToast.isVisible()) {
    throw new Error('Warning toast detected on checkout');
  }

  // Hold on success state
  await page.waitForTimeout(1600);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(
    rawVideo,
    'pos-checkout',
    DOCS_SHOWCASE_DIR,
    WEBSITE_SHOWCASE_DIR,
    '00:00:01.400',
  );
}

// ── SCENE 2: Custom Modifiers & Add-ons (addon-modifiers) ────────────────────
async function recordAddonModifiers(browser) {
  console.log('\n=== Recording Scene 2: addon-modifiers ===');
  const sceneDir = path.join(RAW_VIDEO_DIR, 'addon-modifiers');
  fs.rmSync(sceneDir, { recursive: true, force: true });
  fs.mkdirSync(sceneDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: sceneDir, size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  const token = getAuthToken('cashier', 'user-cashier');
  await setupPageAuth(page, token, 'http://127.0.0.1:3001/pos');

  // Wait for product catalog to render
  const latte = page.getByRole('button', { name: /Vanilla Bean Latte/i });
  await latte.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(600);

  // Click Vanilla Bean Latte (opens addon modal)
  await smoothClick(page, latte, { moveDuration: 600, postClickWait: 800 });

  // Select Oat Milk
  const oatMilkRow = page.locator('div:has(> div > span:text-is("Oat Milk"))').last();
  await oatMilkRow.waitFor({ state: 'visible', timeout: 5000 });
  const oatMilkBtn = oatMilkRow.locator('button').last();
  await smoothClick(page, oatMilkBtn, { moveDuration: 500, postClickWait: 500 });

  // Select Single Extra Shot
  const extraShotRow = page.locator('div:has(> div > span:text-is("Single Extra Shot"))').last();
  await extraShotRow.waitFor({ state: 'visible', timeout: 5000 });
  const extraShotBtn = extraShotRow.locator('button').last();
  await smoothClick(page, extraShotBtn, { moveDuration: 500, postClickWait: 600 });

  // Click Add to Cart / Add to Order
  const addOrderBtn = page.getByRole('button', { name: /Add to (Cart|Order)/i });
  await addOrderBtn.waitFor({ state: 'visible' });
  await smoothClick(page, addOrderBtn, { moveDuration: 600, postClickWait: 800 });

  // Assert cart has Vanilla Bean Latte with Oat Milk
  await page.waitForSelector('text=Oat Milk', { timeout: 5000 });

  // Pause on cart showing configured latte with badges
  await page.waitForTimeout(1800);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(
    rawVideo,
    'addon-modifiers',
    DOCS_SHOWCASE_DIR,
    WEBSITE_SHOWCASE_DIR,
    '00:00:02.000',
  );
}

// ── SCENE 3: Real-Time Kitchen Display System (kds-kanban) ───────────────────
async function recordKdsKanban(browser) {
  console.log('\n=== Recording Scene 3: kds-kanban ===');
  const sceneDir = path.join(RAW_VIDEO_DIR, 'kds-kanban');
  fs.rmSync(sceneDir, { recursive: true, force: true });
  fs.mkdirSync(sceneDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: sceneDir, size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  const token = getAuthToken('chef', 'user-chef');
  await setupPageAuth(page, token, 'http://127.0.0.1:3002/kds-standalone');

  // Switch to Kanban view
  const kanbanBtn = page.getByRole('button', { name: 'Kanban', exact: true });
  await kanbanBtn.waitFor({ state: 'visible', timeout: 10000 });
  await smoothClick(page, kanbanBtn, { moveDuration: 400, postClickWait: 500 });

  // Wait for board columns to be ready
  const pendingCol = page.locator('div:has(> div > span:text-is("Waiting"))').last();
  const prepCol = page.locator('div:has(> div > span:text-is("Preparing"))').last();
  const readyCol = page.locator('div:has(> div > span:text-is("Ready"))').last();
  await pendingCol.waitFor({ state: 'visible', timeout: 10000 });

  // Locate the draggable order card in Waiting (drag from header area)
  const orderCardHeader = pendingCol.locator('.cursor-grab .font-bold').first();
  await orderCardHeader.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(600);

  // Drag from Waiting to Preparing column
  const prepTarget = prepCol.locator('> div:nth-child(2)');
  await smoothDrag(page, orderCardHeader, prepTarget, { durationMs: 750 });
  await page.waitForTimeout(800);

  // Card is now in Preparing column. Drag to Ready column
  const prepCardHeader = prepCol.locator('.cursor-grab .font-bold').first();
  await prepCardHeader.waitFor({ state: 'visible', timeout: 5000 });
  const readyTarget = readyCol.locator('> div:nth-child(2)');
  await smoothDrag(page, prepCardHeader, readyTarget, { durationMs: 750 });
  await page.waitForTimeout(800);

  // Assert card is now in Ready column
  await readyCol.locator('.cursor-grab').first().waitFor({ state: 'visible', timeout: 5000 });

  // Hold on updated board
  await page.waitForTimeout(1800);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(
    rawVideo,
    'kds-kanban',
    DOCS_SHOWCASE_DIR,
    WEBSITE_SHOWCASE_DIR,
    '00:00:02.000',
  );
}

// ── SCENE 4: Visual Tables & Dine-in Floor Plan (floorplan-tables) ───────────
async function recordFloorplanTables(browser) {
  console.log('\n=== Recording Scene 4: floorplan-tables ===');
  const sceneDir = path.join(RAW_VIDEO_DIR, 'floorplan-tables');
  fs.rmSync(sceneDir, { recursive: true, force: true });
  fs.mkdirSync(sceneDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: sceneDir, size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  const token = getAuthToken('manager', 'user-manager');
  await setupPageAuth(page, token, 'http://127.0.0.1:3001/tables');

  // Ensure Floor plan view
  const floorTab = page.getByRole('button', { name: 'Floor plan' });
  await floorTab.waitFor({ state: 'visible', timeout: 10000 });
  await smoothClick(page, floorTab, { moveDuration: 500, postClickWait: 800 });

  // Wait for canvas
  const canvas = page.getByTestId('floorplan-canvas');
  await canvas.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(600);

  // Verify Main Dining tables (T1, T2, T3) are rendered
  await canvas.locator('text=T1').waitFor({ state: 'visible', timeout: 5000 });
  await canvas.locator('text=T2').waitFor({ state: 'visible', timeout: 5000 });
  await canvas.locator('text=T3').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);

  // Switch to Patio tab (T4)
  const floorTabs = page.getByTestId('floorplan-floor-tabs');
  const patioTab = floorTabs.getByRole('button', { name: /Patio/i });
  await patioTab.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, patioTab, { moveDuration: 500, postClickWait: 700 });
  await canvas.locator('text=T4').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(600);

  // Switch back to Main Dining
  const diningTab = floorTabs.getByRole('button', { name: /Main Dining/i });
  await diningTab.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, diningTab, { moveDuration: 500, postClickWait: 700 });
  await canvas.locator('text=T2').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);

  // Click occupied Table T2
  const t2Table = canvas.locator('text=T2').first();
  await t2Table.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, t2Table, { moveDuration: 600, postClickWait: 800 });

  // Bottom action sheet pops up showing seated details and actions
  const actionSheet = page.locator('[role="dialog"][aria-label="T2"]');
  await actionSheet.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(1200);

  // Click backdrop outside dialog to return cleanly to floor plan
  await page.mouse.click(200, 150);
  await actionSheet.waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForTimeout(1400);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(
    rawVideo,
    'floorplan-tables',
    DOCS_SHOWCASE_DIR,
    WEBSITE_SHOWCASE_DIR,
    '00:00:01.800',
  );
}

// ── SCENE 5: Handheld Waiter App (server-app) ────────────────────────────────
async function recordServerApp(browser) {
  console.log('\n=== Recording Scene 5: server-app ===');
  const sceneDir = path.join(RAW_VIDEO_DIR, 'server-app');
  fs.rmSync(sceneDir, { recursive: true, force: true });
  fs.mkdirSync(sceneDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true,
    recordVideo: { dir: sceneDir, size: { width: 390, height: 780 } },
  });

  const page = await context.newPage();
  const token = getAuthToken('server', 'user-server');
  await setupPageAuth(page, token, 'http://127.0.0.1:3003/server-standalone');

  // Select Table T1
  const t1Btn = page.getByRole('button', { name: /T1/i }).first();
  await t1Btn.waitFor({ state: 'visible', timeout: 10000 });
  await smoothClick(page, t1Btn, { moveDuration: 500, postClickWait: 600 });

  // Wait for product images to load
  const coldBrewImg = page.locator('img[alt="Nitro Cold Brew"]');
  await coldBrewImg.waitFor({ state: 'visible', timeout: 8000 });
  const sconeImg = page.locator('img[alt="Blueberry Scone"]');
  await sconeImg.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);

  // Tap Cold Brew
  const coldBrew = page.getByText('Nitro Cold Brew').first();
  await smoothClick(page, coldBrew, { moveDuration: 500, postClickWait: 500 });

  // Tap Scone
  const scone = page.getByText('Blueberry Scone').first();
  await smoothClick(page, scone, { moveDuration: 500, postClickWait: 500 });

  // Open cart drawer on mobile
  const cartTrigger = page
    .locator('button[aria-label="Current ticket"], button:has(svg.lucide-shopping-cart)')
    .first();
  await cartTrigger.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, cartTrigger, { moveDuration: 500, postClickWait: 600 });

  // Add notes and send (filter visible element in mobile drawer)
  const noteInput = page
    .getByPlaceholder('Order notes (optional)')
    .filter({ visible: true })
    .first();
  await noteInput.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, noteInput, { moveDuration: 400 });
  await noteInput.fill('Table 1 - extra cold');
  await page.waitForTimeout(300);

  const sendBtn = page
    .getByRole('button', { name: /Send to kitchen|Place Order/i })
    .filter({ visible: true })
    .first();
  await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, sendBtn, { moveDuration: 500, postClickWait: 1200 });

  // Assert order sent toast appears
  await page.waitForSelector('text=Order sent', { timeout: 8000 });

  await page.waitForTimeout(1600);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(
    rawVideo,
    'server-app',
    DOCS_SHOWCASE_DIR,
    WEBSITE_SHOWCASE_DIR,
    '00:00:01.800',
  );
}

// ── SCENE 6: Equal Shares Multi-Tender Checkout (split-payments) ─────────────
async function recordSplitPayments(browser) {
  console.log('\n=== Recording Scene 6: split-payments ===');
  const sceneDir = path.join(RAW_VIDEO_DIR, 'split-payments');
  fs.rmSync(sceneDir, { recursive: true, force: true });
  fs.mkdirSync(sceneDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: sceneDir, size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
  page.on('request', (req) => {
    if (req.url().includes('/api/')) console.log('REQ:', req.method(), req.url());
  });
  page.on('response', async (res) => {
    if (res.url().includes('/api/')) {
      console.log('RES:', res.status(), res.url());
      if (res.status() >= 400) {
        try {
          console.log('RES BODY:', await res.text());
        } catch (e) {}
      }
    }
  });
  const token = getAuthToken('manager', 'user-manager');
  await setupPageAuth(page, token, 'http://127.0.0.1:3001/orders');

  // Click on active Table T2 order
  const orderRow = page.locator('text=T2').first();
  await orderRow.waitFor({ state: 'visible', timeout: 10000 });
  await smoothClick(page, orderRow, { moveDuration: 500, postClickWait: 600 });

  // Click "Checkout" / "Take Payment"
  const checkoutBtn = page.getByRole('button', { name: /Checkout|Take Payment/i }).first();
  await checkoutBtn.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, checkoutBtn, { moveDuration: 600, postClickWait: 800 });

  // In payment modal, click "Split payment equally"
  const splitToggle = page.getByRole('button', { name: 'Split payment equally' });
  await splitToggle.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, splitToggle, { moveDuration: 600, postClickWait: 600 });

  // Change payers to 2
  const payerInput = page.getByLabel('Remaining payers');
  await payerInput.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, payerInput, { moveDuration: 400 });
  await payerInput.fill('2');
  await page.waitForTimeout(400);

  // Click "Apply to Cash"
  const applyCash = page.getByRole('button', { name: 'Apply to Cash' });
  await applyCash.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, applyCash, { moveDuration: 500, postClickWait: 600 });

  // Click Pay button for share 1
  const payBtn = page.getByRole('button', { name: /^Pay \$/i });
  await payBtn.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, payBtn, { moveDuration: 500, postClickWait: 800 });

  // Partial payment confirmation dialog opens: click "Pay" to confirm
  const confirmPayBtn = page.locator('div[role="dialog"] button:has-text("Pay")').last();
  await confirmPayBtn.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, confirmPayBtn, { moveDuration: 500, postClickWait: 800 });

  // Assert partial payment recorded toast appears
  await page.waitForSelector('text=Payment recorded', { timeout: 5000 });
  await page.waitForTimeout(600);

  // For the final share, allocate remaining balance to Cash tender
  const cashTenderBtn = page.locator('button[title="Cash"]').first();
  await cashTenderBtn.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, cashTenderBtn, { moveDuration: 500, postClickWait: 600 });

  // Click Pay for the final share
  await smoothClick(page, payBtn, { moveDuration: 500, postClickWait: 800 });

  // Now bill is fully paid! Click Done button
  const doneBtn = page.getByRole('button', { name: 'Done' });
  await doneBtn.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, doneBtn, { moveDuration: 500, postClickWait: 800 });

  // Switch to "All" tab in order list so completed order is visible
  const allTab = page.getByRole('button', { name: 'All', exact: true });
  await allTab.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, allTab, { moveDuration: 500, postClickWait: 600 });

  // Click completed order row to view final order check with "Paid" badge
  const completedOrder = page.locator('li button:has-text("T2")').first();
  await completedOrder.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, completedOrder, { moveDuration: 500, postClickWait: 600 });

  // Assert order ticket details with Paid badge
  await page.waitForSelector('text=Paid', { timeout: 5000 });
  await page.waitForTimeout(1600);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(
    rawVideo,
    'split-payments',
    DOCS_SHOWCASE_DIR,
    WEBSITE_SHOWCASE_DIR,
    '00:00:02.500',
  );
}

// ── SCENE 7: Live Recipe & Stock Depletion (recipe-inventory) ────────────────
async function recordRecipeInventory(browser) {
  console.log('\n=== Recording Scene 7: recipe-inventory ===');
  const sceneDir = path.join(RAW_VIDEO_DIR, 'recipe-inventory');
  fs.rmSync(sceneDir, { recursive: true, force: true });
  fs.mkdirSync(sceneDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: sceneDir, size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  const token = getAuthToken('manager', 'user-manager');
  await setupPageAuth(page, token, 'http://127.0.0.1:3001/inventory');

  // Ensure Supplies tab is open
  const suppliesTab = page.getByRole('tab', { name: /Supplies/i });
  await suppliesTab.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(600);

  // Click Record Movement on Espresso Beans row
  const recordMovementBtn = page
    .locator('tr:has-text("Espresso Beans")')
    .getByTitle(/Record Movement/i)
    .first();
  await recordMovementBtn.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, recordMovementBtn, { moveDuration: 500, postClickWait: 600 });

  // In modal, enter quantity 2.5 and reason
  const qtyInput = page.locator('form input[type="number"]');
  await qtyInput.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, qtyInput, { moveDuration: 400 });
  await qtyInput.fill('2.5');

  const reasonInput = page.locator('form input[type="text"]');
  await smoothClick(page, reasonInput, { moveDuration: 400 });
  await reasonInput.fill('Weekly delivery - Artisan Roasters');
  await page.waitForTimeout(300);

  // Click Save
  const saveBtn = page.locator('form button[type="submit"]');
  await smoothClick(page, saveBtn, { moveDuration: 500, postClickWait: 800 });

  // Switch to Stock Movements tab
  const movementsTab = page.getByRole('tab', { name: /Stock Movements|Movements/i });
  await movementsTab.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, movementsTab, { moveDuration: 600, postClickWait: 1000 });

  // Assert newly added movement is visible at top of movements table
  await page.waitForSelector('text=Weekly delivery - Artisan Roasters', { timeout: 5000 });

  // Hold on movements list showing both receipt and recipe depletion
  await page.waitForTimeout(2000);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(
    rawVideo,
    'recipe-inventory',
    DOCS_SHOWCASE_DIR,
    WEBSITE_SHOWCASE_DIR,
    '00:00:01.200',
  );
}

// ── SCENE 8: Thermal Receipt & KOT Printing (thermal-printing) ───────────────
async function recordThermalPrinting(browser) {
  console.log('\n=== Recording Scene 8: thermal-printing ===');
  const sceneDir = path.join(RAW_VIDEO_DIR, 'thermal-printing');
  fs.rmSync(sceneDir, { recursive: true, force: true });
  fs.mkdirSync(sceneDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: sceneDir, size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  const token = getAuthToken('owner', 'user-owner');
  await setupPageAuth(page, token, 'http://127.0.0.1:3001/print-test');

  // Select 80mm paper width
  const paper80 = page.getByRole('button', { name: /80mm/i }).first();
  await paper80.waitFor({ state: 'visible', timeout: 10000 });
  await smoothClick(page, paper80, { moveDuration: 500, postClickWait: 500 });

  // Select KOT Kitchen Ticket mode
  const kotMode = page.getByRole('button', { name: /KOT/i }).first();
  await kotMode.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, kotMode, { moveDuration: 500, postClickWait: 600 });

  // Switch to Basic Receipt (Thermal)
  const basicReceipt = page.getByRole('button', { name: /Basic Receipt/i }).first();
  await basicReceipt.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, basicReceipt, { moveDuration: 500, postClickWait: 600 });

  // Click Run Test Print
  const runTestBtn = page.getByRole('button', { name: /Run Test/i });
  await runTestBtn.waitFor({ state: 'visible', timeout: 5000 });
  await smoothClick(page, runTestBtn, { moveDuration: 500, postClickWait: 800 });

  // Assert genuine receipt print success toast appears
  await page.waitForSelector('text=Receipt printed', { timeout: 8000 });

  // Assert no warning or fallback toast
  const warningToast = page.locator('text=/No thermal printer|not printed|system print/i');
  if (await warningToast.isVisible()) {
    throw new Error('Warning or fallback toast detected on thermal printing');
  }

  // Scroll data preview into view
  const preview = page.getByText('Data Preview').first();
  await smoothMove(page, preview, 500);

  await page.waitForTimeout(1800);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(
    rawVideo,
    'thermal-printing',
    DOCS_SHOWCASE_DIR,
    WEBSITE_SHOWCASE_DIR,
    '00:00:01.800',
  );
}

// ── MASTER RUNNER ────────────────────────────────────────────────────────────
async function main() {
  console.log('Starting FloCafe Autonomous Media Recording Pipeline...');

  console.log('[Runner] Starting sandbox server...');
  const server = cp.spawn('node', [path.join(__dirname, 'showcase-server.cjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: '3001', KDS_PORT: '3002', SERVER_APP_PORT: '3003' },
  });

  let browser;
  const results = {};
  const requestedScene = process.argv.find((a) => a.startsWith('--scene='))?.split('=')[1];

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server start timeout')), 30000);
      server.stdout.on('data', (d) => {
        const msg = d.toString();
        process.stdout.write(msg);
        if (msg.includes('All services ready for capture')) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      server.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early: ${code}`));
      });
    });

    console.log('[Runner] Launching headless browser...');
    browser = await chromium.launch({
      headless: true,
    });

    if (!requestedScene || requestedScene === 'pos-checkout') {
      results['pos-checkout'] = await recordPosCheckout(browser);
    }
    if (!requestedScene || requestedScene === 'addon-modifiers') {
      results['addon-modifiers'] = await recordAddonModifiers(browser);
    }
    if (!requestedScene || requestedScene === 'kds-kanban') {
      results['kds-kanban'] = await recordKdsKanban(browser);
    }
    if (!requestedScene || requestedScene === 'floorplan-tables') {
      results['floorplan-tables'] = await recordFloorplanTables(browser);
    }
    if (!requestedScene || requestedScene === 'server-app') {
      results['server-app'] = await recordServerApp(browser);
    }
    if (!requestedScene || requestedScene === 'split-payments') {
      results['split-payments'] = await recordSplitPayments(browser);
    }
    if (!requestedScene || requestedScene === 'recipe-inventory') {
      results['recipe-inventory'] = await recordRecipeInventory(browser);
    }
    if (!requestedScene || requestedScene === 'thermal-printing') {
      results['thermal-printing'] = await recordThermalPrinting(browser);
    }

    console.log('\n=== RECORDING SUMMARY ===');
    console.table(
      Object.entries(results).map(([scene, stats]) => ({
        Scene: scene,
        'GIF Size (KB)': (stats.gifSize / 1024).toFixed(1),
        'MP4 Size (KB)': (stats.mp4Size / 1024).toFixed(1),
        'Poster Size (KB)': (stats.posterSize / 1024).toFixed(1),
      })),
    );
  } finally {
    console.log('[Runner] Cleaning up browser and server...');
    if (browser) {
      await browser.close();
    }
    server.kill('SIGINT');
  }
}

if (require.main === module) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Fatal recording error:', err);
      process.exit(1);
    });
}

module.exports = {
  recordPosCheckout,
  recordAddonModifiers,
  recordKdsKanban,
  recordFloorplanTables,
  recordServerApp,
  recordSplitPayments,
  recordRecipeInventory,
  recordThermalPrinting,
};
