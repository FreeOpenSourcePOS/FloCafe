/**
 * Integration Test: Product Images Feature
 *
 * Tests:
 * A) validateImageUrl — server-side validation of Base64 data URIs
 * B) PUT /:id — COALESCE fix for image_url (clear image, don't touch image)
 * C) GET /:id/image — serve Base64, ETag, legacy URL redirect, 404
 * D) GET / — has_image flag computed, image_url stripped from response
 * E) POST /fetch-url — CORS proxy (mocked external fetch)
 * F) POST / — create product with image_url validation
 * G) Transaction wrapping — product + addon groups succeed or fail together
 *
 * Usage: node tests/run-electron-node-test.cjs tests/product-images.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-product-images-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, assertIncludes, assertGreaterThan,
  closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { productRoutes } = require('../main/routes/products');

// ── Test Data ────────────────────────────────────────────────────────────────

// A small valid WebP Base64 data URI (1x1 pixel, ~100 chars)
const VALID_IMAGE = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
// A small valid PNG Base64 data URI
const VALID_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// A legacy URL (not Base64)
const LEGACY_URL = 'https://example.com/photo.jpg';
// An oversized Base64 string (>50,000 chars)
const OVERSIZED_IMAGE = 'data:image/webp;base64,' + 'A'.repeat(50_001);
// A short invalid prefix
const BAD_PREFIX = 'not-a-data-uri';
// A valid-looking but wrong format
const BAD_FORMAT = 'data:text/plain;base64,SGVsbG8=';

async function main() {
  console.log('Integration Test: Product Images');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-1', 'Drinks');
  seedProduct(db, 'prod-1', 'cat-1', 'Espresso', 3.50);

  const app = createApp({ '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    // ── A) validateImageUrl — tested via PUT endpoint ──────────────────────
    console.log('\n─── A) validateImageUrl via PUT endpoint ───');

    // A1: Valid Base64 image — should succeed
    let res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: VALID_IMAGE },
    });
    assertEqual(res.status, 200, 'A1: Valid Base64 image accepted');
    assertEqual(res.data.product.image_url, VALID_IMAGE, 'A1: Image stored correctly');

    // A2: Valid PNG — should succeed
    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: VALID_PNG },
    });
    assertEqual(res.status, 200, 'A2: Valid PNG accepted');

    // A3: Bad prefix — should fail
    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: BAD_PREFIX },
    });
    assertEqual(res.status, 400, 'A3: Bad prefix rejected');
    assertIncludes(res.data.error, 'Base64 data URI', 'A3: Error message is descriptive');

    // A4: Bad format (text/plain) — should fail
    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: BAD_FORMAT },
    });
    assertEqual(res.status, 400, 'A4: Bad format rejected');

    // A5: Oversized — should fail
    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: OVERSIZED_IMAGE },
    });
    assertEqual(res.status, 400, 'A5: Oversized image rejected');

    // A6: Non-string type — should fail
    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: 12345 },
    });
    assertEqual(res.status, 400, 'A6: Non-string type rejected');

    // A7: null — should succeed (clears image)
    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: null },
    });
    assertEqual(res.status, 200, 'A7: null accepted (clears image)');

    // ── B) PUT /:id — COALESCE fix ─────────────────────────────────────────
    console.log('\n─── B) PUT /:id — COALESCE fix ───');

    // B1: Set image, then clear it
    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: VALID_IMAGE },
    });
    assertEqual(res.status, 200, 'B1a: Image set');

    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: null },
    });
    assertEqual(res.status, 200, 'B1b: Image cleared');
    // Verify via image endpoint — should return 404
    res = await api(baseUrl, '/api/products/prod-1/image', { headers: authHeader });
    assertEqual(res.status, 404, 'B1c: Cleared image returns 404');

    // B2: Update product WITHOUT sending image_url — image should be untouched
    // First set an image
    await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { image_url: VALID_IMAGE },
    });
    // Update name only — image_url not in body
    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: { name: 'Espresso Shot' },
    });
    assertEqual(res.status, 200, 'B2a: Product updated without image');
    // Image should still be there — use raw fetch (api() tries to parse JSON)
    const imgCheck = await (globalThis as any).fetch(`${baseUrl}/api/products/prod-1/image`, {
      headers: authHeader,
    });
    assertEqual(imgCheck.status, 200, 'B2b: Image preserved when not in payload');

    // B3: Parameter ordering — update ALL fields at once
    res = await api(baseUrl, '/api/products/prod-1', {
      method: 'PUT', headers: authHeader,
      body: {
        name: 'Double Espresso',
        category_id: 'cat-1',
        price: 4.50,
        cost_price: 1.20,
        sku: 'ESP-002',
        description: 'Strong double shot',
        tax_type: 'inclusive',
        tax_rate: 5,
        track_inventory: false,
        stock_quantity: 100,
        low_stock_threshold: 10,
        is_active: true,
        sort_order: 2,
        cb_percent: 5,
        tags: ['hot', 'strong'],
        image_url: VALID_PNG,
      },
    });
    assertEqual(res.status, 200, 'B3a: Full update succeeded');
    assertEqual(res.data.product.name, 'Double Espresso', 'B3b: Name correct');
    assertEqual(res.data.product.price, 4.50, 'B3c: Price correct');
    assertEqual(res.data.product.sku, 'ESP-002', 'B3d: SKU correct');
    assertEqual(res.data.product.cb_percent, 5, 'B3e: Cashback correct');

    // ── C) GET /:id/image — serve, ETag, legacy, 404 ───────────────────────
    console.log('\n─── C) GET /:id/image ───');

    // C1: Serve valid image — use raw fetch (api() tries to parse JSON)
    const imgResponse = await (globalThis as any).fetch(`${baseUrl}/api/products/prod-1/image`, {
      headers: authHeader,
    });
    assertEqual(imgResponse.status, 200, 'C1: Valid image served');
    assertEqual(imgResponse.headers.get('content-type'), 'image/png', 'C1: Content-Type is image/png');
    assert(imgResponse.headers.get('etag'), 'C1: ETag header present');
    assertEqual(imgResponse.headers.get('cache-control'), 'no-cache', 'C1: Cache-Control is no-cache');

    // C2: 304 Not Modified
    const etag = imgResponse.headers.get('etag');
    const notModifiedResponse = await (globalThis as any).fetch(`${baseUrl}/api/products/prod-1/image`, {
      headers: { ...authHeader, 'If-None-Match': etag },
    });
    assertEqual(notModifiedResponse.status, 304, 'C2: 304 Not Modified on matching ETag');

    // C3: Legacy URL redirect
    // Manually set image_url to a legacy URL
    db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(LEGACY_URL, 'prod-1');
    const redirectResponse = await (globalThis as any).fetch(`${baseUrl}/api/products/prod-1/image`, {
      headers: authHeader,
      redirect: 'manual',
    });
    assertEqual(redirectResponse.status, 302, 'C3: Legacy URL returns 302 redirect');
    assertEqual(redirectResponse.headers.get('location'), LEGACY_URL, 'C3: Redirect location is correct');

    // Restore valid image for remaining tests
    db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(VALID_PNG, 'prod-1');

    // C4: 404 for product with no image
    // Create a product without image
    seedProduct(db, 'prod-no-img', 'cat-1', 'No Image Product', 2.00);
    const noImgResponse = await (globalThis as any).fetch(`${baseUrl}/api/products/prod-no-img/image`, {
      headers: authHeader,
    });
    assertEqual(noImgResponse.status, 404, 'C4: 404 for product without image');

    // C5: 404 for non-existent product
    const notFoundResponse = await (globalThis as any).fetch(`${baseUrl}/api/products/nonexistent/image`, {
      headers: authHeader,
    });
    assertEqual(notFoundResponse.status, 404, 'C5: 404 for non-existent product');

    // ── D) GET / — has_image flag ──────────────────────────────────────────
    console.log('\n─── D) GET / — has_image flag ───');

    res = await api(baseUrl, '/api/products', { headers: authHeader });
    assertEqual(res.status, 200, 'D1: Bulk GET succeeds');
    const products = res.data.products;
    assert(Array.isArray(products), 'D2: Products is an array');

    const prodWithImage = products.find((p: any) => p.id === 'prod-1');
    assert(prodWithImage, 'D3: Found prod-1');
    assertEqual(prodWithImage.has_image, 1, 'D4: has_image is 1 for product with image');
    assertEqual(prodWithImage.image_url, undefined, 'D5: image_url not in response (stripped)');

    const prodWithoutImage = products.find((p: any) => p.id === 'prod-no-img');
    assert(prodWithoutImage, 'D6: Found prod-no-img');
    assertEqual(prodWithoutImage.has_image, 0, 'D7: has_image is 0 for product without image');

    // ── E) POST /fetch-url — CORS proxy ────────────────────────────────────
    console.log('\n─── E) POST /fetch-url (validation only) ───');

    // E1: Missing URL
    res = await api(baseUrl, '/api/products/fetch-url', {
      method: 'POST', headers: authHeader,
      body: {},
    });
    assertEqual(res.status, 400, 'E1: Missing URL rejected');

    // E2: HTTP URL (not HTTPS)
    res = await api(baseUrl, '/api/products/fetch-url', {
      method: 'POST', headers: authHeader,
      body: { url: 'http://example.com/photo.jpg' },
    });
    assertEqual(res.status, 400, 'E2: HTTP URL rejected');
    assertIncludes(res.data.error, 'HTTPS', 'E2: Error mentions HTTPS');

    // E3: Non-string URL
    res = await api(baseUrl, '/api/products/fetch-url', {
      method: 'POST', headers: authHeader,
      body: { url: 12345 },
    });
    assertEqual(res.status, 400, 'E3: Non-string URL rejected');

    // E4: HTTPS URL to non-existent server (will fail with 502)
    res = await api(baseUrl, '/api/products/fetch-url', {
      method: 'POST', headers: authHeader,
      body: { url: 'https://this-domain-does-not-exist-12345.com/photo.jpg' },
    });
    assertEqual(res.status, 502, 'E4: Non-existent server returns 502');

    // ── F) POST / — create product with image validation ───────────────────
    console.log('\n─── F) POST / — create with image validation ───');

    // F1: Create with valid image
    res = await api(baseUrl, '/api/products', {
      method: 'POST', headers: authHeader,
      body: {
        name: 'Latte',
        price: 4.00,
        category_id: 'cat-1',
        image_url: VALID_IMAGE,
      },
    });
    assertEqual(res.status, 201, 'F1: Product created with image');
    assert(res.data.product.id, 'F1: Product has ID');

    // F2: Create with invalid image — should fail
    res = await api(baseUrl, '/api/products', {
      method: 'POST', headers: authHeader,
      body: {
        name: 'Bad Image Product',
        price: 5.00,
        category_id: 'cat-1',
        image_url: BAD_PREFIX,
      },
    });
    assertEqual(res.status, 400, 'F2: Product creation rejected with invalid image');

    // F3: Create without image — should succeed
    res = await api(baseUrl, '/api/products', {
      method: 'POST', headers: authHeader,
      body: {
        name: 'No Image Product',
        price: 3.00,
        category_id: 'cat-1',
      },
    });
    assertEqual(res.status, 201, 'F3: Product created without image');

    // ── G) Transaction wrapping ────────────────────────────────────────────
    console.log('\n─── G) Transaction wrapping ───');

    // G1: Create product with addon groups — should succeed
    // First create an addon group
    db.prepare(
      `INSERT OR IGNORE INTO addon_groups (id, name, is_required, min_selection, max_selection, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('ag-1', 'Milk Options', 0, 0, 3, 1, 1, now(), now());

    res = await api(baseUrl, '/api/products', {
      method: 'POST', headers: authHeader,
      body: {
        name: 'Cappuccino',
        price: 4.50,
        category_id: 'cat-1',
        addon_group_ids: ['ag-1'],
      },
    });
    assertEqual(res.status, 201, 'G1: Product with addon group created');

    // Verify addon group link exists
    const agpCount = db.prepare('SELECT COUNT(*) as count FROM addon_group_product WHERE product_id = ?').get(res.data.product.id);
    assertEqual(agpCount.count, 1, 'G1: Addon group link created');

    console.log('\n' + '='.repeat(50));
    const results = require('./helpers/test-setup').getResults();
    console.log(`Results: ${results.passed}/${results.total} passed, ${results.failed} failed`);

    if (results.failed > 0) {
      process.exit(1);
    }
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
