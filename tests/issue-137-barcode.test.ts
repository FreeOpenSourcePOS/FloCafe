/**
 * Integration Test: Issue #137 — barcode scanning for product lookup
 *
 * Covers the backend half of the feature: setting a barcode on create/edit,
 * duplicate-barcode rejection (a scan must resolve to exactly one product),
 * and the normalized exact-match ?barcode= lookup GET /api/products uses for the
 * scan-to-add-to-cart flow at POS.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-137-barcode.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-137-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-issue-137';

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { productRoutes } = require('../main/routes/products');

async function main() {
  console.log('Integration Test: Issue #137 — barcode scanning');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-137', 'Beverages');
  seedProduct(db, 'prod-137-cola', 'cat-137', 'Cola', 40);

  const app = createApp({ '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Scenario A: setting a barcode on create ───');
    let createdId: string;
    {
      const res = await api(baseUrl, '/api/products', {
        method: 'POST',
        body: {
          category_id: 'cat-137',
          name: 'Water Bottle',
          price: 20,
          barcode: '8901234567890',
          sale_unit: 'kg',
          allow_fractional_quantity: true,
          weight_precision: 3,
        },
        headers: authHeader,
      });
      assertEqual(res.status, 201, `product with barcode created (got ${res.status}, ${JSON.stringify(res.data)})`);
      assertEqual(res.data.product.barcode, '8901234567890', 'barcode persisted on create');
      assertEqual(res.data.product.sale_unit, 'kg', 'weighted sale unit persisted on create');
      assertEqual(res.data.product.allow_fractional_quantity, true, 'fractional quantity flag serialized as boolean');
      assertEqual(res.data.product.weight_precision, 3, 'weight precision persisted on create');
      createdId = res.data.product.id;
    }

    console.log('\n─── Scenario B: duplicate barcode is rejected on create ───');
    {
      const res = await api(baseUrl, '/api/products', {
        method: 'POST',
        body: { category_id: 'cat-137', name: 'Another Water Bottle', price: 25, barcode: '8901234567890' },
        headers: authHeader,
      });
      assertEqual(res.status, 400, 'B: duplicate barcode rejected with 400');
      assert(!!res.data.error, 'B: error message present');
    }

    console.log('\n─── Scenario B2: duplicate barcode is rejected after trimming ───');
    {
      const res = await api(baseUrl, '/api/products', {
        method: 'POST',
        body: { category_id: 'cat-137', name: 'Spaced Water Bottle', price: 25, barcode: '  8901234567890  ' },
        headers: authHeader,
      });
      assertEqual(res.status, 400, 'B2: duplicate barcode rejected after trim with 400');
      assert(!!res.data.error, 'B2: error message present');
    }

    console.log('\n─── Scenario C: exact-match ?barcode= lookup (the POS scan path) ───');
    {
      const res = await api(baseUrl, '/api/products?barcode=8901234567890', { headers: authHeader });
      assertEqual(res.status, 200, 'C: lookup succeeds');
      assertEqual(res.data.products.length, 1, 'C: exactly one product matches');
      assertEqual(res.data.products[0].id, createdId, 'C: correct product returned');
    }

    console.log('\n─── Scenario C2: lookup trims surrounding barcode whitespace ───');
    {
      const res = await api(baseUrl, '/api/products?barcode=%20%208901234567890%20%20', { headers: authHeader });
      assertEqual(res.status, 200, 'C2: trimmed lookup succeeds');
      assertEqual(res.data.products.length, 1, 'C2: exactly one product matches after trim');
      assertEqual(res.data.products[0].id, createdId, 'C2: correct product returned after trim');
    }

    console.log('\n─── Scenario D: lookup for an unknown barcode returns no results (not an error) ───');
    {
      const res = await api(baseUrl, '/api/products?barcode=0000000000000', { headers: authHeader });
      assertEqual(res.status, 200, 'D: unknown barcode still returns 200');
      assertEqual(res.data.products.length, 0, 'D: empty result set');
    }

    console.log('\n─── Scenario E: setting a barcode via update ───');
    let updateTargetId: string;
    {
      const created = await api(baseUrl, '/api/products', {
        method: 'POST',
        body: { category_id: 'cat-137', name: 'Chips', price: 30 },
        headers: authHeader,
      });
      updateTargetId = created.data.product.id;
      assert(!created.data.product.barcode, 'E: created without a barcode');

      const res = await api(baseUrl, `/api/products/${updateTargetId}`, {
        method: 'PUT',
        body: { barcode: '7501234567891', sale_unit: 'g', allow_fractional_quantity: true, weight_precision: 0 },
        headers: authHeader,
      });
      assertEqual(res.status, 200, 'E: update with a new barcode succeeds');
      assertEqual(res.data.product.barcode, '7501234567891', 'E: barcode set via update');
      assertEqual(res.data.product.sale_unit, 'g', 'E: weighted sale unit updates');
      assertEqual(res.data.product.allow_fractional_quantity, true, 'E: fractional quantity flag updates');
      assertEqual(res.data.product.weight_precision, 0, 'E: weight precision updates');
    }

    console.log('\n─── Scenario F: duplicate barcode is rejected on update (excluding self) ───');
    {
      // Re-saving its own current barcode must NOT be treated as a clash.
      const selfSave = await api(baseUrl, `/api/products/${updateTargetId}`, {
        method: 'PUT',
        body: { barcode: '7501234567891' },
        headers: authHeader,
      });
      assertEqual(selfSave.status, 200, 'F: re-saving its own barcode is not a false clash');

      // But taking someone else's barcode must be rejected.
      const clash = await api(baseUrl, `/api/products/${updateTargetId}`, {
        method: 'PUT',
        body: { barcode: '8901234567890' }, // already used by the Water Bottle from Scenario A
        headers: authHeader,
      });
      assertEqual(clash.status, 400, 'F: stealing another product\'s barcode is rejected');
    }

    console.log('\n─── Scenario G: barcode normalization preserves leading zeroes ───');
    {
      const created = await api(baseUrl, '/api/products', {
        method: 'POST',
        body: { category_id: 'cat-137', name: 'Zero Cola', price: 35, barcode: '  0012345000  ' },
        headers: authHeader,
      });
      assertEqual(created.status, 201, 'G: product with leading-zero barcode created');
      assertEqual(created.data.product.barcode, '0012345000', 'G: leading zeroes preserved while whitespace is trimmed');

      const lookup = await api(baseUrl, '/api/products?barcode=%200012345000%20', { headers: authHeader });
      assertEqual(lookup.status, 200, 'G: leading-zero lookup succeeds');
      assertEqual(lookup.data.products.length, 1, 'G: exactly one leading-zero product matches');
      assertEqual(lookup.data.products[0].id, created.data.product.id, 'G: correct leading-zero product returned');
    }

    console.log('\n─── Scenario H: invalid weighted metadata is rejected ───');
    {
      const invalidUnit = await api(baseUrl, '/api/products', {
        method: 'POST',
        body: { category_id: 'cat-137', name: 'Bulk Bad Unit', price: 10, sale_unit: 'stone' },
        headers: authHeader,
      });
      assertEqual(invalidUnit.status, 400, 'H: invalid sale_unit rejected');

      const invalidFlag = await api(baseUrl, `/api/products/${createdId}`, {
        method: 'PUT',
        body: { allow_fractional_quantity: 'yes' },
        headers: authHeader,
      });
      assertEqual(invalidFlag.status, 400, 'H: non-boolean fractional flag rejected');

      const invalidPrecision = await api(baseUrl, `/api/products/${createdId}`, {
        method: 'PUT',
        body: { weight_precision: 5 },
        headers: authHeader,
      });
      assertEqual(invalidPrecision.status, 400, 'H: out-of-range weight precision rejected');
    }

  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILED');
    process.exit(1);
  } else {
    console.log('ALL PASSED');
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
