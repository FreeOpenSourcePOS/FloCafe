/**
 * Regression: customer phone search bridges e164 ('+919876543210') and legacy
 * local-format rows ('9876543210') via the phone_digits generated column.
 */

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => '/tmp', getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const { buildIdealSchemaDb } = require('../main/db');
const { assertEqual, assert } = require('./helpers/test-setup');

const db = buildIdealSchemaDb();

const ins = db.prepare(
  "INSERT INTO customers (id, name, phone, is_active) VALUES (?, ?, ?, ?)"
);
ins.run('c-e164',     'Anita E164',  '+919876543210',     1);
ins.run('c-local',    'Anita Local', '9876543210',        1);
ins.run('c-formatted','Anita Pretty','+91 987-654-3210',  1);
ins.run('c-us',       'Bob US',      '+1 (555) 123-4567', 1);
ins.run('c-ar',       'Carlos AR',   '+541143210000',     1);
ins.run('c-inactive', 'Inactive',    '+911111111111',     0);

function search(q) {
  const term = `%${q}%`;
  return db.prepare(`
    SELECT id FROM customers
    WHERE is_active = 1 AND (phone_digits LIKE ? OR name LIKE ?)
    ORDER BY name LIMIT 20
  `).all(term, term).map(r => r.id);
}

try {
  const hits1 = search('9876543210');
  assertEqual(hits1.length, 3, `digits "9876543210" finds e164, local, and pretty-formatted rows (got ${hits1.length})`);
  assert(hits1.includes('c-e164'),      'e164 row returned');
  assert(hits1.includes('c-local'),     'local row returned');
  assert(hits1.includes('c-formatted'), 'pretty-formatted row returned');

  const hitsUs = search('5551234567');
  assertEqual(hitsUs.length, 1, `US short digits "5551234567" find c-us only (got ${hitsUs.length})`);
  assertEqual(hitsUs[0], 'c-us', 'US pretty-format row matched after stripping parens');

  const hitsUsIntl = search('15551234567');
  assertEqual(hitsUsIntl.length, 1, `US intl digits "15551234567" find c-us only (got ${hitsUsIntl.length})`);
  assertEqual(hitsUsIntl[0], 'c-us', 'US pretty-format row matched for intl-digit query');

  const hits2 = search('919876543210');
  assertEqual(hits2.length, 2, `intl digits "919876543210" match e164 and pretty-formatted rows (got ${hits2.length})`);
  assert(hits2.includes('c-e164'),      'e164 row matched for intl-digit query');
  assert(!hits2.includes('c-local'),    'local-format row excluded for intl-digit query');
  assert(hits2.includes('c-formatted'), 'pretty-formatted row matched for intl-digit query');

  const hits3 = search('1111111111');
  assertEqual(hits3.length, 0, 'inactive e164 row is excluded by is_active = 1');

  const hits4 = search('541143210000');
  assertEqual(hits4.length, 1, `AR digits find c-ar only (got ${hits4.length})`);
  assertEqual(hits4[0], 'c-ar', 'AR e164 row matched');

  const hits5 = search('Carlos');
  assertEqual(hits5.length, 1, `name LIKE still matches (got ${hits5.length})`);
  assertEqual(hits5[0], 'c-ar', 'name LIKE branch unchanged');

  db.close();
  console.log('\nAll assertions passed');
  process.exit(0);
} catch (err) {
  try { db.close(); } catch {}
  console.error('FAILED:', err.message);
  process.exit(1);
}