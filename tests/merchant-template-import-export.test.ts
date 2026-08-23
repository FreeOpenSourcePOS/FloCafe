/**
 * Merchant print template offline import/export tests (#448, epic #438).
 *
 * Covers:
 *   1. Transfer-envelope contract: golden fixture validates; every negative
 *      fixture class rejects with actionable errors (tampered checksum,
 *      unknown envelope major, wrong root format, unknown envelope fields,
 *      oversized envelope, disallowed payload block, malformed JSON).
 *   2. Export API (owner-only): active/archived rows download a
 *      self-describing envelope whose checksum matches the persisted row;
 *      drafts are refused; tampered rows fail closed before export;
 *      download filenames are sanitized and traversal-proof.
 *   3. Import API (owner-only): full fail-closed pipeline (size cap ->
 *      single JSON doc -> envelope whitelist -> #447 payload validator ->
 *      checksum verify); imports ALWAYS land as NEW drafts with
 *      `origin: imported` and offline-import provenance; duplicate names are
 *      allowed under fresh identities.
 *   4. Round-trip parity: export -> import preserves the payload exactly and
 *      renders byte-identically through the document pipeline; the
 *      draft -> active -> archive lifecycle stays intact after import.
 *
 * Run: npx ts-node --transpile-only -P tests/tsconfig.json tests/merchant-template-import-export.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock electron before importing any app modules.
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-merchant-transfer-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-for-merchant-template-transfer';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  MAX_MERCHANT_TEMPLATE_ENVELOPE_BYTES,
  MERCHANT_TEMPLATE_EXPORT_FORMAT,
  MERCHANT_TEMPLATE_EXPORT_SCHEMA_VERSION,
  validateMerchantTemplate,
  validateMerchantTemplateEnvelope,
} from '../shared/print';
import { buildParityFixtures } from './print-parity.test';

let passed = 0;
function ok(message: string): void {
  passed++;
  console.log(`  ✓ ${message}`);
}

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/merchant-templates');
const TRANSFER_DIR = path.join(FIXTURE_DIR, 'transfer');

function readFixture(relative: string): string {
  return fs.readFileSync(path.join(TRANSFER_DIR, relative), 'utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 1. Envelope contract (pure)
// ---------------------------------------------------------------------------

console.log('\n▶ Envelope validation: golden fixture');
{
  const goldenText = readFixture('golden-envelope-v1.json');
  const parsed = JSON.parse(goldenText);
  const envelopeResult = validateMerchantTemplateEnvelope(parsed);
  assert(envelopeResult.ok, `golden envelope structurally valid (${envelopeResult.ok ? '' : envelopeResult.errors.join('; ')})`);
  assert.equal(envelopeResult.ok && envelopeResult.envelope.claimedChecksum.length, 64);
  ok('golden-envelope-v1.json passes structural envelope validation');

  const payloadResult = validateMerchantTemplate(envelopeResult.ok ? envelopeResult.envelope.payload : null);
  assert(payloadResult.ok, 'embedded payload passes the shared #447 validator');

  // Checksum convention: sha256 of the canonical payload serialization.
  const canonical = JSON.stringify(payloadResult.ok ? payloadResult.payload : null);
  assert.equal(
    envelopeResult.ok && envelopeResult.envelope.claimedChecksum.toLowerCase(),
    sha256(canonical),
    'claimed checksum equals sha256 of canonical payload text',
  );
  ok('checksum convention verified against the golden fixture');

  assert.equal(MERCHANT_TEMPLATE_EXPORT_FORMAT, 'flocafe-merchant-template');
  assert.equal(MERCHANT_TEMPLATE_EXPORT_SCHEMA_VERSION, 1);
}

console.log('\n▶ Envelope validation: negative fixtures');
{
  // Structural rejects (fail inside validateMerchantTemplateEnvelope).
  const structural: Array<[string, string]> = [
    ['negative/unknown-envelope-major.json', 'unsupported transfer-file version'],
    ['negative/wrong-root-format.json', 'root.format'],
    ['negative/unknown-envelope-field.json', 'unknown field "renderer"'],
  ];
  for (const [fixture, expectedFragment] of structural) {
    const result = validateMerchantTemplateEnvelope(JSON.parse(readFixture(fixture)));
    assert(!result.ok, `${fixture}: rejected`);
    assert(
      result.errors.some((message) => message.includes(expectedFragment)),
      `${fixture}: actionable error mentions "${expectedFragment}" — got: ${result.errors.join(' | ')}`,
    );
  }
  ok('unknown majors, wrong formats, and unknown fields rejected with pointers');

  // Disallowed payload block: envelope structure is fine, the PAYLOAD validator
  // must be the single authority that rejects the unknown block kind.
  const disallowedParsed = JSON.parse(readFixture('negative/disallowed-block.json'));
  const disallowedEnvelope = validateMerchantTemplateEnvelope(disallowedParsed);
  assert(disallowedEnvelope.ok, 'disallowed-block envelope is structurally valid');
  const disallowedPayload = validateMerchantTemplate(disallowedEnvelope.ok ? disallowedEnvelope.envelope.payload : null);
  assert(!disallowedPayload.ok);
  assert(
    disallowedPayload.errors.some((message) => message.includes('unknown block kind')),
    `disallowed block rejected by the shared payload validator — got: ${disallowedPayload.errors.join(' | ')}`,
  );
  ok('disallowed block kinds reject through the shared payload validator, not a fork');

  // Tampered checksum: structurally valid, fails only at integrity verification.
  const tamperedParsed = JSON.parse(readFixture('negative/tampered-checksum.json'));
  const tamperedEnvelope = validateMerchantTemplateEnvelope(tamperedParsed);
  assert(tamperedEnvelope.ok);
  const tamperedPayload = validateMerchantTemplate(tamperedEnvelope.ok ? tamperedEnvelope.envelope.payload : null);
  assert(tamperedPayload.ok);
  assert.notEqual(
    tamperedEnvelope.ok && tamperedEnvelope.envelope.claimedChecksum.toLowerCase(),
    sha256(JSON.stringify(tamperedPayload.ok ? tamperedPayload.payload : null)),
  );
  ok('tampered checksum fixture is detectable at the verification step');

  // Oversized envelope: rejected on raw byte length before any parsing.
  const oversizedText = readFixture('negative/oversized-envelope.json');
  assert(Buffer.byteLength(oversizedText, 'utf8') > MAX_MERCHANT_TEMPLATE_ENVELOPE_BYTES);
  assert(!validateMerchantTemplateTextSafe(oversizedText));
  ok(`envelopes above ${MAX_MERCHANT_TEMPLATE_ENVELOPE_BYTES} bytes are rejected on byte length`);

  // Malformed JSON / non-object roots never parse into a valid envelope.
  assert(!validateMerchantTemplateEnvelope('{not json').ok);
  assert(!validateMerchantTemplateEnvelope(null).ok);
  assert(!validateMerchantTemplateEnvelope([golden()]).ok);
  ok('malformed JSON and non-object roots fail closed');
}

// Local helpers for section 1 (defined after use via hoisting-safe function decls).
function golden(): unknown {
  return JSON.parse(readFixture('golden-envelope-v1.json'));
}
function validateMerchantTemplateTextSafe(raw: string): boolean {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MERCHANT_TEMPLATE_ENVELOPE_BYTES) return false;
  try {
    return validateMerchantTemplateEnvelope(JSON.parse(raw)).ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 2–4. Export/import over HTTP (owner role) + round-trip parity
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

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { getJWTSecret } = require('../main/routes/auth');
const { printTemplateRoutes } = require('../main/routes/print-templates');

const app = express();
// Deliberately ABOVE the 256 KB envelope cap so the feature's own size gate
// is what rejects oversized files (not the generic body parser limit).
app.use(express.json({ limit: '2mb' }));
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
app.use('/api/print-templates', printTemplateRoutes);

function authHeaderFor(role: string): string {
  return `Bearer ${jwt.sign({ userId: `actor-${role}`, role }, getJWTSecret(), { expiresIn: '1h' })}`;
}
const OWNER = authHeaderFor('owner');
const CASHIER = authHeaderFor('cashier');

const PAYLOAD = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'golden-receipt-labeled-v1.json'), 'utf8'));

async function runTransfer(): Promise<void> {
  let templateId = '';
  let exportedText = '';

  console.log('\n▶ Export API');
  {
    const created = await request(app).post('/api/print-templates')
      .set('Authorization', OWNER).send({ name: 'Front Counter Receipt', payload: PAYLOAD });
    assert.equal(created.status, 201);
    templateId = created.body.template.id;

    const forbidden = await request(app).get(`/api/print-templates/${templateId}/export`)
      .set('Authorization', CASHIER);
    assert.equal(forbidden.status, 403, 'non-owner cannot export');
    ok('export is owner-role only');

    const draftExport = await request(app).get(`/api/print-templates/${templateId}/export`)
      .set('Authorization', OWNER);
    assert.equal(draftExport.status, 409, 'drafts are not exportable');
    ok('draft templates are refused (only active/archived export)');

    await request(app).post(`/api/print-templates/${templateId}/activate`).set('Authorization', OWNER);

    const exported = await request(app).get(`/api/print-templates/${templateId}/export`)
      .set('Authorization', OWNER);
    assert.equal(exported.status, 200);
    assert.match(exported.headers['content-disposition'], /attachment;\s*filename="front-counter-receipt\.flocafe-template\.json"/);
    exportedText = exported.text;
    const envelope = JSON.parse(exportedText);
    assert.equal(envelope.format, MERCHANT_TEMPLATE_EXPORT_FORMAT);
    assert.equal(envelope.schemaVersion, MERCHANT_TEMPLATE_EXPORT_SCHEMA_VERSION);
    assert.equal(typeof envelope.exportedAt, 'string');
    assert(!Number.isNaN(Date.parse(envelope.exportedAt)));
    const row = getDatabase().prepare('SELECT checksum FROM merchant_print_templates WHERE id = ?').get(templateId) as any;
    assert.equal(envelope.checksum, row.checksum, 'envelope checksum equals the persisted row checksum');
    assert.deepEqual(envelope.origin.sourceTemplateId, templateId);
    assert.deepEqual(envelope.template, PAYLOAD);
    ok('active template exports a self-describing envelope carrying origin metadata');
  }

  console.log('\n▶ Export hardening: tamper detection + filename sanitization');
  {
    const row = getDatabase().prepare('SELECT payload_json FROM merchant_print_templates WHERE id = ?').get(templateId) as any;
    getDatabase().prepare('UPDATE merchant_print_templates SET payload_json = ? WHERE id = ?')
      .run('{"tampered":true}', templateId);
    const tamperedExport = await request(app).get(`/api/print-templates/${templateId}/export`)
      .set('Authorization', OWNER);
    assert.equal(tamperedExport.status, 409, 'export fails closed on checksum mismatch');
    getDatabase().prepare('UPDATE merchant_print_templates SET payload_json = ? WHERE id = ?')
      .run(row.payload_json, templateId);
    ok('a tampered row can never be distributed as a trusted-looking file');

    const weird = await request(app).post('/api/print-templates')
      .set('Authorization', OWNER)
      .send({ name: '../../etc passwd <recept?>', payload: PAYLOAD });
    assert.equal(weird.status, 201);
    await request(app).post(`/api/print-templates/${weird.body.template.id}/activate`).set('Authorization', OWNER);
    const weirdExport = await request(app).get(`/api/print-templates/${weird.body.template.id}/export`)
      .set('Authorization', OWNER);
    assert.equal(weirdExport.status, 200);
    const filename = /filename="([^"]+)"/.exec(weirdExport.headers['content-disposition'])![1];
    assert(!/[\\/]/.test(filename), 'no path separators in download filename');
    assert(!filename.startsWith('.'), 'no dotfile/traversal filenames');
    assert.match(filename, /\.flocafe-template\.json$/);
    ok(`hostile names sanitize to traversal-proof filenames (${JSON.stringify(filename)})`);
  }

  console.log('\n▶ Import API: fail-closed pipeline');
  {
    const forbidden = await request(app).post('/api/print-templates/import')
      .set('Authorization', CASHIER).send({ file: exportedText });
    assert.equal(forbidden.status, 403, 'non-owner cannot import');
    ok('import is owner-role only');

    const rejections: Array<[string, unknown, number, string]> = [
      ['missing file', {}, 400, 'required'],
      ['malformed JSON', { file: '{not json' }, 400, 'not valid JSON'],
      ['wrong root format', { file: readFixture('negative/wrong-root-format.json') }, 400, 'root.format'],
      ['unknown envelope major', { file: readFixture('negative/unknown-envelope-major.json') }, 400, 'unsupported transfer-file version'],
      ['unknown envelope field', { file: readFixture('negative/unknown-envelope-field.json') }, 400, 'unknown field "renderer"'],
      ['disallowed block', { file: readFixture('negative/disallowed-block.json') }, 400, 'unknown block kind'],
      ['tampered checksum', { file: readFixture('negative/tampered-checksum.json') }, 409, 'Checksum mismatch'],
      ['oversized envelope', { file: readFixture('negative/oversized-envelope.json') }, 413, 'maximum allowed size'],
    ];
    for (const [label, body, expectedStatus, expectedFragment] of rejections) {
      const response = await request(app).post('/api/print-templates/import')
        .set('Authorization', OWNER).send(body);
      assert.equal(response.status, expectedStatus, `${label}: status (got ${response.status})`);
      const message = `${response.body.error ?? ''} ${(response.body.details ?? []).join(' ')}`;
      assert(
        message.toLowerCase().includes(expectedFragment.toLowerCase()),
        `${label}: error mentions "${expectedFragment}" — got: ${message}`,
      );
    }
    ok('every rejection class tested: bad version, wrong format, unknown fields, disallowed block, tampered checksum, oversize, malformed JSON');

    const count = (getDatabase().prepare('SELECT COUNT(*) AS n FROM merchant_print_templates WHERE origin = \'imported\'').get() as any).n;
    assert.equal(count, 0, 'no rejected import ever partially installed a row');
    ok('invalid templates never partially install');
  }

  console.log('\n▶ Import API: landing as draft + provenance');
  {
    let importedId = '';
    let importedRow: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      const imported = await request(app).post('/api/print-templates/import')
        .set('Authorization', OWNER)
        .send(attempt === 0
          ? { file: exportedText, fileName: '/home/someone/front-counter-receipt.flocafe-template.json' }
          : { file: exportedText });
      assert.equal(imported.status, 201, `import returns 201 (got ${imported.status})`);
      const template = imported.body.template;
      assert.equal(template.status, 'draft', 'imports land as drafts');
      assert.equal(template.origin, 'imported');
      assert.notEqual(template.id, templateId, 'imports always mint a fresh identity');
      assert.equal(template.derivedFrom.type, 'offline-import');
      assert.equal(template.derivedFrom.fileName, attempt === 0 ? 'front-counter-receipt.flocafe-template.json' : undefined,
        'client file paths reduce to a bare informational file name');
      importedId = template.id;

      importedRow = getDatabase().prepare('SELECT payload_json, checksum, derived_from, schema_version FROM merchant_print_templates WHERE id = ?').get(importedId);
      const sourceDigest = sha256(exportedText);
      assert.equal(JSON.parse(importedRow.derived_from).templateId, sourceDigest,
        'provenance records the digest of the exact source artifact');
    }
    ok('imported templates land as new drafts with offline-import provenance');

    assert.deepEqual(JSON.parse(importedRow.payload_json), PAYLOAD,
      'round-trip preserves the payload exactly');
    assert.equal(importedRow.checksum, sha256(importedRow.payload_json),
      'imported checksum follows the storage convention');
    ok('export -> import round-trip is lossless');

    const duplicates = (getDatabase().prepare('SELECT COUNT(*) AS n FROM merchant_print_templates WHERE name = ?').get('Front Counter Receipt') as any).n;
    assert.equal(duplicates, 3, 'duplicate names allowed under distinct uuid identities (source + 2 imports)');
    ok('duplicate names are permitted (identity is the uuid, never the source id)');
  }

  console.log('\n▶ Round-trip render parity + lifecycle intact after import');
  {
    const { order, bill, business } = buildParityFixtures();
    const formatViaSelection = async (selection: string): Promise<Buffer> => {
      const { formatReceipt } = require('../main/printers/thermal');
      return formatReceipt(order, bill, business, selection, 42, false, false, 'full', [], false, 'en');
    };

    const originalBytes = await formatViaSelection(JSON.stringify({ source: 'merchant', id: templateId }));
    const importedRows = getDatabase().prepare(
      'SELECT id FROM merchant_print_templates WHERE origin = \'imported\' ORDER BY updated_at DESC LIMIT 1'
    ).all() as any[];
    const importedId = importedRows[0].id;
    await request(app).post(`/api/print-templates/${importedId}/activate`).set('Authorization', OWNER);
    const importedBytes = await formatViaSelection(JSON.stringify({ source: 'merchant', id: importedId }));
    assert(Buffer.compare(originalBytes, importedBytes) === 0,
      'original and round-tripped template render byte-identically');
    ok('render parity holds across the export/import boundary');

    const archived = await request(app).post(`/api/print-templates/${importedId}/archive`)
      .set('Authorization', OWNER);
    assert.equal(archived.status, 200);
    assert.equal(archived.body.template.status, 'archived');
    const reExport = await request(app).get(`/api/print-templates/${importedId}/export`)
      .set('Authorization', OWNER);
    assert.equal(reExport.status, 200, 'archived templates stay exportable');
    ok('draft -> active -> archive lifecycle intact after import; archived rows remain portable');
  }
}

(async () => {
  try {
    await runTransfer();
    console.log(`\nMerchant template import/export tests: ${passed} checks passed.`);
    closeDatabase();
    process.exit(0);
  } catch (error) {
    console.error(error);
    try { closeDatabase(); } catch {}
    process.exit(1);
  }
})();
