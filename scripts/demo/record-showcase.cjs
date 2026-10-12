'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const jwt = require('jsonwebtoken');
const { chromium } = require('../../frontend/node_modules/@playwright/test');
const { injectCursor, smoothClick, smoothMove, smoothMoveTo } = require('./cursor-overlay.cjs');
const { transcodeMedia } = require('./media-pipeline.cjs');

const JWT_SECRET = 'showcase-secret-key-123';
const DOCS_SHOWCASE_DIR = path.resolve(__dirname, '../../docs/assets/showcase');
const WEBSITE_SHOWCASE_DIR = path.resolve(__dirname, '../../../flopos.com-showcase/media/showcase');
const RAW_VIDEO_DIR = path.join(require('os').tmpdir(), 'flo-showcase-raw');

fs.mkdirSync(DOCS_SHOWCASE_DIR, { recursive: true });
fs.mkdirSync(WEBSITE_SHOWCASE_DIR, { recursive: true });
fs.mkdirSync(RAW_VIDEO_DIR, { recursive: true });

function getAuthToken(role = 'manager', userId = 'user-manager') {
  return jwt.sign(
    { userId, email: `${role}@harborbean.local`, role },
    JWT_SECRET,
    { expiresIn: '4h' }
  );
}

async function setupPageAuth(page, token, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ tok }) => {
    localStorage.setItem('token', tok);
    localStorage.setItem('flocafe:server-app-token', tok);
    localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'en', orders_layout: 'split' } }));
  }, { tok: token });
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

  await page.waitForTimeout(800);

  // Click Almond Croissant button
  const croissant = page.getByRole('button', { name: /Almond Croissant/i });
  await smoothClick(page, croissant, { moveDuration: 600, postClickWait: 500 });

  // Click Nitro Cold Brew button
  const coldBrew = page.getByRole('button', { name: /Nitro Cold Brew/i });
  await smoothClick(page, coldBrew, { moveDuration: 600, postClickWait: 600 });

  // Click Place Order button in cart
  const placeOrderBtn = page.getByRole('button', { name: 'Place Order' });
  await smoothClick(page, placeOrderBtn, { moveDuration: 700, postClickWait: 800 });

  // In modal, click Cash tender
  const cashBtn = page.getByRole('button', { name: 'Cash', exact: true });
  await smoothClick(page, cashBtn, { moveDuration: 500, postClickWait: 500 });

  // Click Confirm Payment button
  const confirmBtn = page.getByRole('button', { name: /Confirm Payment/i });
  await smoothClick(page, confirmBtn, { moveDuration: 600, postClickWait: 1200 });

  // Hold on success state
  await page.waitForTimeout(1600);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(rawVideo, 'pos-checkout', DOCS_SHOWCASE_DIR, WEBSITE_SHOWCASE_DIR, '00:00:01.400');
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

  await page.waitForTimeout(800);

  // Click Vanilla Bean Latte (has addon groups)
  const latte = page.getByRole('button', { name: /Vanilla Bean Latte/i });
  await smoothClick(page, latte, { moveDuration: 600, postClickWait: 800 });

  // Addon modal is open. Select Oat Milk
  const oatMilkBtn = page.locator('span:text-is("Oat Milk")').locator('xpath=ancestor::div[1]/following-sibling::div//button').first();
  await smoothClick(page, oatMilkBtn, { moveDuration: 500, postClickWait: 500 });

  // Select Single Extra Shot
  const extraShotBtn = page.locator('span:text-is("Single Extra Shot")').locator('xpath=ancestor::div[1]/following-sibling::div//button').first();
  if (await extraShotBtn.isVisible()) {
    await smoothClick(page, extraShotBtn, { moveDuration: 500, postClickWait: 500 });
  }

  // Click Add to Cart
  const addOrderBtn = page.getByRole('button', { name: /Add to (Cart|Order)/i });
  await smoothClick(page, addOrderBtn, { moveDuration: 600, postClickWait: 1000 });

  // Pause on cart showing configured latte with badges
  await page.waitForTimeout(1800);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(rawVideo, 'addon-modifiers', DOCS_SHOWCASE_DIR, WEBSITE_SHOWCASE_DIR, '00:00:02.000');
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

  await page.waitForTimeout(1000);

  // Switch to Kanban if not already
  const kanbanBtn = page.getByRole('button', { name: 'Kanban', exact: true });
  if (await kanbanBtn.isVisible()) {
    await smoothClick(page, kanbanBtn, { moveDuration: 400, postClickWait: 500 });
  }

  // Click on the kitchen order item
  const itemBtn = page.locator('button:has-text("Flat White"), button:has-text("Croissant"), button:has-text("Toast"), button:has-text("Cold Brew")').first();
  if (await itemBtn.isVisible()) {
    await smoothClick(page, itemBtn, { moveDuration: 600, postClickWait: 700 });

    // Click "Mark as Preparing"
    const prepBtn = page.getByRole('button', { name: /Mark as Preparing/i });
    if (await prepBtn.isVisible()) {
      await smoothClick(page, prepBtn, { moveDuration: 500, postClickWait: 800 });
    }

    // Click item again to mark Ready
    await page.waitForTimeout(600);
    const itemPrepBtn = page.locator('button:has-text("Flat White"), button:has-text("Croissant"), button:has-text("Toast"), button:has-text("Cold Brew")').first();
    if (await itemPrepBtn.isVisible()) {
      await smoothClick(page, itemPrepBtn, { moveDuration: 600, postClickWait: 700 });
      const readyBtn = page.getByRole('button', { name: /Mark as Ready/i });
      if (await readyBtn.isVisible()) {
        await smoothClick(page, readyBtn, { moveDuration: 500, postClickWait: 1000 });
      }
    }
  }

  // Hold on updated board
  await page.waitForTimeout(1800);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(rawVideo, 'kds-kanban', DOCS_SHOWCASE_DIR, WEBSITE_SHOWCASE_DIR, '00:00:02.000');
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

  await page.waitForTimeout(800);

  // Switch to Floor plan view
  const floorTab = page.getByRole('button', { name: 'Floor plan' });
  if (await floorTab.isVisible()) {
    await smoothClick(page, floorTab, { moveDuration: 500, postClickWait: 800 });
  }

  // Move cursor around floor plan tables to show the visual floor plan
  const t2Table = page.locator('text=T2').first();
  if (await t2Table.isVisible()) {
    await smoothMove(page, t2Table, 600);
    await page.waitForTimeout(500);
  }

  const t1Table = page.locator('text=T1').first();
  if (await t1Table.isVisible()) {
    await smoothMove(page, t1Table, 500);
    await page.waitForTimeout(500);
  }

  // Switch back to List view to show table turnover status
  const listTab = page.getByRole('button', { name: 'List' });
  if (await listTab.isVisible()) {
    await smoothClick(page, listTab, { moveDuration: 600, postClickWait: 800 });
  }

  await page.waitForTimeout(1600);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(rawVideo, 'floorplan-tables', DOCS_SHOWCASE_DIR, WEBSITE_SHOWCASE_DIR, '00:00:01.800');
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

  await page.waitForTimeout(800);

  // Select Table T1
  const t1Btn = page.getByRole('button', { name: /T1/i }).first();
  if (await t1Btn.isVisible()) {
    await smoothClick(page, t1Btn, { moveDuration: 500, postClickWait: 600 });
  }

  // Tap Cold Brew
  const coldBrew = page.getByText('Nitro Cold Brew').first();
  if (await coldBrew.isVisible()) {
    await smoothClick(page, coldBrew, { moveDuration: 500, postClickWait: 500 });
  }

  // Tap Scone
  const scone = page.getByText('Blueberry Scone').first();
  if (await scone.isVisible()) {
    await smoothClick(page, scone, { moveDuration: 500, postClickWait: 500 });
  }

  // Open cart drawer on mobile
  const cartTrigger = page.locator('button[aria-label="Current ticket"], button:has(svg.lucide-shopping-cart)').first();
  if (await cartTrigger.isVisible()) {
    await smoothClick(page, cartTrigger, { moveDuration: 500, postClickWait: 600 });
  }

  // Add notes and send
  const noteInput = page.getByPlaceholder('Order notes (optional)').first();
  if (await noteInput.isVisible()) {
    await smoothClick(page, noteInput, { moveDuration: 400 });
    await noteInput.fill('Table 1 - extra cold');
  }

  const sendBtn = page.getByRole('button', { name: /Send to kitchen|Place Order/i }).first();
  if (await sendBtn.isVisible()) {
    await smoothClick(page, sendBtn, { moveDuration: 500, postClickWait: 1200 });
  }

  await page.waitForTimeout(1600);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(rawVideo, 'server-app', DOCS_SHOWCASE_DIR, WEBSITE_SHOWCASE_DIR, '00:00:01.800');
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
  const token = getAuthToken('manager', 'user-manager');
  await setupPageAuth(page, token, 'http://127.0.0.1:3001/orders');

  await page.waitForTimeout(800);

  // Click on the active Table T2 order
  const orderRow = page.locator('text=T2').first();
  if (await orderRow.isVisible()) {
    await smoothClick(page, orderRow, { moveDuration: 500, postClickWait: 600 });
  }

  // Click "Checkout" or "Take Payment"
  const checkoutBtn = page.getByRole('button', { name: /Checkout|Take Payment/i }).first();
  if (await checkoutBtn.isVisible()) {
    await smoothClick(page, checkoutBtn, { moveDuration: 600, postClickWait: 800 });

    // Payment modal opens! Toggle "Split payment equally"
    const splitToggle = page.getByRole('button', { name: 'Split payment equally' });
    if (await splitToggle.isVisible()) {
      await smoothClick(page, splitToggle, { moveDuration: 600, postClickWait: 600 });

      // Change remaining payers to 2
      const payerInput = page.getByLabel('Remaining payers');
      if (await payerInput.isVisible()) {
        await smoothClick(page, payerInput, { moveDuration: 400 });
        await payerInput.fill('2');
        await page.waitForTimeout(400);
      }

      // Click "Apply to Cash"
      const applyCash = page.getByRole('button', { name: 'Apply to Cash' });
      if (await applyCash.isVisible()) {
        await smoothClick(page, applyCash, { moveDuration: 500, postClickWait: 600 });
      }
    }
  }

  await page.waitForTimeout(2000);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(rawVideo, 'split-payments', DOCS_SHOWCASE_DIR, WEBSITE_SHOWCASE_DIR, '00:00:02.500');
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

  await page.waitForTimeout(1000);

  // Switch to Recipes tab
  const recipesTab = page.getByRole('tab', { name: /Recipes/i });
  if (await recipesTab.isVisible()) {
    await smoothClick(page, recipesTab, { moveDuration: 600, postClickWait: 1000 });
  }

  // Switch to Stock Movements tab
  const movementsTab = page.getByRole('tab', { name: /Stock Movements|Movements/i });
  if (await movementsTab.isVisible()) {
    await smoothClick(page, movementsTab, { moveDuration: 600, postClickWait: 1000 });
  }

  // Return to Supplies tab
  const suppliesTab = page.getByRole('tab', { name: /Supplies/i });
  if (await suppliesTab.isVisible()) {
    await smoothClick(page, suppliesTab, { moveDuration: 600, postClickWait: 1000 });
  }

  await page.waitForTimeout(1800);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(rawVideo, 'recipe-inventory', DOCS_SHOWCASE_DIR, WEBSITE_SHOWCASE_DIR, '00:00:01.200');
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

  await page.waitForTimeout(800);

  // Select 80mm paper width
  const paper80 = page.getByRole('button', { name: /80mm/i }).first();
  if (await paper80.isVisible()) {
    await smoothClick(page, paper80, { moveDuration: 500, postClickWait: 500 });
  }

  // Select KOT Kitchen Ticket mode
  const kotMode = page.getByRole('button', { name: /KOT/i }).first();
  if (await kotMode.isVisible()) {
    await smoothClick(page, kotMode, { moveDuration: 500, postClickWait: 600 });
  }

  // Switch to Detailed Tax Bill
  const taxBill = page.getByRole('button', { name: /Detailed Tax Bill/i }).first();
  if (await taxBill.isVisible()) {
    await smoothClick(page, taxBill, { moveDuration: 500, postClickWait: 600 });
  }

  // Scroll data preview into view
  const preview = page.getByText('Data Preview').first();
  if (await preview.isVisible()) {
    await smoothMove(page, preview, 500);
  }

  await page.waitForTimeout(2000);

  const rawVideo = await page.video().path();
  await context.close();
  return transcodeMedia(rawVideo, 'thermal-printing', DOCS_SHOWCASE_DIR, WEBSITE_SHOWCASE_DIR, '00:00:01.800');
}

// ── MASTER RUNNER ────────────────────────────────────────────────────────────
async function main() {
  console.log('Starting FloCafe Autonomous Media Recording Pipeline...');
  
  console.log('[Runner] Starting sandbox server...');
  const server = cp.spawn('node', [path.join(__dirname, 'showcase-server.cjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: '3001', KDS_PORT: '3002', SERVER_APP_PORT: '3003' },
  });

  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      const msg = d.toString();
      process.stdout.write(msg);
      if (msg.includes('All services ready for capture')) {
        resolve();
      }
    });
    server.on('error', reject);
    setTimeout(() => reject(new Error('Server start timeout')), 30000);
  });

  console.log('[Runner] Launching headless browser...');
  const browser = await chromium.launch({
    headless: true,
  });

  const results = {};
  const requestedScene = process.argv.find((a) => a.startsWith('--scene='))?.split('=')[1];

  try {
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
      }))
    );
  } finally {
    console.log('[Runner] Cleaning up browser and server...');
    await browser.close();
    server.kill('SIGINT');
  }
}

if (require.main === module) {
  main().catch((err) => {
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
