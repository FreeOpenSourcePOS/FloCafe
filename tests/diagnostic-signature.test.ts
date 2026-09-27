/**
 * Derived diagnostic signature tests.
 *
 * A stored diagnostic carries a *derived* signature, never the raw exception
 * message: literals become typed placeholders and anything unclassifiable is
 * dropped. These assertions are the privacy boundary of the diagnostics
 * channel, so they assert the absence of each specific value in the input
 * rather than only the presence of a placeholder.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/diagnostic-signature.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-diagnostic-signature-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.11.0' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  deriveDiagnosticSignature, deriveDiagnosticTemplate, errorClassOf,
} = require('../main/lib/diagnostic-signature');
const { assert, assertEqual, getResults, closeDatabase } = require('./helpers/test-setup');

function main() {
  console.log('Derived Diagnostic Signature Tests');
  console.log('='.repeat(56));

  const CUSTOMER_NAME = 'Rajesh Kumar';
  const PHONE = '9876543210';
  const AMOUNT = '1250.50';
  const FILE_PATH = '/Users/pos/flo.db';

  console.log('\n1. A message carrying customer data produces a signature carrying none of it');
  const leaky = deriveDiagnosticSignature({
    errorClass: 'Error',
    message: `Failed to settle bill for '${CUSTOMER_NAME}' at +91 ${PHONE} amount ${AMOUNT} from ${FILE_PATH}`,
  });
  console.log(`   signature: ${leaky.signature}`);
  assert(!leaky.signature.includes(CUSTOMER_NAME), 'the customer name is absent from the signature');
  assert(!leaky.signature.includes('Rajesh'), 'no fragment of the customer name survives');
  assert(!leaky.signature.includes(PHONE), 'the phone number is absent from the signature');
  assert(!leaky.signature.includes(AMOUNT), 'the amount is absent from the signature');
  assert(!leaky.signature.includes(FILE_PATH), 'the file path is absent from the signature');
  assert(!leaky.summary.includes(CUSTOMER_NAME), 'the customer name is absent from the summary');
  assert(!leaky.summary.includes(PHONE), 'the phone number is absent from the summary');
  assert(leaky.signature.includes('<string>'), 'the quoted customer name became a quoted-string placeholder');
  assert(leaky.signature.includes('<number>'), 'numeric values became a number placeholder');
  assert(leaky.signature.includes('<path>'), 'the absolute path became a path placeholder');
  assertEqual(leaky.error_class, 'Error', 'the error class is preserved');

  console.log('\n2. Two different customers\' copies of the same failure produce the same signature');
  const customerA = deriveDiagnosticSignature({ errorClass: 'SQLiteError', message: "no such table: 'orders'" });
  const customerB = deriveDiagnosticSignature({ errorClass: 'SQLiteError', message: "no such table: 'refunds'" });
  assertEqual(customerA.signature, customerB.signature, 'two tills failing on different tables share one signature');
  const secondA = deriveDiagnosticSignature({ errorClass: 'TypeError', message: "Cannot read properties of undefined (reading 'orderNumber')" });
  const secondB = deriveDiagnosticSignature({ errorClass: 'TypeError', message: "Cannot read properties of undefined (reading 'tableName')" });
  assertEqual(secondA.signature, secondB.signature, 'two different property names in one message share one signature');
  const thirdA = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Customer Rajesh Kumar has no saved address' });
  const thirdB = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Customer Ana Gonzalez has no saved address' });
  assertEqual(thirdA.signature, thirdB.signature, 'a bare-word customer name never reaches the signature');
  assert(!thirdA.signature.includes('Rajesh') && !thirdA.signature.includes('Ana'), 'neither customer name appears');
  const fourthA = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Payment of 412.75 to 5500112233445566 timed out' });
  const fourthB = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Payment of 980.10 to 5500119988776655 timed out' });
  assertEqual(fourthA.signature, fourthB.signature, 'differing amounts and long numeric ids share one signature');
  assert(!fourthA.signature.includes('412.75') && !fourthA.signature.includes('5500112233445566'), 'no amount or long id leaks');

  console.log('\n3. Typed placeholders distinguish the literal kinds');
  assertEqual(
    deriveDiagnosticTemplate('failed on /var/lib/flo/a.db at 3'),
    'failed on <path> at <number>',
    'an absolute path and a number are typed separately',
  );
  assertEqual(
    deriveDiagnosticTemplate('device 550e8400-e29b-41d4-a716-446655440000 offline'),
    'device <id> offline',
    'a UUID becomes an identifier placeholder',
  );
  assertEqual(
    deriveDiagnosticTemplate("table 'orders' has no column named 'Rajesh Kumar'"),
    'table <string> has no column named <string>',
    'a quoted identifier becomes a quoted-string placeholder and stays one token',
  );
  assertEqual(
    deriveDiagnosticTemplate('no such table: orders'),
    'no such table: orders',
    'a schema reference after a known introducer survives so the cause stays readable',
  );
  assertEqual(
    deriveDiagnosticTemplate('UNIQUE constraint failed: orders.customer_id'),
    'UNIQUE constraint failed: orders.customer_id',
    'a dotted SQL reference inside a SQL phrase survives as a schema reference',
  );

  console.log('\n4. A dotted value that is not a schema reference is dropped');
  // A dotted token only reads as a schema reference inside a SQL phrase. Elsewhere
  // it is a value - a username, a hostname - and must not reach the signature.
  const dottedValue = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Failed login for john.smith' });
  assertEqual(dottedValue.signature, 'Error: Failed', 'a dotted username is dropped');
  assert(!dottedValue.signature.includes('john.smith'), 'the dotted username never reaches the signature');
  const hostname = deriveDiagnosticSignature({ errorClass: 'Error', message: 'getaddrinfo ENOTFOUND api.stripe.com' });
  assert(!hostname.signature.includes('api.stripe.com'), 'a hostname in a driver error is dropped');
  const email = deriveDiagnosticSignature({ errorClass: 'Error', message: 'could not deliver to ops@acme.example' });
  assert(!email.signature.includes('acme.example'), 'the domain of an email address is dropped');
  assertEqual(email.signature, 'Error: could not to', 'an unclassifiable address reduces to the structural words only');

  console.log('\n5. Unclassifiable values are dropped rather than kept');
  assertEqual(deriveDiagnosticTemplate(''), '', 'an empty message yields an empty template');
  assertEqual(deriveDiagnosticTemplate(undefined), '', 'a missing message yields an empty template');
  assertEqual(
    deriveDiagnosticTemplate('saga 7742 Blorptastic'),
    '<number>',
    'a bare word that is not a schema reference is dropped, the number is not',
  );
  const dropped = deriveDiagnosticSignature({ errorClass: 'Error', message: 'saga Zorblax 7742' });
  assert(!dropped.signature.includes('Zorblax'), 'an unknown bare word is dropped from the signature');
  assertEqual(dropped.signature, 'Error: <number>', 'only the confidently classified literal survives');
  // Known limit of the derivation, recorded rather than hidden: a value made
  // entirely of structural words cannot be told apart from the fixed phrase.
  assert(
    deriveDiagnosticTemplate('Table Key has no saved address') === 'Table Key has no',
    'known residual: a value composed only of structural words survives (documented in the module)',
  );

  console.log('\n6. The signature is shown to a human as a sentence, not a placeholder stack');
  const dbFailure = deriveDiagnosticSignature({ errorClass: 'SQLiteError', message: 'no such table: orders' });
  assertEqual(
    dbFailure.summary,
    'The database rejected a request: no such table: orders.',
    'a database failure reads as a sentence naming the table',
  );
  assert(
    /^[A-Z]/.test(dbFailure.summary) && !dbFailure.summary.startsWith('<'),
    'the summary is plain language rather than a placeholder stack',
  );
  const typeFailure = deriveDiagnosticSignature({ errorClass: 'TypeError', message: "x.map is not a function" });
  assertEqual(typeFailure.error_class, 'TypeError', 'the error class is normalised, not lowercased away');
  assert(typeFailure.summary.startsWith('A value had the wrong type'), 'an unlisted class still gets a plain-language clause');

  console.log('\n7. Hostile and malformed input cannot widen what is stored');
  assertEqual(deriveDiagnosticSignature(null).signature, 'Error', 'a null source still yields a class-only signature');
  assertEqual(
    deriveDiagnosticSignature({ errorClass: 'Error<script>', message: 'x' }).error_class,
    'Error',
    'a class name that is not an identifier is refused',
  );
  assertEqual(
    deriveDiagnosticSignature({ errorClass: 'Rajesh Kumar', message: 'x' }).error_class,
    'Error',
    'a class name carrying spaces is refused rather than stored',
  );
  const long = deriveDiagnosticTemplate("'secret-value' ".repeat(200));
  assert(long.length <= 240, 'an over-long message is bounded');

  console.log('\n8. Error class extraction is defensive');
  assertEqual(errorClassOf(new TypeError('x')), 'TypeError', 'a TypeError reports TypeError');
  assertEqual(errorClassOf('a string'), 'Error', 'a non-error value reports the unknown class');
  assertEqual(errorClassOf(null), 'Error', 'null reports the unknown class');
  assertEqual(errorClassOf({ name: 'SQLiteError', message: 'x' }), 'SQLiteError', 'an error-shaped object reports its name');

  console.log('\n' + '='.repeat(56));
  const results = getResults();
  console.log(`${results.passed} passed, ${results.failed} failed`);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(results.failed > 0 ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error('Test suite crashed:', error);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
}
