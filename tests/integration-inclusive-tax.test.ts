/**
 * Integration Test: Inclusive Tax Correctness
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tax-incl-test-'));
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
    return originalLoad.apply(this, arguments);
};

const {
    initTestDb, createApp, startServer,
    seedOwnerUser, seedCategory, seedProduct,
    api, assert, assertEqual, getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

async function main() {
    console.log('Integration Test: Inclusive Tax Correctness');
    const db = initTestDb();

    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?)").run(now());
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_type', 'restaurant', ?)").run(now());
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('state_code', '27', ?)").run(now());

    const { authHeader } = seedOwnerUser(db);
    seedCategory(db, 'cat-tax', 'Tax Test Menu');
    // Seed an explicitly categorized inclusive product (5% tax, price 1000 inclusive).
    seedProduct(db, 'prod-incl', 'cat-tax', 'Inclusive Coffee', 1000, {
        tax_category_id: 'standard',
        tax_behavior: 'inclusive',
    });

    const app = createApp({
        '/api/orders': orderRoutes,
        '/api/bills': billRoutes,
    });
    const { baseUrl, server } = await startServer(app);

    try {
        // 1. Create order
        const createRes = await api(baseUrl, '/api/orders', {
            method: 'POST',
            body: { type: 'takeaway', items: [{ product_id: 'prod-incl', quantity: 1 }] },
            headers: authHeader,
        });
        assertEqual(createRes.status, 201, 'order created');
        const orderId = createRes.data.order.id;

        const initialTax = createRes.data.order.tax_amount;
        const initialTotal = createRes.data.order.total;
        const initialSubtotal = createRes.data.order.subtotal;

        assertEqual(initialSubtotal, 1000, 'subtotal = ₹1000');
        assertEqual(initialTotal, 1000, 'total = ₹1000 (inclusive tax should not increase total)');

        // 2. Apply 10% discount
        const discountRes = await api(baseUrl, `/api/orders/${orderId}/discount`, {
            method: 'PATCH',
            body: { discount_type: 'percentage', discount_value: 10 },
            headers: authHeader,
        });
        assertEqual(discountRes.data.order.total, 900, 'discounted total = 900');

    } finally {
        server.close();
        closeDatabase();
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { }
    }

    const { failed } = getResults();
    process.exit(failed === 0 ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
