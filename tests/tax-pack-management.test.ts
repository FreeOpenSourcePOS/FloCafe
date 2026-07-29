/**
 * Integration tests for Settings → Tax pack management.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/tax-pack-management.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateKeyPairSync, sign } = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tax-pack-manager-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => '2.4.0',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { calculateConfiguredChargeTaxes } = require('../main/services/tax');
const {
  installCatalogEntry,
} = require('../main/routes/tax-packs');
const {
  taxPackSha256,
} = require('../main/tax-packs/catalog');
const indiaPackDefinition = require('../main/tax-packs/in.json');

async function main() {
  console.log('Tax Pack Management Integration Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'tax-pack-products', 'Tax Pack Products');
  seedProduct(db, 'override-product', 'tax-pack-products', 'Override Product', 100, {
    tax_type: 'none',
    tax_category_id: null,
  });

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n1. Bundled packs are registered and readable');
    const listRes = await api(baseUrl, '/api/tax-packs', { headers: manager.authHeader });
    assertEqual(listRes.status, 200, 'manager can view installed packs');
    assertEqual(listRes.data.packs.length, 3, 'all three bundled packs are installed');
    const india = listRes.data.packs.find((pack: any) => pack.id === 'official-in');
    assert(!!india, 'India pack is listed');
    assertEqual(india.versions[0].version, '1.0.0', 'India pack version is shown');
    assertEqual(india.active_for_store, true, 'India pack is active for the India store');

    const detailRes = await api(baseUrl, '/api/tax-packs/official-in', { headers: manager.authHeader });
    assertEqual(detailRes.status, 200, 'manager can view active pack details');
    assert(detailRes.data.categories.length > 0, 'categories are available for reference');
    assert(detailRes.data.rules.length > 0, 'rules are available for reference');
    assertEqual(detailRes.data.active_version.validation.checks.length, 24, 'all 24 activation checks are reported');
    assertEqual(
      detailRes.data.active_version.validation.valid,
      true,
      `bundled pack passes activation validation: ${JSON.stringify(
        detailRes.data.active_version.validation.checks.filter((check: any) => !check.passed),
      )}`,
    );
    for (const packId of ['official-th', 'local-generic']) {
      const bundledDetail = await api(baseUrl, `/api/tax-packs/${packId}`, { headers: manager.authHeader });
      assertEqual(bundledDetail.status, 200, `${packId} details are readable`);
      assertEqual(
        bundledDetail.data.active_version.validation.checks.length,
        24,
        `${packId} reports all 24 activation checks`,
      );
      assertEqual(
        bundledDetail.data.active_version.validation.valid,
        true,
        `${packId} passes its bundled activation vectors`,
      );
    }

    console.log('\n2. Test calculation is available to managers');
    const calculationRes = await api(baseUrl, '/api/tax-packs/test-calculation', {
      method: 'POST',
      body: { category_id: 'standard', amount: '100', tax_behavior: 'exclusive' },
      headers: manager.authHeader,
    });
    assertEqual(calculationRes.status, 200, 'manager can run a test calculation');
    assertEqual(calculationRes.data.calculation.taxableBase, '100.00', 'test calculation returns the taxable base');
    assertEqual(calculationRes.data.calculation.taxAmount, '5.00', '₹100 standard category produces ₹5 tax');
    assertEqual(calculationRes.data.calculation.payableTotal, '105', 'test payable total is ₹105');

    console.log('\n3. Override mutations are owner-only');
    const managerCreate = await api(baseUrl, '/api/tax-packs/overrides', {
      method: 'POST',
      body: {
        entity_type: 'product',
        entity_id: 'override-product',
        category_id: 'standard',
      },
      headers: manager.authHeader,
    });
    assertEqual(managerCreate.status, 403, 'manager cannot create an override');

    const createOverride = await api(baseUrl, '/api/tax-packs/overrides', {
      method: 'POST',
      body: {
        entity_type: 'product',
        entity_id: 'override-product',
        category_id: 'standard',
      },
      headers: owner.authHeader,
    });
    assertEqual(createOverride.status, 201, 'owner can create a product override');
    const overrideId = createOverride.data.override.id;

    const duplicateOverride = await api(baseUrl, '/api/tax-packs/overrides', {
      method: 'POST',
      body: {
        entity_type: 'product',
        entity_id: 'override-product',
        category_id: 'standard',
      },
      headers: owner.authHeader,
    });
    assertEqual(duplicateOverride.status, 409, 'duplicate target overrides are rejected');

    console.log('\n4. Merchant override participates in checkout precedence');
    const orderWithOverride = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'override-product', quantity: 1 }],
      },
      headers: owner.authHeader,
    });
    assertEqual(orderWithOverride.status, 201, 'uncategorized product checks out through its merchant override');
    assertEqual(orderWithOverride.data.order.tax_amount, 5, 'override assigns the standard 5% category');
    const rawItemSnapshot = orderWithOverride.data.order.items[0].tax_snapshot;
    const itemSnapshot =
      typeof rawItemSnapshot === 'string' ? JSON.parse(rawItemSnapshot) : rawItemSnapshot;
    assertEqual(itemSnapshot.lines[0].categorySource, 'merchant_override', 'snapshot records merchant precedence source');
    assertEqual(itemSnapshot.merchantOverridesApplied[0].overrideId, overrideId, 'snapshot records exact override id');

    const updateOverride = await api(baseUrl, `/api/tax-packs/overrides/${overrideId}`, {
      method: 'PUT',
      body: { category_id: 'unclassified' },
      headers: owner.authHeader,
    });
    assertEqual(updateOverride.status, 200, 'owner can edit an override');

    const managerDelete = await api(baseUrl, `/api/tax-packs/overrides/${overrideId}`, {
      method: 'DELETE',
      headers: manager.authHeader,
    });
    assertEqual(managerDelete.status, 403, 'manager cannot reset an override');

    const deleteOverride = await api(baseUrl, `/api/tax-packs/overrides/${overrideId}`, {
      method: 'DELETE',
      headers: owner.authHeader,
    });
    assertEqual(deleteOverride.status, 200, 'owner can reset an override to official behavior');

    const orderWithoutOverride = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'override-product', quantity: 1 }],
      },
      headers: owner.authHeader,
    });
    assertEqual(orderWithoutOverride.status, 201, 'uncategorized checkout remains available after reset');
    assertEqual(orderWithoutOverride.data.order.tax_amount, 0, 'reset removes merchant category assignment');
    assert(!orderWithoutOverride.data.order.items[0].tax_snapshot, 'reset returns the product to the no-tax path');

    console.log('\n5. Charge categories persist and stay stable across every recompute path');
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_max_percentage', '100', datetime('now'))",
    ).run();
    const chargeOverrideIds: string[] = [];
    for (const entityType of ['packaging', 'delivery', 'service_charge']) {
      const chargeOverride = await api(baseUrl, '/api/tax-packs/overrides', {
        method: 'POST',
        body: {
          entity_type: entityType,
          entity_id: null,
          category_id: 'standard',
        },
        headers: owner.authHeader,
      });
      assertEqual(chargeOverride.status, 201, `owner can configure ${entityType} category`);
      chargeOverrideIds.push(chargeOverride.data.override.id);
    }
    const serviceChargeTax = calculateConfiguredChargeTaxes(
      { country: 'IN', business_type: 'restaurant', state_code: '27' },
      {
        service_charge: 20,
        service_charge_tax_category_id: 'standard',
      },
      null,
    );
    assertEqual(serviceChargeTax.taxAmount, 1, 'configured ₹20 service charge uses the same 5% engine path');
    assertEqual(
      JSON.parse(serviceChargeTax.snapshotJson[0]).chargeKind,
      'service_charge',
      'service charge snapshot identifies its charge kind',
    );

    const chargeOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        packaging_charge: 20,
        delivery_charge: 20,
        items: [{ product_id: 'override-product', quantity: 1 }],
      },
      headers: owner.authHeader,
    });
    assertEqual(chargeOrder.status, 201, 'order with configured charges is created');
    const chargeOrderId = chargeOrder.data.order.id;
    const firstChargeItemId = chargeOrder.data.order.items[0].id;
    assertEqual(chargeOrder.data.order.tax_amount, 2, 'two ₹20 charges add ₹2 tax');
    assertEqual(chargeOrder.data.order.total, 142, 'untaxed item plus configured charge tax total correctly');
    assertEqual(chargeOrder.data.order.packaging_tax_category_id, 'standard', 'packaging category is frozen on the order');
    assertEqual(chargeOrder.data.order.delivery_tax_category_id, 'standard', 'delivery category is frozen on the order');
    assertEqual(chargeOrder.data.order.service_charge_tax_category_id, 'standard', 'service category is frozen even when its amount is zero');
    const chargeSnapshots = typeof chargeOrder.data.order.tax_snapshot === 'string'
      ? JSON.parse(chargeOrder.data.order.tax_snapshot)
      : chargeOrder.data.order.tax_snapshot;
    assertEqual(chargeSnapshots.length, 2, 'only non-zero configured charges produce snapshots');
    assertEqual(
      chargeSnapshots.map((snapshot: any) => snapshot.chargeKind).sort().join(','),
      'delivery,packaging',
      'snapshot identifies both charge kinds',
    );

    const chargeOrderDiscount = await api(baseUrl, `/api/orders/${chargeOrderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 50 },
      headers: owner.authHeader,
    });
    assertEqual(chargeOrderDiscount.status, 200, 'order discount recomputes configured charge tax');
    assertEqual(chargeOrderDiscount.data.order.tax_amount, 2, 'order discount does not scale charge tax');
    assertEqual(chargeOrderDiscount.data.order.total, 92, 'discounted item plus unchanged charges total correctly');

    const addChargeItem = await api(baseUrl, `/api/orders/${chargeOrderId}/items`, {
      method: 'POST',
      body: { items: [{ product_id: 'override-product', quantity: 1 }] },
      headers: owner.authHeader,
    });
    assertEqual(addChargeItem.status, 200, 'add-item recompute succeeds with configured charges');
    const secondChargeItemId = addChargeItem.data.order.items.find(
      (item: any) => item.id !== firstChargeItemId,
    ).id;
    assertEqual(addChargeItem.data.order.tax_amount, 2, 'add-item recompute does not duplicate charge tax');
    assertEqual(addChargeItem.data.order.total, 142, 'add-item recompute reapplies the percentage item discount and retains charges');

    const cancelChargeItem = await api(baseUrl, `/api/orders/${chargeOrderId}/items/${secondChargeItemId}/cancel`, {
      method: 'PATCH',
      body: {},
      headers: owner.authHeader,
    });
    assertEqual(cancelChargeItem.status, 200, 'cancel recompute succeeds with configured charges');
    assertEqual(cancelChargeItem.data.order.tax_amount, 2, 'cancel recompute retains charge tax once');
    assertEqual(cancelChargeItem.data.order.total, 92, 'cancel recompute returns to one active item');

    const restoreChargeItem = await api(baseUrl, `/api/orders/${chargeOrderId}/items/${secondChargeItemId}/restore`, {
      method: 'PATCH',
      body: {},
      headers: owner.authHeader,
    });
    assertEqual(restoreChargeItem.status, 200, 'restore recompute succeeds with configured charges');
    assertEqual(restoreChargeItem.data.order.tax_amount, 2, 'restore recompute retains charge tax once');
    assertEqual(restoreChargeItem.data.order.total, 142, 'restore recompute returns to two active items with percentage discount');

    const itemChargeDiscount = await api(
      baseUrl,
      `/api/orders/${chargeOrderId}/items/${firstChargeItemId}/discount`,
      {
        method: 'PATCH',
        body: { discount_type: 'percentage', discount_value: 10 },
        headers: owner.authHeader,
      },
    );
    assertEqual(itemChargeDiscount.status, 200, 'item discount recompute succeeds with configured charges');
    const afterItemChargeDiscount = (await api(
      baseUrl,
      `/api/orders/${chargeOrderId}`,
      { headers: owner.authHeader },
    )).data.order;
    assertEqual(afterItemChargeDiscount.tax_amount, 2, 'item discount does not scale charge tax');
    assertEqual(afterItemChargeDiscount.total, 137, 'item discount and order discount preserve charge totals');

    const chargeBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: chargeOrderId },
      headers: owner.authHeader,
    });
    assertEqual(chargeBill.status, 201, 'bill generation copies the charge-tax rollup');
    assertEqual(chargeBill.data.bill.tax_amount, 2, 'generated bill retains charge tax');
    assertEqual(chargeBill.data.bill.total, 137, 'generated bill matches the order');

    const chargeBillDiscount = await api(baseUrl, `/api/bills/${chargeBill.data.bill.id}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 50 },
      headers: owner.authHeader,
    });
    assertEqual(chargeBillDiscount.status, 200, 'bill discount recomputes configured charges');
    assertEqual(chargeBillDiscount.data.bill.tax_amount, 2, 'bill discount leaves charge tax unscaled');
    assertEqual(chargeBillDiscount.data.bill.total, 137, 'bill discount scales items but not charges');

    for (const overrideIdToRemove of chargeOverrideIds) {
      const resetCharge = await api(baseUrl, `/api/tax-packs/overrides/${overrideIdToRemove}`, {
        method: 'DELETE',
        headers: owner.authHeader,
      });
      assertEqual(resetCharge.status, 200, 'charge category can return to the no-tax default');
    }
    const unconfiguredChargeOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        packaging_charge: 20,
        delivery_charge: 20,
        items: [{ product_id: 'override-product', quantity: 1 }],
      },
      headers: owner.authHeader,
    });
    assertEqual(unconfiguredChargeOrder.status, 201, 'unconfigured charge order remains valid');
    assertEqual(unconfiguredChargeOrder.data.order.tax_amount, 0, 'unconfigured charges remain untaxed');
    assertEqual(unconfiguredChargeOrder.data.order.total, 140, 'unconfigured charge total is unchanged');

    console.log('\n6. Activation/rollback are owner-gated and installed-only');
    const versionId = india.active_version_id;
    const managerActivate = await api(
      baseUrl,
      `/api/tax-packs/official-in/versions/${encodeURIComponent(versionId)}/activate`,
      { method: 'POST', body: {}, headers: manager.authHeader },
    );
    assertEqual(managerActivate.status, 403, 'manager cannot activate a pack');

    const ownerActivate = await api(
      baseUrl,
      `/api/tax-packs/official-in/versions/${encodeURIComponent(versionId)}/activate`,
      { method: 'POST', body: {}, headers: owner.authHeader },
    );
    assertEqual(ownerActivate.status, 200, 'owner can select an already-installed version');
    assertEqual(ownerActivate.data.changed, false, 'selecting the active version is a safe no-op');

    const rollbackRes = await api(baseUrl, '/api/tax-packs/official-in/rollback', {
      method: 'POST',
      body: {},
      headers: owner.authHeader,
    });
    assertEqual(rollbackRes.status, 400, 'rollback is blocked when no previous installed version exists');

    console.log('\n7. Every override mutation is audited');
    const auditRes = await api(baseUrl, '/api/tax-packs/audit', { headers: manager.authHeader });
    assertEqual(auditRes.status, 200, 'manager can view tax audit history');
    const actions = auditRes.data.audit.map((entry: any) => entry.action);
    assert(actions.includes('create_override'), 'create override audit exists');
    assert(actions.includes('update_override'), 'update override audit exists');
    assert(actions.includes('reset_override'), 'reset override audit exists');
    const createAudit = auditRes.data.audit.find((entry: any) => entry.action === 'create_override');
    assertEqual(createAudit.actor_name, 'Test Owner', 'audit identifies the acting user');

    console.log('\n8. Signed catalog packs install without activating');
    const managerInstall = await api(baseUrl, '/api/tax-packs/catalog/install', {
      method: 'POST',
      body: { pack_id: 'official-in', version: '1.1.0' },
      headers: manager.authHeader,
    });
    assertEqual(managerInstall.status, 403, 'manager cannot install a catalog pack');

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const downloadedPack = {
      ...indiaPackDefinition,
      version: '1.1.0',
      publishedAt: '2026-07-30',
    };
    const downloadedPackJson = JSON.stringify(downloadedPack, null, 2);
    const downloadedSignature = sign(
      null,
      Buffer.from(downloadedPackJson, 'utf8'),
      privateKey,
    ).toString('base64');
    const releaseTag = 'tax-pack-official-in-v1.1.0';
    const releaseBase = `https://github.com/FreeOpenSourcePOS/FloCafe/releases/download/${releaseTag}`;
    const catalogEntry = {
      id: downloadedPack.id,
      publisher: downloadedPack.publisher,
      country: downloadedPack.country,
      jurisdiction: downloadedPack.jurisdiction,
      version: downloadedPack.version,
      publishedAt: downloadedPack.publishedAt,
      minFloVersion: downloadedPack.minFloVersion,
      downloadUrl: `${releaseBase}/official-in-v1.1.0.json`,
      signatureUrl: `${releaseBase}/official-in-v1.1.0.json.sig`,
      digest: taxPackSha256(downloadedPackJson),
    };
    const fetchImpl = async (input: string | URL | Request) => new Response(
      String(input) === catalogEntry.downloadUrl ? downloadedPackJson : downloadedSignature,
      { status: 200 },
    );
    const installed = await installCatalogEntry(catalogEntry, {
      actorUserId: owner.userId,
      fetchImpl,
      publicKey,
    });
    assertEqual(installed.version, '1.1.0', 'verified downloaded version is installed');
    assertEqual(installed.validation.checks.length, 24, 'download uses the existing 24-check validation');
    assertEqual(installed.validation.valid, true, 'signed download passes all activation validation');

    const storedVersion = db.prepare(
      'SELECT status, digest, signature FROM country_pack_versions WHERE id = ?'
    ).get(installed.versionId);
    assertEqual(storedVersion.status, 'installed', 'downloaded version is installed, not active');
    assertEqual(storedVersion.digest, catalogEntry.digest, 'verified catalog digest is persisted');
    assertEqual(storedVersion.signature, downloadedSignature, 'detached signature is persisted');
    const unchangedActiveVersion = db.prepare(
      'SELECT active_version_id FROM country_packs WHERE id = ?'
    ).get('official-in');
    assertEqual(
      unchangedActiveVersion.active_version_id,
      versionId,
      'install does not implicitly activate the downloaded version',
    );
    const storedChildren = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM tax_categories WHERE pack_version_id = ?) AS categories,
        (SELECT COUNT(*) FROM tax_rules WHERE pack_version_id = ?) AS rules
    `).get(installed.versionId, installed.versionId);
    assertEqual(
      storedChildren.categories,
      downloadedPack.categories.length,
      'downloaded categories are installed',
    );
    assertEqual(storedChildren.rules, downloadedPack.rules.length, 'downloaded rules are installed');
    const installAudit = db.prepare(`
      SELECT audit.action, audit.actor_user_id
      FROM tax_config_audit AS audit
      WHERE audit.pack_version_id = ?
    `).get(installed.versionId);
    assertEqual(installAudit.action, 'install_downloaded_pack', 'download installation is audited');
    assertEqual(installAudit.actor_user_id, owner.userId, 'install audit identifies the owner');

    const incompatiblePack = {
      ...downloadedPack,
      version: '1.2.0',
      minFloVersion: '999.0.0',
    };
    const incompatiblePackJson = JSON.stringify(incompatiblePack);
    const incompatibleSignature = sign(
      null,
      Buffer.from(incompatiblePackJson, 'utf8'),
      privateKey,
    ).toString('base64');
    const incompatibleTag = 'tax-pack-official-in-v1.2.0';
    const incompatibleEntry = {
      ...catalogEntry,
      version: incompatiblePack.version,
      minFloVersion: incompatiblePack.minFloVersion,
      downloadUrl: `https://github.com/FreeOpenSourcePOS/FloCafe/releases/download/${incompatibleTag}/official-in-v1.2.0.json`,
      signatureUrl: `https://github.com/FreeOpenSourcePOS/FloCafe/releases/download/${incompatibleTag}/official-in-v1.2.0.json.sig`,
      digest: taxPackSha256(incompatiblePackJson),
    };
    const incompatibleFetch = async (input: string | URL | Request) => new Response(
      String(input) === incompatibleEntry.downloadUrl ? incompatiblePackJson : incompatibleSignature,
      { status: 200 },
    );
    let rejectedValidation: any = null;
    try {
      await installCatalogEntry(incompatibleEntry, {
        actorUserId: owner.userId,
        fetchImpl: incompatibleFetch,
        publicKey,
      });
    } catch (error) {
      rejectedValidation = error;
    }
    assertEqual(
      rejectedValidation?.statusCode,
      400,
      'a correctly signed pack still fails when the 24-check validation rejects it',
    );
    assert(
      rejectedValidation?.validation?.checks.some(
        (check: any) => check.id === 4 && check.passed === false,
      ),
      'the failed compatibility check is returned to the caller',
    );
    assertEqual(
      db.prepare('SELECT COUNT(*) AS count FROM country_pack_versions WHERE id = ?')
        .get('official-in@1.2.0').count,
      0,
      'failed validation leaves no installed version behind',
    );
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(56));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: any) => {
  console.error('Tax pack management test runner failed:', error);
  process.exit(1);
});
