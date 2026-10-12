#!/usr/bin/env node
/**
 * Automated Screenshot Capture Script for FloCafe Documentation.
 *
 * Connects to the running demo server (port 3101, 3102, 3103),
 * drives Chromium via Playwright, and captures crisp documentation screenshots
 * into flopos.com's assets/docs/ directory.
 *
 * Enforces strict verification: missing UI elements produce actionable errors,
 * all captured files are verified on disk, and failures exit non-zero.
 */
const fs = require('fs');
const path = require('path');
let chromium;
try {
  ({ chromium } = require('../../frontend/node_modules/playwright'));
} catch {
  ({ chromium } = require('playwright'));
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:3101';
const KDS_URL = process.env.KDS_URL || 'http://localhost:3102';
const SERVER_APP_URL = process.env.SERVER_APP_URL || 'http://localhost:3103';

const candidateDirs = [
  process.env.DOCS_ASSETS_DIR,
  path.resolve(__dirname, '../../../flopos.com-help-center/assets/docs'),
  path.resolve(__dirname, '../../flopos.com-help-center/assets/docs'),
  path.resolve(__dirname, '../../../flopos.com/assets/docs'),
  path.resolve(__dirname, '../../flopos.com/assets/docs'),
  path.resolve(__dirname, '../../docs-assets'),
].filter(Boolean);

const OUTPUT_DIR =
  candidateDirs.find((d) => {
    try {
      return fs.existsSync(path.dirname(d));
    } catch {
      return false;
    }
  }) ||
  candidateDirs[0] ||
  path.resolve(__dirname, '../../docs-assets');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const REQUIRED_SCREENSHOTS = [
  'auth-login-screen.webp',
  'pos-main-screen.webp',
  'pos-cart-customizer.webp',
  'pos-checkout-modal.webp',
  'orders-dashboard.webp',
  'tables-floorplan.webp',
  'products-management.webp',
  'product-create-modal.webp',
  'product-edit-form.webp',
  'products-addon-groups.webp',
  'addon-group-create-modal.webp',
  'inventory-supplies-ledger.webp',
  'staff-roles-permissions.webp',
  'customers-loyalty-screen.webp',
  'reports-sales-dashboard.webp',
  'expenses-ledger.webp',
  'settings-printers.webp',
  'settings-printer-add-modal.webp',
  'settings-receipt-customization.webp',
  'settings-whatsapp.webp',
  'settings-taxes-locale.webp',
  'backups-restore-screen.webp',
  'support-diagnostics-screen.webp',
  'customer-display-board.webp',
  'kds-station-view.webp',
  'server-app-mobile.webp',
];

async function capture() {
  console.log('='.repeat(60));
  console.log('Capturing FloCafe Help Center Screenshots');
  console.log(`Output Directory: ${OUTPUT_DIR}`);
  console.log(`Expected Files: ${REQUIRED_SCREENSHOTS.length}`);
  console.log('='.repeat(60));

  const browser = await chromium.launch({ headless: true });

  // High-DPI Desktop Viewport
  const desktopContext = await browser.newContext({
    viewport: { width: 1366, height: 860 },
    deviceScaleFactor: 2,
  });
  const page = await desktopContext.newPage();

  // Helper to save screenshot and log
  async function takeScreenshot(filename, locatorOrPage = page) {
    const targetPath = path.join(OUTPUT_DIR, filename);
    await locatorOrPage.screenshot({
      path: targetPath,
      type: 'webp',
      quality: 90,
    });
    console.log(`  ✓ Saved: ${filename}`);
  }

  // Helper to safely click a cancel button or fall back to navigation
  async function closeDialog(fallbackUrl) {
    try {
      const cancelBtn = page.getByRole('button', { name: /Cancel|Close/i }).first();
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
        await page.waitForTimeout(300);
        return;
      }
    } catch {}
    if (fallbackUrl) {
      await page.goto(fallbackUrl);
      await page.waitForLoadState('networkidle');
    }
  }

  // 1. Capture Login Screen
  console.log('\n[1/26] Capturing auth-login-screen.webp...');
  await page.goto(`${BASE_URL}/auth/login/`);
  await page.waitForLoadState('networkidle');
  await page.locator('#email').waitFor({ state: 'visible', timeout: 10000 });
  await takeScreenshot('auth-login-screen.webp');

  // Authenticate as Owner
  console.log('Authenticating as owner@blueharbor.local...');
  await page.locator('#email').fill('owner@blueharbor.local');
  await page.locator('#password').fill('DemoPassword123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 15000 });

  // 2. Capture POS Main Screen
  console.log('\n[2/26] Capturing pos-main-screen.webp...');
  await page.goto(`${BASE_URL}/pos/`);
  await page.waitForLoadState('networkidle');
  await page.locator('text=Caffè Latte').first().waitFor({ state: 'visible', timeout: 10000 });
  await takeScreenshot('pos-main-screen.webp');

  // 3. Capture Item Customizer Modal
  console.log('\n[3/26] Capturing pos-cart-customizer.webp...');
  const latteCard = page.locator('text=Caffè Latte').first();
  await latteCard.click();
  await page.waitForTimeout(600);
  await takeScreenshot('pos-cart-customizer.webp');
  // Cleanly navigate back to /pos to clear modal overlay
  await page.goto(`${BASE_URL}/pos/`);
  await page.waitForLoadState('networkidle');

  // 4. Capture POS Checkout Modal
  console.log('\n[4/26] Capturing pos-checkout-modal.webp...');
  const croissantCard = page.locator('text=Butter Croissant').first();
  await croissantCard.waitFor({ state: 'visible', timeout: 5000 });
  await croissantCard.click();
  await page.waitForTimeout(500);
  const placeOrderBtn = page.getByRole('button', { name: /Place Order/i }).first();
  await placeOrderBtn.waitFor({ state: 'visible', timeout: 5000 });
  await placeOrderBtn.click();
  await page.waitForTimeout(800);
  await takeScreenshot('pos-checkout-modal.webp');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 5. Capture Orders Dashboard
  console.log('\n[5/26] Capturing orders-dashboard.webp...');
  await page.goto(`${BASE_URL}/orders/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('orders-dashboard.webp');

  // 6. Capture Tables & Floor Plan
  console.log('\n[6/26] Capturing tables-floorplan.webp...');
  await page.goto(`${BASE_URL}/tables/`);
  await page.waitForLoadState('networkidle');
  const floorPlanBtn = page.getByRole('button', { name: /Floor plan/i });
  if (await floorPlanBtn.isVisible()) {
    await floorPlanBtn.click();
    await page.waitForTimeout(500);
  }
  await takeScreenshot('tables-floorplan.webp');

  // 7. Capture Products Management
  console.log('\n[7/26] Capturing products-management.webp...');
  await page.goto(`${BASE_URL}/products/`);
  await page.waitForLoadState('networkidle');
  await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
  await takeScreenshot('products-management.webp');

  // 8. Capture Product Create Modal (tutorial step)
  console.log('\n[8/26] Capturing product-create-modal.webp...');
  const addProdBtn = page.getByRole('button', { name: /Add Product/i });
  await addProdBtn.waitFor({ state: 'visible', timeout: 5000 });
  await addProdBtn.click();
  await page.locator('form#product-form').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(400);
  await takeScreenshot('product-create-modal.webp');
  await closeDialog(`${BASE_URL}/products/`);

  // 9. Capture Product Edit Form
  console.log('\n[9/26] Capturing product-edit-form.webp...');
  await page.goto(`${BASE_URL}/products/`);
  await page.waitForLoadState('networkidle');
  const editBtn = page.locator('table tbody tr button:has(svg.lucide-pencil)').first();
  await editBtn.waitFor({ state: 'visible', timeout: 5000 });
  await editBtn.click();
  await page.locator('form#product-form').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(400);
  await takeScreenshot('product-edit-form.webp');
  await closeDialog(`${BASE_URL}/products/`);

  // 10. Capture Add-on Groups Tab (Integrated into Products -> Add-on Groups)
  console.log('\n[10/26] Capturing products-addon-groups.webp...');
  await page.goto(`${BASE_URL}/products/`);
  await page.waitForLoadState('networkidle');
  const addonsTab = page.getByRole('tab', { name: /Addon Groups/i }).first();
  await addonsTab.waitFor({ state: 'visible', timeout: 5000 });
  await addonsTab.click();
  await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(600);
  await takeScreenshot('products-addon-groups.webp');

  // 11. Capture Add-on Group Create Modal (tutorial step)
  console.log('\n[11/26] Capturing addon-group-create-modal.webp...');
  const addGroupBtn = page.getByRole('button', { name: /Add Addon Group/i }).first();
  await addGroupBtn.waitFor({ state: 'visible', timeout: 5000 });
  await addGroupBtn.click();
  await page
    .locator('h2:has-text("Add Addon Group"), h3:has-text("Add Addon Group"), input')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);
  await takeScreenshot('addon-group-create-modal.webp');
  await closeDialog(`${BASE_URL}/products/`);

  // 12. Capture Inventory & Supplies Ledger
  console.log('\n[12/26] Capturing inventory-supplies-ledger.webp...');
  await page.goto(`${BASE_URL}/inventory/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('inventory-supplies-ledger.webp');

  // 13. Capture Staff & Permissions
  console.log('\n[13/26] Capturing staff-roles-permissions.webp...');
  await page.goto(`${BASE_URL}/staff/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('staff-roles-permissions.webp');

  // 14. Capture Customers & Loyalty
  console.log('\n[14/26] Capturing customers-loyalty-screen.webp...');
  await page.goto(`${BASE_URL}/customers/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('customers-loyalty-screen.webp');

  // 15. Capture Sales Dashboard & Reports
  console.log('\n[15/26] Capturing reports-sales-dashboard.webp...');
  await page.goto(`${BASE_URL}/dashboard/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('reports-sales-dashboard.webp');

  // 16. Capture Expenses Ledger
  console.log('\n[16/26] Capturing expenses-ledger.webp...');
  await page.goto(`${BASE_URL}/expenses/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('expenses-ledger.webp');

  // 17. Capture Settings - Printers (Real printer settings UI with Test print button)
  console.log('\n[17/26] Capturing settings-printers.webp...');
  await page.goto(`${BASE_URL}/settings/?tab=printers`);
  await page.waitForLoadState('networkidle');
  await page
    .locator('button:has-text("Add Manually")')
    .waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(600);
  await takeScreenshot('settings-printers.webp');

  // 18. Capture Settings - Printer Add Modal (tutorial step)
  console.log('\n[18/26] Capturing settings-printer-add-modal.webp...');
  const addPrinterBtn = page.getByRole('button', { name: /Add Manually/i }).first();
  await addPrinterBtn.waitFor({ state: 'visible', timeout: 5000 });
  await addPrinterBtn.click();
  await page.locator('input, select').first().waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);
  await takeScreenshot('settings-printer-add-modal.webp');
  await closeDialog(`${BASE_URL}/settings/?tab=printers`);

  // 19. Capture Settings - Receipt Customization
  console.log('\n[19/26] Capturing settings-receipt-customization.webp...');
  await page.goto(`${BASE_URL}/settings/?tab=store`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('settings-receipt-customization.webp');

  // 20. Capture Settings - WhatsApp
  console.log('\n[20/26] Capturing settings-whatsapp.webp...');
  await page.goto(`${BASE_URL}/settings/?tab=whatsapp`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('settings-whatsapp.webp');

  // 21. Capture Settings - Taxes & Localization
  console.log('\n[21/26] Capturing settings-taxes-locale.webp...');
  await page.goto(`${BASE_URL}/settings/?tab=tax`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('settings-taxes-locale.webp');

  // 22. Capture Settings - Backups & Database
  console.log('\n[22/26] Capturing backups-restore-screen.webp...');
  await page.goto(`${BASE_URL}/settings/?tab=data`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('backups-restore-screen.webp');

  // 23. Capture Support & Diagnostics
  console.log('\n[23/26] Capturing support-diagnostics-screen.webp...');
  await page.goto(`${BASE_URL}/support/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('support-diagnostics-screen.webp');

  // 24. Capture Customer Display Board
  console.log('\n[24/26] Capturing customer-display-board.webp...');
  await page.goto(`${BASE_URL}/customer-display/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await takeScreenshot('customer-display-board.webp');

  // 25. Capture Standalone KDS View (Port 3102)
  console.log('\n[25/26] Capturing kds-station-view.webp...');
  const kdsPage = await desktopContext.newPage();
  await kdsPage.goto(`${KDS_URL}/kds-standalone/`, { timeout: 15000 });
  await kdsPage.waitForLoadState('networkidle');
  await kdsPage.waitForTimeout(1000);
  await takeScreenshot('kds-station-view.webp', kdsPage);
  await kdsPage.close();

  // 26. Capture Mobile Server App (Port 3103 in iPhone viewport)
  console.log('\n[26/26] Capturing server-app-mobile.webp...');
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(`${SERVER_APP_URL}/server-standalone/`, { timeout: 15000 });
  await mobilePage.waitForLoadState('networkidle');
  await mobilePage.waitForTimeout(1000);
  await takeScreenshot('server-app-mobile.webp', mobilePage);
  await mobileContext.close();

  await browser.close();

  // Clean up obsolete developer/synthetic test screenshots from public assets
  const obsoleteFiles = ['print-test-page.webp', 'addon-groups-manager.webp'];
  for (const obs of obsoleteFiles) {
    const obsPath = path.join(OUTPUT_DIR, obs);
    if (fs.existsSync(obsPath)) {
      fs.unlinkSync(obsPath);
      console.log(`  ✓ Removed obsolete screenshot: ${obs}`);
    }
  }

  // Strict output verification
  console.log('\n' + '='.repeat(60));
  console.log('Verifying Generated Screenshot Assets...');
  console.log('='.repeat(60));

  const missingFiles = [];
  const emptyFiles = [];

  for (const filename of REQUIRED_SCREENSHOTS) {
    const filePath = path.join(OUTPUT_DIR, filename);
    if (!fs.existsSync(filePath)) {
      missingFiles.push(filename);
    } else {
      const stats = fs.statSync(filePath);
      if (stats.size < 1000) {
        emptyFiles.push(`${filename} (${stats.size} bytes)`);
      } else {
        console.log(`  ✓ Verified: ${filename} (${Math.round(stats.size / 1024)} KB)`);
      }
    }
  }

  if (missingFiles.length > 0 || emptyFiles.length > 0) {
    console.error('\n❌ Screenshot capture verification FAILED:');
    if (missingFiles.length > 0) console.error('  Missing files:', missingFiles);
    if (emptyFiles.length > 0) console.error('  Empty/Corrupt files:', emptyFiles);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log(
    `SUCCESS: All ${REQUIRED_SCREENSHOTS.length} documentation screenshots captured & verified!`,
  );
  console.log(`Assets directory: ${OUTPUT_DIR}`);
  console.log('='.repeat(60));
}

capture().catch((err) => {
  console.error('\n❌ Screenshot capture failed with fatal error:', err);
  process.exit(1);
});
