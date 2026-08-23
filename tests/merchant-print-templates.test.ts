/**
 * Merchant print template model tests (#447, epic #438).
 *
 * Covers:
 *   1. Kernel validation: golden fixtures pass; every negative fixture and
 *      the size cap fail with actionable errors (fail-closed unknown major,
 *      unknown blocks/fields, non-object roots, duplicates, oversized).
 *   2. applyMerchantTemplate semantics: identity, reordering, visibility,
 *      label variants; input document purity.
 *   3. Migration v72: fresh-install schema + idempotent structured upgrade of
 *      the legacy bill_template setting (core + pack legacy values), with the
 *      upgrade-path simulation per repo migration conventions.
 *   4. Selection identity: structured parse/serialize roundtrip, legacy bare
 *      values, merchant availability (active rows only).
 *   5. CRUD lifecycle via the real Express routes (supertest): validation
 *      gate, checksum verification, activate/archive/rollback, owner-only.
 *   6. Render path: an active merchant template renders through the document
 *      pipeline byte-identically to the plain classic document render at
 *      every tested width (parity harness merchant-template mode lives in
 *      print-parity.test.ts).
 *
 * Run: npx ts-node --transpile-only -P tests/tsconfig.json tests/merchant-print-templates.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock electron before importing any app modules.
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-merchant-templates-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-for-merchant-print-templates';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  MAX_MERCHANT_TEMPLATE_PAYLOAD_BYTES,
  MERCHANT_TEMPLATE_FORMAT,
  MERCHANT_TEMPLATE_SCHEMA_VERSION,
  applyMerchantTemplate,
  buildBillDocument,
  getBlock,
  validateMerchantTemplate,
  validateMerchantTemplateText,
} from '../shared/print';
import { renderClassicReceiptViaDocument } from '../main/printers/document-classic';
import { escPosToText, formatReceipt } from '../main/printers/thermal';
import {
  parseBillTemplateSelection,
  serializeBillTemplateSelection,
  upgradeBillTemplateValue,
} from '../main/services/print-templates';
import { buildParityFixtures } from './print-parity.test';

let passed = 0;
function ok(message: string): void {
  passed++;
  console.log(`  ✓ ${message}`);
}

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/merchant-templates');

function loadFixture(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, relative), 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. Kernel validation
// ---------------------------------------------------------------------------

console.log('\n▶ Validation: golden fixtures');
{
  const golden = loadFixture('golden-receipt-v1.json');
  const result = validateMerchantTemplateText(JSON.stringify(golden));
  assert(result.ok, `golden-receipt-v1 validates (${result.ok ? '' : result.errors.join('; ')})`);
  assert.equal(result.ok && result.payload.format, MERCHANT_TEMPLATE_FORMAT);
  assert.equal(result.ok && result.payload.schemaVersion, MERCHANT_TEMPLATE_SCHEMA_VERSION);
  assert.equal(result.ok && result.payload.blocks.length, 8, 'all eight v1 block kinds present');
  ok('golden-receipt-v1.json validates');

  const labeled = validateMerchantTemplateText(
    JSON.stringify(loadFixture('golden-receipt-labeled-v1.json')),
  );
  assert(labeled.ok, `golden-receipt-labeled-v1 validates (${labeled.ok ? '' : labeled.errors.join('; ')})`);
  ok('golden-receipt-labeled-v1.json validates');
}

console.log('\n▶ Validation: negative fixtures');
{
  const expectations: Array<[string, string]> = [
    ['negative/non-object-root.json', 'must be a JSON object'],
    ['negative/unknown-format.json', 'root.format'],
    ['negative/unknown-schema-major.json', 'unsupported schema version'],
    ['negative/unknown-document-type.json', 'unsupported document type'],
    ['negative/unknown-root-field.json', 'unknown field "renderer"'],
    ['negative/duplicate-block.json', 'duplicate block "totals"'],
    ['negative/empty-blocks.json', 'non-empty array'],
    ['negative/non-string-label.json', 'expected a literal string'],
    ['negative/unknown-block-kind.json', 'unknown block kind'],
    ['negative/non-object-block.json', 'each block entry must be a JSON object'],
    ['negative/non-boolean-visible.json', 'expected a boolean'],
  ];
  for (const [fixture, expectedFragment] of expectations) {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, fixture), 'utf8');
    const result = validateMerchantTemplateText(raw);
    assert(!result.ok, `${fixture}: rejected`);
    assert(
      result.errors.some((message) => message.includes(expectedFragment) || message.toLowerCase().includes(expectedFragment.toLowerCase())),
      `${fixture}: actionable error mentions "${expectedFragment}" — got: ${result.errors.join(' | ')}`,
    );
  }
  ok('per-rule negative fixtures all rejected with actionable errors');

  const labelKeys = validateMerchantTemplateText(
    JSON.stringify(loadFixture('negative/unknown-label-field.json')),
  );
  assert(!labelKeys.ok);
  assert(
    labelKeys.errors.some((message) => message.includes('unknown label field')),
    `internal i18n-style keys rejected as label fields — got: ${labelKeys.errors.join(' | ')}`,
  );
  ok('internal translation keys are never accepted as template label fields');
}

console.log('\n▶ Validation: size cap and misc');
{
  const oversized = JSON.stringify({
    format: MERCHANT_TEMPLATE_FORMAT,
    documentType: 'receipt',
    schemaVersion: 1,
    blocks: [{ kind: 'totals', labels: { grandTotal: 'x'.repeat(MAX_MERCHANT_TEMPLATE_PAYLOAD_BYTES) } }],
  });
  const result = validateMerchantTemplateText(oversized);
  assert(!result.ok, 'oversized payload rejected');
  assert(result.errors[0].includes('bytes'), 'size error states byte counts');
  ok(`payloads above ${MAX_MERCHANT_TEMPLATE_PAYLOAD_BYTES} bytes are rejected`);

  assert(!validateMerchantTemplateText('{not json').ok, 'malformed JSON rejected');
  assert(!validateMerchantTemplateText('null').ok, 'null root rejected');
  assert(!validateMerchantTemplateText('"classic"').ok, 'string root rejected');
  ok('non-object roots and malformed JSON fail closed');
}

// ---------------------------------------------------------------------------
// 2. applyMerchantTemplate semantics
// ---------------------------------------------------------------------------

console.log('\n▶ applyMerchantTemplate');
{
  const { order, bill, business } = buildParityFixtures();
  // Minimal pure context mirroring the parity harness usage.
  const printContext = {
    columns: 42,
    languages: ['en'] as const,
    baseDirection: 'ltr' as const,
    locale: 'en-IN',
    currencySymbol: '₹',
    trimDecimals: false,
    resolveLabel: (conceptId: string, language: string) => `${conceptId}[${language}]`,
  };
  const document = buildBillDocument(require('../main/printers/document-classic').buildBillPrintData(order, bill, business, false), printContext);

  const golden = validateMerchantTemplate(loadFixture('golden-receipt-v1.json'));
  assert(golden.ok);
  const applied = applyMerchantTemplate(document, golden.payload);
  assert.deepEqual(applied.blocks.map((block) => block.kind), document.blocks.map((block) => block.kind));
  assert.deepEqual(applied.blocks, document.blocks as any, 'identity template preserves blocks verbatim');
  ok('canonical all-blocks template is an identity transform');

  const labeled = validateMerchantTemplate(loadFixture('golden-receipt-labeled-v1.json'));
  assert(labeled.ok);
  const styled = applyMerchantTemplate(document, labeled.payload);
  assert.deepEqual(styled.blocks.map((block) => block.kind),
    ['document-meta', 'item-table', 'totals', 'payments', 'message'],
    'template order wins; hidden and omitted blocks dropped');
  assert.equal(getBlock(styled, 'tax-breakdown'), undefined, 'visible:false drops tax breakdown');
  assert.equal(getBlock(styled, 'totals')!.grandTotal.label.primary, 'AMOUNT DUE');
  assert.equal(getBlock(styled, 'item-table')!.header.item.primary, 'Product');
  assert.equal(getBlock(styled, 'document-meta')!.title.secondary, 'SALES RECEIPT',
    'label variants replace every language variant with the merchant literal');
  ok('reordering, visibility, and label variants apply semantically');

  assert.equal(getBlock(document, 'totals')!.grandTotal.label.primary, 'print.grandTotal[en]');
  ok('input document is never mutated (purity)');
}

// ---------------------------------------------------------------------------
// 3. Migration v72 (fresh install + legacy upgrade paths)
// ---------------------------------------------------------------------------

const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
try {
  initDatabase();
} catch (error: any) {
  if (error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION')) {
    console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
    process.exit(77);
  }
  throw error;
}

console.log('\n▶ Migration v72: fresh install');
{
  const db = getDatabase();
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='merchant_print_templates'`).get() as any;
  assert(table, 'merchant_print_templates created on a fresh install');
  for (const column of [
    'id', 'business_id', 'name', 'origin', 'derived_from', 'document_type', 'schema_version',
    'payload_json', 'status', 'previous_payload_json', 'checksum', 'created_by', 'updated_by',
    'created_at', 'updated_at',
  ]) {
    assert(table.sql.includes(column), `column ${column} present`);
  }
  ok('table schema matches the ideal fresh-install shape (both paths share MIGRATIONS)');

  const stored = db.prepare(`SELECT value FROM settings WHERE key='bill_template'`).get() as any;
  assert.deepEqual(JSON.parse(stored.value), { source: 'core', id: 'classic' },
    'seeded legacy bill_template value upgraded to the structured selection');
  ok('bill_template setting upgraded to structured JSON on fresh installs');
}

console.log('\n▶ Migration v72: legacy value upgrade (idempotent rerun)');
{
  const db = getDatabase();
  // Simulate a pre-#447 database: legacy core value plus an installed pack
  // template selected by bare id. Rewind user_version so v72 re-runs.
  db.prepare(`INSERT INTO country_packs (id, publisher, country, jurisdiction, status)
              VALUES ('pack-test', 'test', 'IN', 'central', 'installed')
              ON CONFLICT(id) DO NOTHING`).run();
  db.prepare(`INSERT INTO country_pack_versions (id, pack_id, version, schema_version, manifest_json, pack_json, effective_from, min_flo_version, published_at, status)
              VALUES ('ver-test', 'pack-test', '1', 1, '{}', '{}', '2026-01-01', '0.0.0', '2026-01-01', 'active')
              ON CONFLICT(id) DO NOTHING`).run();
  db.prepare(`INSERT OR REPLACE INTO installed_print_templates
              (template_id, pack_id, pack_version_id, country, jurisdiction, display_name, paper_widths_json, renderer_json, template_payload_json, status)
              VALUES ('in-pack-receipt', 'pack-test', 'ver-test', 'IN', 'central', 'Pack receipt', '["cols-48"]', '{}', '{}', 'installed')`).run();
  db.prepare(`UPDATE settings SET value='compact' WHERE key='bill_template'`).run();
  db.pragma('user_version = 71');
  closeDatabase();

  initDatabase();
  const upgradedDb = getDatabase();
  const stored = upgradedDb.prepare(`SELECT value FROM settings WHERE key='bill_template'`).get() as any;
  assert.deepEqual(JSON.parse(stored.value), { source: 'core', id: 'compact' });
  ok('legacy bare core value upgraded transparently');

  upgradedDb.prepare(`UPDATE settings SET value='in-pack-receipt' WHERE key='bill_template'`).run();
  upgradedDb.pragma('user_version = 71');
  closeDatabase();

  initDatabase();
  const packDb = getDatabase();
  const packStored = packDb.prepare(`SELECT value FROM settings WHERE key='bill_template'`).get() as any;
  assert.deepEqual(JSON.parse(packStored.value), { source: 'pack', id: 'in-pack-receipt' });
  ok('legacy bare pack template id upgraded to the structured pack selection');

  // Idempotency: already-structured values must survive another rerun.
  packDb.pragma('user_version = 71');
  closeDatabase();
  initDatabase();
  const finalDb = getDatabase();
  const finalStored = finalDb.prepare(`SELECT value FROM settings WHERE key='bill_template'`).get() as any;
  assert.deepEqual(JSON.parse(finalStored.value), { source: 'pack', id: 'in-pack-receipt' });
  ok('migration is idempotent for already-structured values');
}

// ---------------------------------------------------------------------------
// 4. Selection identity
// ---------------------------------------------------------------------------

console.log('\n▶ Selection identity (structured, legacy-compatible)');
{
  assert.deepEqual(parseBillTemplateSelection('classic'), { source: 'core', id: 'classic' });
  assert.deepEqual(parseBillTemplateSelection('COMPACT'), { source: 'core', id: 'compact' });
  assert.deepEqual(parseBillTemplateSelection('in-pack-receipt'), { source: 'pack', id: 'in-pack-receipt' });
  assert.deepEqual(
    parseBillTemplateSelection('{"source":"merchant","id":"abc"}'),
    { source: 'merchant', id: 'abc' },
    'structured JSON strings parse');
  assert.deepEqual(
    parseBillTemplateSelection({ source: 'core', id: 'classic' }),
    { source: 'core', id: 'classic' },
    'structured objects parse directly');
  assert.equal(parseBillTemplateSelection('no-such-template'), null);
  assert.equal(parseBillTemplateSelection(''), null);
  assert.equal(parseBillTemplateSelection(undefined), null);
  assert.equal(parseBillTemplateSelection({ source: 'cloud', id: 'x' }), null);
  ok('legacy bare values, structured forms, and rejection cases behave');

  assert.equal(serializeBillTemplateSelection({ source: 'core', id: 'classic' }),
    '{"source":"core","id":"classic"}');
  assert.deepEqual(
    parseBillTemplateSelection(serializeBillTemplateSelection({ source: 'merchant', id: 'm-1' })),
    { source: 'merchant', id: 'm-1' });
  ok('serialize -> parse roundtrips');

  assert.equal(upgradeBillTemplateValue('classic'), '{"source":"core","id":"classic"}');
  assert.equal(upgradeBillTemplateValue({ source: 'pack', id: 'p' }), '{"source":"pack","id":"p"}');
  assert.equal(upgradeBillTemplateValue('nope'), null);
  ok('writer-side upgrade produces canonical persistence form');

  assert.equal(parseBillTemplateSelection('00000000-0000-0000-0000-000000000001'), null,
    'unpersisted merchant ids resolve to nothing');
  ok('unknown merchant ids do not resolve');
}

// ---------------------------------------------------------------------------
// 5. CRUD lifecycle over HTTP (owner role)
// ---------------------------------------------------------------------------

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { getJWTSecret } = require('../main/routes/auth');
const { printTemplateRoutes } = require('../main/routes/print-templates');

const app = express();
app.use(express.json());
app.use((req: any, res: any, next: any) => {
  if (!req.path.startsWith('/api')) { next(); return; }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});
// Ephemeral supertest harness: rate limiting is applied by the production router itself.
// codeql[js/missing-rate-limiting]
app.use('/api/print-templates', printTemplateRoutes);

function authHeaderFor(role: string): string {
  return `Bearer ${jwt.sign({ userId: `actor-${role}`, role }, getJWTSecret(), { expiresIn: '1h' })}`;
}
const OWNER = authHeaderFor('owner');
const CASHIER = authHeaderFor('cashier');

const PAYLOAD_V1 = loadFixture('golden-receipt-v1.json');
const PAYLOAD_LABELED = loadFixture('golden-receipt-labeled-v1.json');

async function runLifecycle(): Promise<void> {
  console.log('\n▶ CRUD API: validation gate');
  let templateId = '';
  {
    const bad = await request(app).post('/api/print-templates')
      .set('Authorization', OWNER).send({ name: 'Bad', payload: { nope: true } });
    assert.equal(bad.status, 400, `invalid payload rejected with 400 (got ${bad.status})`);
    assert(Array.isArray(bad.body.details) && bad.body.details.length > 0, 'actionable error details returned');
    ok('write-time validation rejects unknown shapes with details');

    const forbidden = await request(app).post('/api/print-templates')
      .set('Authorization', CASHIER).send({ name: 'X', payload: PAYLOAD_V1 });
    assert.equal(forbidden.status, 403, 'non-owner cannot create templates');
    ok('CRUD is owner-role only');

    const created = await request(app).post('/api/print-templates')
      .set('Authorization', OWNER)
      .send({
        name: 'Front Counter Receipt',
        payload: PAYLOAD_V1,
        origin: 'cloned',
        derivedFrom: { type: 'compliance-pack-template', templateId: 'country-x-tax-invoice' },
      });
    assert.equal(created.status, 201, `create draft returns 201 (got ${created.status})`);
    assert.equal(created.body.template.status, 'draft');
    assert.equal(created.body.template.origin, 'cloned');
    assert.deepEqual(created.body.template.derivedFrom, {
      type: 'compliance-pack-template', templateId: 'country-x-tax-invoice',
    });
    templateId = created.body.template.id;
    ok('draft creation records informational compliance provenance without trust claims');
  }

  console.log('\n▶ CRUD API: draft → active → rollback → archive');
  {
    const activated = await request(app).post(`/api/print-templates/${templateId}/activate`)
      .set('Authorization', OWNER);
    assert.equal(activated.status, 200);
    assert.equal(activated.body.template.status, 'active');
    ok('activate promotes a draft');

    const row = getDatabase().prepare('SELECT payload_json, checksum FROM merchant_print_templates WHERE id = ?').get(templateId) as any;
    assert.equal(row.checksum, createHash('sha256').update(row.payload_json, 'utf8').digest('hex'),
      'stored checksum equals sha256 of the persisted payload text');
    ok('checksum verification passes after activation');

    // Tamper detection: corrupt the payload behind the service's back.
    getDatabase().prepare('UPDATE merchant_print_templates SET payload_json = ? WHERE id = ?')
      .run('{"tampered":true}', templateId);
    const tamperedActivate = await request(app).post(`/api/print-templates/${templateId}/activate`)
      .set('Authorization', OWNER);
    assert.equal(tamperedActivate.status, 409, 'activation fails closed on checksum mismatch');
    getDatabase().prepare('UPDATE merchant_print_templates SET payload_json = ? WHERE id = ?')
      .run(row.payload_json, templateId);
    ok('checksum mismatch is detected before any state change');

    const updated = await request(app).put(`/api/print-templates/${templateId}`)
      .set('Authorization', OWNER).send({ payload: PAYLOAD_LABELED });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.template.hasPreviousPayload, true,
      'editing an active template snapshots the previous payload');
    ok('single-step rollback point captured on active edit');

    const rolledBack = await request(app).post(`/api/print-templates/${templateId}/rollback`)
      .set('Authorization', OWNER);
    assert.equal(rolledBack.status, 200);
    assert.equal(rolledBack.body.template.hasPreviousPayload, false);
    const restored = getDatabase().prepare('SELECT payload_json, previous_payload_json FROM merchant_print_templates WHERE id = ?').get(templateId) as any;
    assert.equal(restored.payload_json, row.payload_json, 'rollback restores the exact previous payload');
    assert.equal(restored.previous_payload_json, null);
    ok('rollback restores the previous payload and clears the rollback point');

    const noRollbackTwice = await request(app).post(`/api/print-templates/${templateId}/rollback`)
      .set('Authorization', OWNER);
    assert.equal(noRollbackTwice.status, 409, 'second rollback has nothing to restore');
    ok('rollback without a previous payload is rejected');

    // Capture a fresh rollback point while ACTIVE so the archived-rollback
    // refusal below can only come from the status guard, not from an empty
    // rollback point.
    const reEdit = await request(app).put(`/api/print-templates/${templateId}`)
      .set('Authorization', OWNER).send({ payload: PAYLOAD_LABELED });
    assert.equal(reEdit.status, 200);

    const archived = await request(app).post(`/api/print-templates/${templateId}/archive`)
      .set('Authorization', OWNER);
    assert.equal(archived.status, 200);
    assert.equal(archived.body.template.status, 'archived');
    const editArchived = await request(app).put(`/api/print-templates/${templateId}`)
      .set('Authorization', OWNER).send({ name: 'Zombie' });
    assert.equal(editArchived.status, 409, 'archived templates are immutable');
    const rollbackArchived = await request(app).post(`/api/print-templates/${templateId}/rollback`)
      .set('Authorization', OWNER);
    assert.equal(rollbackArchived.status, 409, 'rollback is refused on archived templates');
    assert.equal(rollbackArchived.body.error, 'Archived templates cannot be rolled back');
    ok('archive terminalizes the lifecycle');
  }

  console.log('\n▶ CRUD API: merchant availability in selection identity');
  {
    const inactive = await request(app).post('/api/print-templates')
      .set('Authorization', OWNER).send({ name: 'Draft Only', payload: PAYLOAD_V1 });
    const draftId = inactive.body.template.id;

    const storedStructured = serializeBillTemplateSelection({ source: 'merchant', id: draftId });
    assert.equal(parseBillTemplateSelection(storedStructured)?.source, 'merchant');
    const { isAvailableBillTemplate } = require('../main/services/print-templates');
    assert.equal(isAvailableBillTemplate(storedStructured), false,
      'draft merchant template is not selectable');
    await request(app).post(`/api/print-templates/${draftId}/activate`).set('Authorization', OWNER);
    assert.equal(isAvailableBillTemplate(storedStructured), true,
      'active merchant template becomes selectable');
    await request(app).post(`/api/print-templates/${draftId}/archive`).set('Authorization', OWNER);
    assert.equal(isAvailableBillTemplate(storedStructured), false,
      'archived merchant template stops being selectable');
    ok('merchant availability follows the lifecycle (active only)');
  }

  console.log('\n▶ Render path: merchant templates through the document pipeline');
  {
    const { order, bill, business } = buildParityFixtures();
    const rendered = await request(app).post('/api/print-templates')
      .set('Authorization', OWNER).send({ name: 'Render Test', payload: PAYLOAD_V1 });
    const renderId = rendered.body.template.id;
    await request(app).post(`/api/print-templates/${renderId}/activate`).set('Authorization', OWNER);

    for (const cols of [32, 42, 48] as const) {
      const merchantBytes = formatReceipt(order, bill, business,
        serializeBillTemplateSelection({ source: 'merchant', id: renderId }), cols, false, false, 'full', [], false, 'en');
      const classicDocBytes = renderClassicReceiptViaDocument(order, bill, business, {
        columns: cols, language: 'en', isReprint: false, useUnicode: false, arabicShaping: false, cutMode: 'full' as const,
      }).data;
      assert(Buffer.compare(merchantBytes, classicDocBytes) === 0,
        `merchant render matches document-pipeline classic at ${cols} columns`);
    }
    ok('byte-identical to the plain classic document pipeline at 32/42/48 columns');

    const styled = await request(app).post('/api/print-templates')
      .set('Authorization', OWNER).send({ name: 'Styled', payload: PAYLOAD_LABELED });
    const styledId = styled.body.template.id;
    await request(app).post(`/api/print-templates/${styledId}/activate`).set('Authorization', OWNER);
    const styledText = escPosToText(formatReceipt(order, bill, business,
      serializeBillTemplateSelection({ source: 'merchant', id: styledId }), 42, false, false, 'full', [], false, 'en'));
    assert(styledText.includes('AMOUNT DUE'), 'label variant reaches the rendered output');
    assert(!styledText.includes('GST'), 'hidden tax breakdown block stays hidden');
    ok('semantic overrides change rendered output exactly where configured');

    // Legacy bare value keeps resolving through the same entrypoint.
    const legacyClassic = formatReceipt(order, bill, business, 'classic', 42, false, false, 'full', [], false, 'en');
    assert(legacyClassic.length > 0, 'legacy bare classic still renders');
    ok('legacy bare-string selections keep rendering during transition');

    // Inactive/deleted merchant id falls back with an explicit warning.
    const warnings: any[] = [];
    const fallback = formatReceipt(order, bill, business,
      serializeBillTemplateSelection({ source: 'merchant', id: 'missing-id' }), 42, false, false, 'full', warnings, false, 'en');
    assert(fallback.length > 0, 'missing merchant template falls back to classic');
    assert(warnings.some((w) => String(w.message).includes('not active')), 'fallback warning recorded');
    ok('render fails closed with an explicit warning, never garbage');
  }
}

(async () => {
  try {
    await runLifecycle();
    console.log(`\nMerchant print template tests: ${passed} checks passed.`);
    closeDatabase();
    process.exit(0);
  } catch (error) {
    console.error(error);
    try { closeDatabase(); } catch {}
    process.exit(1);
  }
})();
