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
  installAndActivateTestTaxPack,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { calculateConfiguredChargeTaxes, resolveTaxIdFormat, validateTaxRegistrationNumber, MAX_TAX_ID_LENGTH } = require('../main/services/tax');
const { getCountryByCode } = require('../main/countries');
const {
  installCatalogEntry,
  reinstallPackVersion,
  validationChecklist,
} = require('../main/routes/tax-packs');
const {
  taxPackSha256,
} = require('../main/tax-packs/catalog');
const {
  escPosToText,
  formatReceipt,
} = require('../main/printers/thermal');
const { LEGACY_TRUSTED_PACK_DIGESTS } = require('../main/routes/tax-packs');
const dualRatePackData = require('./fixtures/synthetic-dual-rate-pack.json');
const flatRatePackData = require('./fixtures/synthetic-flat-rate-pack.json');
// Synthetic stand-ins for the pre-signing-era "official-india"/"official-thailand"
// rows real customer databases still carry. Country/currency stay IN/INR and
// TH/THB so getActiveCountryPack() and ensure-country resolve them the same
// way; the digest is injected below instead of depending on real historical
// tax-pack content, so this test never needs actual GST/VAT data.
const testIndiaPack = { ...dualRatePackData, id: 'test-legacy-in-pack', country: 'IN', currency: 'INR', publisher: 'FreeOpenSourcePOS' };
const testThailandPack = { ...flatRatePackData, id: 'test-legacy-th-pack', country: 'TH', currency: 'THB', publisher: 'FreeOpenSourcePOS' };
LEGACY_TRUSTED_PACK_DIGESTS[testIndiaPack.id] = taxPackSha256(JSON.stringify(testIndiaPack));
LEGACY_TRUSTED_PACK_DIGESTS[testThailandPack.id] = taxPackSha256(JSON.stringify(testThailandPack));

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
    console.log('\n1. Fresh installs start generic; explicitly installed packs are readable');
    const freshListRes = await api(baseUrl, '/api/tax-packs', { headers: manager.authHeader });
    assertEqual(freshListRes.status, 200, 'manager can view installed packs');
    assertEqual(freshListRes.data.packs.length, 1, 'only the generic pack is preinstalled');
    assertEqual(freshListRes.data.packs[0].id, 'local-generic', 'the preinstalled pack is generic');
    assertEqual(freshListRes.data.packs[0].active_for_store, true, 'generic no-tax behavior is active');

    installAndActivateTestTaxPack(db, testIndiaPack);
    installAndActivateTestTaxPack(db, testThailandPack);
    // Tax calculation is intentionally zeroed while the merchant toggle is
    // off. Enable it here so the management assertions exercise the active
    // country-plugin path rather than the generic no-tax default.
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'taxes_enabled'").run();
    const listRes = await api(baseUrl, '/api/tax-packs', { headers: manager.authHeader });
    const installedPack = listRes.data.packs.find((pack: any) => pack.id === 'test-legacy-in-pack');
    assert(!!installedPack, 'legacy pack is listed');
    assertEqual(installedPack.versions[0].version, testIndiaPack.version, 'legacy pack version is shown');
    assertEqual(installedPack.active_for_store, true, 'legacy pack is active for its configured country');

    const detailRes = await api(baseUrl, '/api/tax-packs/test-legacy-in-pack', { headers: manager.authHeader });
    assertEqual(detailRes.status, 200, 'manager can view active pack details');
    assert(detailRes.data.categories.length > 0, 'categories are available for reference');
    assert(detailRes.data.rules.length > 0, 'rules are available for reference');
    assertEqual(detailRes.data.active_version.validation.checks.length, 25, 'all 25 activation checks are reported');
    assertEqual(detailRes.data.active_version.validation.valid, true,
      'an exact legacy unsigned artifact remains trusted after upgrade');
    for (const packId of ['test-legacy-th-pack', 'local-generic']) {
      const packDetail = await api(baseUrl, `/api/tax-packs/${packId}`, { headers: manager.authHeader });
      assertEqual(packDetail.status, 200, `${packId} details are readable`);
      assertEqual(
        packDetail.data.active_version.validation.checks.length,
        25,
        `${packId} reports all 25 activation checks`,
      );
      const failedCheckIds = packDetail.data.active_version.validation.checks
        .filter((check: any) => !check.passed)
        .map((check: any) => check.id)
        .join(',');
      assertEqual(failedCheckIds, '', `${packId} passes activation validation`);
    }

    const legacyPackRow = db.prepare(
      'SELECT * FROM country_pack_versions WHERE id = ?'
    ).get(`${testIndiaPack.id}@${testIndiaPack.version}`);
    const tamperedPackJson = JSON.stringify({ ...testIndiaPack, currency: 'USD' });
    const tamperedValidation = validationChecklist({
      ...legacyPackRow,
      pack_json: tamperedPackJson,
      digest: taxPackSha256(tamperedPackJson),
    });
    assertEqual(
      tamperedValidation.checks.find((check: any) => check.id === 6)?.passed,
      false,
      'an unsigned modified legacy artifact is still rejected',
    );

    db.prepare(`UPDATE products SET tax_category_id = NULL WHERE id = 'override-product'`).run();
    const enableLegacyPack = await api(baseUrl, '/api/tax-packs/ensure-country', {
      method: 'POST',
      body: { country: 'IN' },
      headers: owner.authHeader,
    });
    assertEqual(enableLegacyPack.status, 200, 'owner can enable taxes with the exact legacy pack');
    assertEqual(
      db.prepare(`SELECT tax_category_id FROM products WHERE id = 'override-product'`).get().tax_category_id,
      testIndiaPack.defaultCategories.product,
      'enabling taxes assigns the official default to uncategorized products',
    );
    db.prepare(`UPDATE products SET tax_category_id = NULL WHERE id = 'override-product'`).run();

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
      { country: 'IN', business_type: 'restaurant', state_code: '27', taxes_enabled: true },
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
    const versionId = installedPack.active_version_id;
    const managerActivate = await api(
      baseUrl,
      `/api/tax-packs/test-legacy-in-pack/versions/${encodeURIComponent(versionId)}/activate`,
      { method: 'POST', body: {}, headers: manager.authHeader },
    );
    assertEqual(managerActivate.status, 403, 'manager cannot activate a pack');

    const ownerActivate = await api(
      baseUrl,
      `/api/tax-packs/test-legacy-in-pack/versions/${encodeURIComponent(versionId)}/activate`,
      { method: 'POST', body: {}, headers: owner.authHeader },
    );
    assertEqual(ownerActivate.status, 200, 'owner can select an already-installed version');
    assertEqual(ownerActivate.data.changed, false, 'selecting the active version is a safe no-op');

    const rollbackRes = await api(baseUrl, '/api/tax-packs/test-legacy-in-pack/rollback', {
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
      body: { pack_id: 'test-legacy-in-pack', version: '1.1.0' },
      headers: manager.authHeader,
    });
    assertEqual(managerInstall.status, 403, 'manager cannot install a catalog pack');

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const downloadedPack = {
      ...testIndiaPack,
      version: '1.1.0',
      publishedAt: '2026-07-30',
    };
    const downloadedPackJson = JSON.stringify(downloadedPack, null, 2);
    const downloadedSignature = sign(
      null,
      Buffer.from(downloadedPackJson, 'utf8'),
      privateKey,
    ).toString('base64');
    const releaseTag = 'tax-pack-test-legacy-in-pack-v1.1.0';
    const releaseBase = `https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/${releaseTag}`;
    const catalogEntry = {
      id: downloadedPack.id,
      publisher: downloadedPack.publisher,
      country: downloadedPack.country,
      jurisdiction: downloadedPack.jurisdiction,
      version: downloadedPack.version,
      publishedAt: downloadedPack.publishedAt,
      minFloVersion: downloadedPack.minFloVersion,
      downloadUrl: `${releaseBase}/test-legacy-in-pack-v1.1.0.json`,
      signatureUrl: `${releaseBase}/test-legacy-in-pack-v1.1.0.json.sig`,
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
    assertEqual(installed.validation.checks.length, 25, 'download uses the existing 25-check validation');
    assertEqual(installed.validation.valid, true, 'signed download passes all activation validation');

    const storedVersion = db.prepare(
      'SELECT status, digest, signature FROM country_pack_versions WHERE id = ?'
    ).get(installed.versionId);
    assertEqual(storedVersion.status, 'installed', 'downloaded version is installed, not active');
    assertEqual(storedVersion.digest, catalogEntry.digest, 'verified catalog digest is persisted');
    assertEqual(storedVersion.signature, downloadedSignature, 'detached signature is persisted');
    const unchangedActiveVersion = db.prepare(
      'SELECT active_version_id FROM country_packs WHERE id = ?'
    ).get('test-legacy-in-pack');
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
    assertEqual(
      db.prepare('SELECT COUNT(*) AS count FROM installed_print_templates WHERE pack_version_id = ?')
        .get(installed.versionId).count,
      0,
      'plain legacy CountryPack installs without plugin print templates',
    );

    const gstPrintTemplate = {
      id: 'in.gst.tax-invoice.v1',
      displayName: 'India GST Tax Invoice',
      country: 'IN',
      jurisdiction: '*',
      paperColumns: [32, 36, 40, 42, 44, 48],
      renderer: {
        id: 'flocafe-thermal-receipt-template',
        version: 1,
      },
      templatePayload: {
        format: 'escpos-line-template-v1',
        widthProfiles: [32, 36, 40, 42, 44, 48].map((columns) => ({
          columns,
          layout: {
            lineItems: {
              gap: 1,
              columns: [
                { key: 'item', label: 'ITEM', width: columns <= 36 ? columns - 14 : columns - 20, align: 'left', wrap: true, maxLines: 2 },
                { key: 'quantity', label: 'QTY', width: columns <= 36 ? 3 : 4, align: 'right' },
                ...(columns >= 40 ? [{ key: 'rate', label: 'RATE', width: 7, align: 'right' }] : []),
                { key: 'amount', label: columns <= 32 ? 'AMT' : 'AMOUNT', width: columns <= 32 ? 9 : 10, align: 'right' },
              ],
              detailLines: ['addons', 'specialInstructions'],
            },
            taxSummary: {
              labelWidth: columns - 10,
              amountWidth: 9,
            },
          },
        })),
        header: {
          businessNameTransform: 'uppercase',
          taxTitleWhenTaxPresent: 'TAX INVOICE',
          titleWhenTaxAbsent: 'INVOICE',
        },
        fields: {
          taxRegistrationNumberLabel: 'GSTIN',
        },
        lineItems: {
          includeAddons: true,
          includeSpecialInstructions: true,
        },
        totals: {
          showSubtotal: true,
          showDiscount: 'when_non_zero',
          showTaxRegistrationNumber: 'when_tax_present_or_enabled',
          grandTotalLabel: 'GRAND TOTAL',
        },
        footer: {
          useConfiguredFooterNote: true,
          defaultMessage: 'Thank you for your business!',
          includePoweredByFloPOS: true,
        },
      },
    };
    const wrappedPack = {
      ...testIndiaPack,
      version: '1.3.0',
      publishedAt: '2026-08-01',
    };
    const wrappedArtifact = {
      schemaVersion: 1,
      artifactType: 'country-tax-pack-plugin',
      id: 'tax-pack-test-legacy-in-pack',
      displayName: 'Test India GST plugin',
      publisher: wrappedPack.publisher,
      version: wrappedPack.version,
      country: wrappedPack.country,
      jurisdiction: wrappedPack.jurisdiction,
      publishedAt: wrappedPack.publishedAt,
      minFloVersion: wrappedPack.minFloVersion,
      taxPack: wrappedPack,
      printTemplates: [gstPrintTemplate],
    };
    const wrappedArtifactJson = JSON.stringify(wrappedArtifact, null, 2);
    const wrappedSignature = sign(
      null,
      Buffer.from(wrappedArtifactJson, 'utf8'),
      privateKey,
    ).toString('base64');
    const wrappedTag = 'tax-pack-test-legacy-in-pack-v1.3.0';
    const wrappedBase = `https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/${wrappedTag}`;
    const wrappedEntry = {
      id: wrappedPack.id,
      publisher: wrappedPack.publisher,
      country: wrappedPack.country,
      jurisdiction: wrappedPack.jurisdiction,
      version: wrappedPack.version,
      publishedAt: wrappedPack.publishedAt,
      minFloVersion: wrappedPack.minFloVersion,
      downloadUrl: `${wrappedBase}/test-legacy-in-pack-v1.3.0.json`,
      signatureUrl: `${wrappedBase}/test-legacy-in-pack-v1.3.0.json.sig`,
      digest: taxPackSha256(wrappedArtifactJson),
    };
    const wrappedFetch = async (input: string | URL | Request) => new Response(
      String(input) === wrappedEntry.downloadUrl ? wrappedArtifactJson : wrappedSignature,
      { status: 200 },
    );
    const wrappedInstalled = await installCatalogEntry(wrappedEntry, {
      actorUserId: owner.userId,
      fetchImpl: wrappedFetch,
      publicKey,
    });
    assertEqual(wrappedInstalled.version, '1.3.0', 'wrapped plugin artifact installs its tax pack');
    const wrappedStoredVersion = db.prepare(
      'SELECT pack_json, digest, signature, status FROM country_pack_versions WHERE id = ?'
    ).get(wrappedInstalled.versionId);
    assertEqual(
      JSON.parse(wrappedStoredVersion.pack_json).id,
      wrappedPack.id,
      'wrapped artifact persists the inner CountryPack JSON',
    );
    assertEqual(wrappedStoredVersion.digest, wrappedEntry.digest, 'wrapped artifact digest is persisted');
    assertEqual(wrappedStoredVersion.signature, wrappedSignature, 'wrapped artifact signature is persisted');
    assertEqual(wrappedStoredVersion.status, 'installed', 'wrapped artifact install does not auto-activate');
    const templateRow = db.prepare(
      'SELECT * FROM installed_print_templates WHERE template_id = ?'
    ).get('in.gst.tax-invoice.v1');
    assert(!!templateRow, 'wrapped artifact persists print template metadata');
    assertEqual(templateRow.pack_version_id, wrappedInstalled.versionId, 'template is keyed to the installed pack version');
    assertEqual(templateRow.display_name, 'India GST Tax Invoice', 'template display name is persisted');
    assertEqual(JSON.parse(templateRow.paper_widths_json).join(','), 'cols-32,cols-36,cols-40,cols-42,cols-44,cols-48', 'template printable columns are persisted');
    assertEqual(JSON.parse(templateRow.renderer_json).id, 'flocafe-thermal-receipt-template', 'template renderer metadata is persisted');

    const templateListRes = await api(baseUrl, '/api/settings/bill-templates', {
      headers: manager.authHeader,
    });
    assertEqual(templateListRes.status, 200, 'manager can list available bill templates');
    assertEqual(templateListRes.data.core.join(','), 'classic,compact', 'core exposes only generic built-in templates');
    const pluginTemplate = templateListRes.data.plugins.find((entry: any) => entry.id === 'in.gst.tax-invoice.v1');
    assert(!!pluginTemplate, 'installed plugin template is exposed to settings');
    assertEqual(pluginTemplate.displayName, 'India GST Tax Invoice', 'settings exposes plugin template display name');
    assertEqual(pluginTemplate.paperColumns.join(','), '32,36,40,42,44,48', 'settings exposes plugin template printable columns');

    const rejectUnknownTemplate = await api(baseUrl, '/api/settings/bill_template', {
      method: 'PUT',
      body: { value: 'in.gst.missing-template' },
      headers: owner.authHeader,
    });
    assertEqual(rejectUnknownTemplate.status, 400, 'settings rejects uninstalled plugin template ids');
    const acceptPluginTemplate = await api(baseUrl, '/api/settings/bill_template', {
      method: 'PUT',
      body: { value: 'in.gst.tax-invoice.v1' },
      headers: owner.authHeader,
    });
    assertEqual(acceptPluginTemplate.status, 200, 'settings accepts installed plugin template ids');

    const pluginReceipt = escPosToText(formatReceipt(
      {
        order_number: 'ORD-GST-1',
        created_at: '2026-08-01T10:30:00.000Z',
        table: { name: 'T1' },
        items: [{
          product_name: 'Masala Chai',
          quantity: 2,
          total: 210,
          tax_breakdown: [
            { title: 'CGST', rate: 2.5, amount: 5 },
            { title: 'SGST', rate: 2.5, amount: 5 },
          ],
        }],
      },
      {
        bill_number: 'BILL-GST-1',
        subtotal: 200,
        discount_amount: 0,
        tax_amount: 10,
        total: 210,
        payment_details: [{ method: 'cash', amount: 210 }],
      },
      {
        name: 'Flo Test Cafe',
        address: 'Mumbai',
        phone: '9999999999',
        country: 'IN',
        currency_symbol: '₹',
        taxRegistrationNumber: '27ABCDE1234F1Z5',
        show_tax_id: true,
        show_tax_breakdown: true,
      },
      'in.gst.tax-invoice.v1',
      48,
      true,
    ));
    assert(pluginReceipt.includes('TAX INVOICE'), 'installed GST plugin template renders a tax invoice title');
    assert(pluginReceipt.includes('ITEM'), 'installed GST plugin template renders the plugin item-table layout');
    assert(pluginReceipt.includes('GSTIN: 27ABCDE1234F1Z5'), 'installed GST plugin template renders GSTIN');
    assert(pluginReceipt.includes('CGST @2.5%'), 'installed GST plugin template renders tax components');
    assert(pluginReceipt.includes('GRAND TOTAL'), 'installed GST plugin template renders plugin grand total label');

    const widthProfileWarnings: any[] = [];
    const exactWidthReceipt = escPosToText(formatReceipt(
      {
        order_number: 'ORD-GST-EXACT',
        created_at: '2026-08-01T10:30:00.000Z',
        items: [{ product_name: 'Exact Width Tea', quantity: 1, total: 100 }],
      },
      { bill_number: 'BILL-GST-EXACT', subtotal: 95, tax_amount: 5, total: 100 },
      { name: 'Flo Test Cafe', country: 'IN', currency_symbol: '₹', show_tax_breakdown: true },
      'in.gst.tax-invoice.v1',
      42,
      true,
      false,
      'full',
      widthProfileWarnings,
    ));
    assert(exactWidthReceipt.includes('TAX INVOICE'), 'plugin renderer supports an exact 42-column profile');
    assertEqual(widthProfileWarnings.length, 0, 'exact plugin width profile does not warn');

    const smallerWidthReceipt = escPosToText(formatReceipt(
      {
        order_number: 'ORD-GST-SMALLER',
        created_at: '2026-08-01T10:30:00.000Z',
        items: [{ product_name: 'Nearest Smaller Width Tea', quantity: 1, total: 100 }],
      },
      { bill_number: 'BILL-GST-SMALLER', subtotal: 95, tax_amount: 5, total: 100 },
      { name: 'Flo Test Cafe', country: 'IN', currency_symbol: '₹', show_tax_breakdown: true },
      'in.gst.tax-invoice.v1',
      46,
      true,
    ));
    assert(smallerWidthReceipt.includes('-'.repeat(44)), 'plugin renderer uses nearest smaller width profile instead of squeezing 48 columns');

    for (const columns of [32, 36, 40, 42, 44, 48]) {
      const receipt = escPosToText(formatReceipt(
        {
          order_number: `ORD-GST-${columns}`,
          created_at: '2026-08-01T10:30:00.000Z',
          items: [{ product_name: 'Long Named Width Profile Tea', quantity: 1, total: 100 }],
        },
        { bill_number: `BILL-GST-${columns}`, subtotal: 95, tax_amount: 5, total: 100 },
        { name: 'Flo Test Cafe', country: 'IN', currency_symbol: '₹', show_tax_breakdown: true },
        'in.gst.tax-invoice.v1',
        columns,
        true,
      ));
      const contentLines = receipt.split('\n').filter((line) => line.length > 0);
      assert(contentLines.every((line) => line.length <= columns), `plugin renderer keeps ${columns}-column profile within printable width`);
    }

    console.log('\n8b. Reinstalling a plugin repairs a missing billing template without changing its version');
    db.prepare('DELETE FROM installed_print_templates WHERE pack_version_id = ?').run(wrappedInstalled.versionId);
    assertEqual(
      db.prepare('SELECT COUNT(*) AS count FROM installed_print_templates WHERE pack_version_id = ?')
        .get(wrappedInstalled.versionId).count,
      0,
      'simulated desync: the billing template row is gone even though the pack version is still installed',
    );
    const missingTemplateRes = await api(baseUrl, '/api/settings/bill-templates', { headers: manager.authHeader });
    assert(
      !missingTemplateRes.data.plugins.some((entry: any) => entry.id === 'in.gst.tax-invoice.v1'),
      'billing template is not exposed to settings while its row is missing',
    );

    const reinstallCatalog = {
      schemaVersion: 1,
      generatedAt: '2026-08-01T00:00:00.000Z',
      packs: [wrappedEntry],
    };
    const reinstallCatalogUrl = `${wrappedBase}/reinstall-catalog.json`;
    const reinstallReleasesUrl = 'https://api.github.com/repos/FreeOpenSourcePOS/FloCafe-Plugins/releases?per_page=100&page=1';
    const reinstallFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url === reinstallReleasesUrl) {
        return new Response(JSON.stringify([{
          tag_name: wrappedTag,
          html_url: `https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/tag/${wrappedTag}`,
          draft: false,
          assets: [{ name: 'catalog.json', browser_download_url: reinstallCatalogUrl }],
        }]), { status: 200 });
      }
      if (url === reinstallCatalogUrl) return new Response(JSON.stringify(reinstallCatalog), { status: 200 });
      if (url === wrappedEntry.downloadUrl) return new Response(wrappedArtifactJson, { status: 200 });
      if (url === wrappedEntry.signatureUrl) return new Response(wrappedSignature, { status: 200 });
      return new Response('', { status: 404 });
    };
    const reinstalled = await reinstallPackVersion(
      wrappedInstalled.packId,
      wrappedInstalled.versionId,
      { actorUserId: owner.userId, fetchImpl: reinstallFetch, publicKey },
    );
    assertEqual(reinstalled.version, '1.3.0', 'reinstall keeps the same installed version, it does not upgrade');
    assertEqual(reinstalled.templateCount, 1, 'reinstall reports the restored template count');
    const repairedTemplateRow = db.prepare(
      'SELECT * FROM installed_print_templates WHERE template_id = ?'
    ).get('in.gst.tax-invoice.v1');
    assert(!!repairedTemplateRow, 'reinstall re-creates the missing billing template row');
    assertEqual(repairedTemplateRow.pack_version_id, wrappedInstalled.versionId, 'restored template is keyed to the same pack version');
    const repairedChildren = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM tax_categories WHERE pack_version_id = ?) AS categories,
        (SELECT COUNT(*) FROM tax_rules WHERE pack_version_id = ?) AS rules
    `).get(wrappedInstalled.versionId, wrappedInstalled.versionId);
    assertEqual(repairedChildren.categories, wrappedPack.categories.length, 'reinstall does not duplicate categories');
    assertEqual(repairedChildren.rules, wrappedPack.rules.length, 'reinstall does not duplicate rules');
    const repairedTemplateListRes = await api(baseUrl, '/api/settings/bill-templates', { headers: manager.authHeader });
    const repairedPluginTemplate = repairedTemplateListRes.data.plugins.find((entry: any) => entry.id === 'in.gst.tax-invoice.v1');
    assert(!!repairedPluginTemplate, 'billing template is exposed to settings again after reinstall');
    const reinstallAudit = db.prepare(`
      SELECT action, actor_user_id FROM tax_config_audit
      WHERE pack_version_id = ? AND action = 'reinstall_pack'
    `).get(wrappedInstalled.versionId);
    assert(!!reinstallAudit, 'reinstall is audited');
    assertEqual(reinstallAudit.actor_user_id, owner.userId, 'reinstall audit identifies the acting user');

    const genericPack = db.prepare(
      "SELECT active_version_id FROM country_packs WHERE id = 'local-generic'"
    ).get() as { active_version_id: string };
    let manualReinstallRejected = false;
    try {
      await reinstallPackVersion('local-generic', genericPack.active_version_id, {
        actorUserId: owner.userId,
        fetchImpl: reinstallFetch,
        publicKey,
      });
    } catch (error: any) {
      manualReinstallRejected = error.statusCode === 400;
    }
    assert(manualReinstallRejected, 'reinstalling a local/manual pack is rejected, it has nothing to redownload');

    db.prepare("UPDATE country_pack_versions SET status = 'revoked' WHERE id = ?").run(wrappedInstalled.versionId);
    const rejectRevokedTemplate = await api(baseUrl, '/api/settings/bill_template', {
      method: 'PUT',
      body: { value: 'in.gst.tax-invoice.v1' },
      headers: owner.authHeader,
    });
    assertEqual(rejectRevokedTemplate.status, 400, 'settings rejects plugin templates from unusable versions');
    const fallbackReceipt = escPosToText(formatReceipt(
      {
        order_number: 'ORD-GST-2',
        created_at: '2026-08-01T10:30:00.000Z',
        items: [{ product_name: 'Plain Tea', quantity: 1, total: 100 }],
      },
      { bill_number: 'BILL-GST-2', subtotal: 100, tax_amount: 0, total: 100 },
      { name: 'Flo Test Cafe', country: 'IN', currency_symbol: '₹' },
      'in.gst.tax-invoice.v1',
      48,
      true,
    ));
    assert(!fallbackReceipt.includes('TAX INVOICE'), 'unusable plugin template falls back to a core receipt renderer');
    assert(fallbackReceipt.includes('TOTAL'), 'fallback core receipt remains printable');

    // Regression: the activation vector check must never be keyed off a
    // hardcoded list of known pack ids -- a genuinely new pack (a real
    // country never bundled with the app) must be able to pass activation
    // validation on its own declared data, or the entire signed-catalog
    // download feature can only ever "install" versions of packs that
    // already shipped in the app.
    const newCountryPack = {
      ...testIndiaPack,
      id: 'brand-new-country-pack',
      publisher: 'some-third-party',
      version: '1.0.0',
      publishedAt: '2026-07-30',
    };
    const newCountryPackJson = JSON.stringify(newCountryPack, null, 2);
    const newCountrySignature = sign(
      null,
      Buffer.from(newCountryPackJson, 'utf8'),
      privateKey,
    ).toString('base64');
    const newCountryTag = 'tax-pack-brand-new-country-pack-v1.0.0';
    const newCountryBase = `https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/${newCountryTag}`;
    const newCountryEntry = {
      id: newCountryPack.id,
      publisher: newCountryPack.publisher,
      country: newCountryPack.country,
      jurisdiction: newCountryPack.jurisdiction,
      version: newCountryPack.version,
      publishedAt: newCountryPack.publishedAt,
      minFloVersion: newCountryPack.minFloVersion,
      downloadUrl: `${newCountryBase}/brand-new-country-pack-v1.0.0.json`,
      signatureUrl: `${newCountryBase}/brand-new-country-pack-v1.0.0.json.sig`,
      digest: taxPackSha256(newCountryPackJson),
    };
    const newCountryFetch = async (input: string | URL | Request) => new Response(
      String(input) === newCountryEntry.downloadUrl ? newCountryPackJson : newCountrySignature,
      { status: 200 },
    );
    const newCountryInstalled = await installCatalogEntry(newCountryEntry, {
      actorUserId: owner.userId,
      fetchImpl: newCountryFetch,
      publicKey,
    });
    assertEqual(
      newCountryInstalled.validation.valid,
      true,
      'a genuinely new pack id passes activation validation on its own declared data',
    );

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
    const incompatibleTag = 'tax-pack-test-legacy-in-pack-v1.2.0';
    const incompatibleEntry = {
      ...catalogEntry,
      version: incompatiblePack.version,
      minFloVersion: incompatiblePack.minFloVersion,
      downloadUrl: `https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/${incompatibleTag}/test-legacy-in-pack-v1.2.0.json`,
      signatureUrl: `https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/${incompatibleTag}/test-legacy-in-pack-v1.2.0.json.sig`,
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
        .get('test-legacy-in-pack@1.2.0').count,
      0,
      'failed validation leaves no installed version behind',
    );

    console.log('\n9. resolveTaxIdFormat() versions registration-number format with the active country pack (#393)');
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'taxes_enabled'").run();
    // getActiveCountryPack() picks the most-recently-updated 'active' pack
    // per country; only one IN pack may be active at a time for these
    // assertions to be unambiguous. test-legacy-in-pack (installed in step 1
    // and touched again in step 8b) is still active at this point — revoke
    // every IN pack before each install below so exactly one is active.
    const revokeAllInPacks = () => db.prepare("UPDATE country_packs SET status = 'revoked' WHERE country = 'IN'").run();

    revokeAllInPacks();
    const noFormatPack = {
      ...dualRatePackData,
      id: 'test-in-no-format-pack',
      country: 'IN',
      currency: 'INR',
      publisher: 'FreeOpenSourcePOS',
    };
    installAndActivateTestTaxPack(db, noFormatPack);
    const staticFormat = getCountryByCode('IN')?.taxIdFormat;
    assert(!!staticFormat, 'static countries.ts declares a taxIdFormat for IN (test precondition)');
    assertEqual(
      JSON.stringify(resolveTaxIdFormat('IN')),
      JSON.stringify(staticFormat),
      'a v1 pack lacking registrationNumberFormat falls back to the static countries.ts format',
    );

    revokeAllInPacks();
    const overrideFormat = { pattern: '^TESTPACKFMT-[0-9]{4}$', description: 'Test pack override format' };
    const formatOverridePack = {
      ...dualRatePackData,
      id: 'test-in-format-override-pack',
      country: 'IN',
      currency: 'INR',
      publisher: 'FreeOpenSourcePOS',
      registrationNumberFormat: overrideFormat,
    };
    installAndActivateTestTaxPack(db, formatOverridePack);
    assertEqual(
      JSON.stringify(resolveTaxIdFormat('IN')),
      JSON.stringify(overrideFormat),
      'an active pack declaring registrationNumberFormat takes priority over the static countries.ts fallback',
    );
    assertEqual(
      validateTaxRegistrationNumber('IN', 'TESTPACKFMT-1234').valid,
      true,
      'validateTaxRegistrationNumber accepts a matching value under the length bound',
    );
    assertEqual(
      validateTaxRegistrationNumber('IN', 'a'.repeat(MAX_TAX_ID_LENGTH + 1)).valid,
      false,
      'validateTaxRegistrationNumber rejects an over-length value before the pack-declared regex runs (ReDoS bound)',
    );

    revokeAllInPacks();
    assertEqual(
      resolveTaxIdFormat('TH'),
      null,
      'a country with neither a pack format nor a static format resolves to null (pass-through, never rejects)',
    );

    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'taxes_enabled'").run();
    assertEqual(
      resolveTaxIdFormat('IN'),
      null,
      'resolveTaxIdFormat never enforces a pattern while the taxes_enabled toggle is off',
    );
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'taxes_enabled'").run();
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
