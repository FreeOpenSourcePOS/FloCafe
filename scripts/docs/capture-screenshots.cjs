#!/usr/bin/env node
/**
 * Automated Screenshot Capture Script for FloCafe Documentation.
 *
 * Connects to the running demo server (port 3101, 3102, 3103),
 * drives Chromium via Playwright, and captures crisp documentation screenshots
 * into flopos.com's assets/docs/ directory.
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

async function capture() {
  console.log('='.repeat(60));
  console.log('Capturing FloCafe Help Center Screenshots');
  console.log(`Output Directory: ${OUTPUT_DIR}`);
  console.log('='.repeat(60));

  const browser = await chromium.launch({ headless: true });

  // High-DPI Desktop Viewport
  const desktopContext = await browser.newContext({
    viewport: { width: 1366, height: 860 },
    deviceScaleFactor: 2,
  });
  const page = await desktopContext.newPage();

  // 1. Capture Login Screen
  console.log('Capturing 1/22: auth-login-screen.webp');
  await page.goto(`${BASE_URL}/auth/login`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'auth-login-screen.webp'),
    type: 'webp',
    quality: 90,
  });

  // Authenticate as Owner
  console.log('Authenticating as owner@blueharbor.local...');
  await page.locator('#email').fill('owner@blueharbor.local');
  await page.locator('#password').fill('DemoPassword123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 15000 });

  // 2. Capture POS Main Screen
  console.log('Capturing 2/22: pos-main-screen.webp');
  await page.goto(`${BASE_URL}/pos`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'pos-main-screen.webp'),
    type: 'webp',
    quality: 90,
  });

  // 3. Capture Item Customizer Modal
  console.log('Capturing 3/22: pos-cart-customizer.webp');
  const latteCard = page.locator('text=Caffè Latte').first();
  if (await latteCard.isVisible()) {
    await latteCard.click();
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(OUTPUT_DIR, 'pos-cart-customizer.webp'),
      type: 'webp',
      quality: 90,
    });

    // Cleanly navigate back to /pos to clear modal overlay
    await page.goto(`${BASE_URL}/pos`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
  }

  // 4. Capture POS Checkout Modal
  console.log('Capturing 4/22: pos-checkout-modal.webp');
  const croissantCard = page.locator('text=Butter Croissant').first();
  if (await croissantCard.isVisible()) {
    await croissantCard.click();
    await page.waitForTimeout(500);
  }
  const placeOrderBtn = page.getByRole('button', { name: /Place Order/i }).first();
  if (await placeOrderBtn.isVisible()) {
    await placeOrderBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({
      path: path.join(OUTPUT_DIR, 'pos-checkout-modal.webp'),
      type: 'webp',
      quality: 90,
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // 5. Capture Orders Dashboard
  console.log('Capturing 5/22: orders-dashboard.webp');
  await page.goto(`${BASE_URL}/orders`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'orders-dashboard.webp'),
    type: 'webp',
    quality: 90,
  });

  // 6. Capture Tables & Floor Plan
  console.log('Capturing 6/22: tables-floorplan.webp');
  await page.goto(`${BASE_URL}/tables`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  const floorPlanBtn = page.getByRole('button', { name: /Floor plan/i });
  if (await floorPlanBtn.isVisible()) {
    await floorPlanBtn.click();
    await page.waitForTimeout(500);
  }
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'tables-floorplan.webp'),
    type: 'webp',
    quality: 90,
  });

  // 7. Capture Products Management
  console.log('Capturing 7/22: products-management.webp');
  await page.goto(`${BASE_URL}/products`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'products-management.webp'),
    type: 'webp',
    quality: 90,
  });

  // 8. Capture Product Edit Form
  console.log('Capturing 8/22: product-edit-form.webp');
  const editBtn = page.locator('button[aria-label*="Edit"], button:has-text("Edit")').first();
  if (await editBtn.isVisible()) {
    await editBtn.click();
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(OUTPUT_DIR, 'product-edit-form.webp'),
      type: 'webp',
      quality: 90,
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // 9. Capture Add-on Groups Manager
  console.log('Capturing 9/22: addon-groups-manager.webp');
  await page.goto(`${BASE_URL}/addon-groups`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'addon-groups-manager.webp'),
    type: 'webp',
    quality: 90,
  });

  // 10. Capture Inventory & Supplies Ledger
  console.log('Capturing 10/22: inventory-supplies-ledger.webp');
  await page.goto(`${BASE_URL}/inventory`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'inventory-supplies-ledger.webp'),
    type: 'webp',
    quality: 90,
  });

  // 11. Capture Staff & Permissions
  console.log('Capturing 11/22: staff-roles-permissions.webp');
  await page.goto(`${BASE_URL}/staff`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'staff-roles-permissions.webp'),
    type: 'webp',
    quality: 90,
  });

  // 12. Capture Customers & Loyalty
  console.log('Capturing 12/22: customers-loyalty-screen.webp');
  await page.goto(`${BASE_URL}/customers`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'customers-loyalty-screen.webp'),
    type: 'webp',
    quality: 90,
  });

  // 13. Capture Sales Dashboard & Reports
  console.log('Capturing 13/22: reports-sales-dashboard.webp');
  await page.goto(`${BASE_URL}/dashboard`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'reports-sales-dashboard.webp'),
    type: 'webp',
    quality: 90,
  });

  // 14. Capture Expenses Ledger
  console.log('Capturing 14/22: expenses-ledger.webp');
  await page.goto(`${BASE_URL}/expenses`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'expenses-ledger.webp'),
    type: 'webp',
    quality: 90,
  });

  // 15. Capture Settings - Printers
  console.log('Capturing 15/22: settings-printers.webp');
  await page.goto(`${BASE_URL}/settings`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  const printersTab = page
    .locator('button:has-text("Printers"), [role="tab"]:has-text("Printers")')
    .first();
  if (await printersTab.isVisible()) {
    await printersTab.click();
    await page.waitForTimeout(600);
  }
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'settings-printers.webp'),
    type: 'webp',
    quality: 90,
  });

  // 16. Capture Settings - Taxes & Localization
  console.log('Capturing 16/22: settings-taxes-locale.webp');
  const taxTab = page
    .locator(
      'button:has-text("Tax"), [role="tab"]:has-text("Tax"), button:has-text("Store"), [role="tab"]:has-text("Store")',
    )
    .first();
  if (await taxTab.isVisible()) {
    await taxTab.click();
    await page.waitForTimeout(600);
  }
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'settings-taxes-locale.webp'),
    type: 'webp',
    quality: 90,
  });

  // 17. Capture Settings - Backups & Database
  console.log('Capturing 17/22: backups-restore-screen.webp');
  const backupTab = page
    .locator(
      'button:has-text("Backup"), [role="tab"]:has-text("Backup"), button:has-text("Database"), [role="tab"]:has-text("Database")',
    )
    .first();
  if (await backupTab.isVisible()) {
    await backupTab.click();
    await page.waitForTimeout(600);
  }
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'backups-restore-screen.webp'),
    type: 'webp',
    quality: 90,
  });

  // 18. Capture Support & Diagnostics
  console.log('Capturing 18/22: support-diagnostics-screen.webp');
  await page.goto(`${BASE_URL}/support`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'support-diagnostics-screen.webp'),
    type: 'webp',
    quality: 90,
  });

  // 19. Capture Print Test Page
  console.log('Capturing 19/22: print-test-page.webp');
  await page.goto(`${BASE_URL}/print-test`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'print-test-page.webp'),
    type: 'webp',
    quality: 90,
  });

  // 20. Capture Customer Display Board
  console.log('Capturing 20/22: customer-display-board.webp');
  await page.goto(`${BASE_URL}/customer-display`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'customer-display-board.webp'),
    type: 'webp',
    quality: 90,
  });

  // 21. Capture Standalone KDS View (Port 3102)
  console.log('Capturing 21/22: kds-station-view.webp');
  const kdsPage = await desktopContext.newPage();
  try {
    await kdsPage.goto(`${KDS_URL}/kds-standalone/`, { timeout: 10000 });
    await kdsPage.waitForLoadState('networkidle');
    await kdsPage.waitForTimeout(1000);
    await kdsPage.screenshot({
      path: path.join(OUTPUT_DIR, 'kds-station-view.webp'),
      type: 'webp',
      quality: 90,
    });
  } catch (err) {
    console.warn('KDS screenshot note:', err.message);
  }
  await kdsPage.close();

  // 22. Capture Mobile Server App (Port 3103 in iPhone viewport)
  console.log('Capturing 22/22: server-app-mobile.webp');
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const mobilePage = await mobileContext.newPage();
  try {
    await mobilePage.goto(`${SERVER_APP_URL}/server-standalone/`, { timeout: 10000 });
    await mobilePage.waitForLoadState('networkidle');
    await mobilePage.waitForTimeout(1000);
    await mobilePage.screenshot({
      path: path.join(OUTPUT_DIR, 'server-app-mobile.webp'),
      type: 'webp',
      quality: 90,
    });
  } catch (err) {
    console.warn('Server App screenshot note:', err.message);
  }
  await mobileContext.close();

  await browser.close();
  console.log('='.repeat(60));
  console.log('All 22 documentation screenshots captured successfully!');
  console.log(`Files located in: ${OUTPUT_DIR}`);
  console.log('='.repeat(60));
}

capture().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
