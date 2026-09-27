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
  deriveDiagnosticSignature, deriveDiagnosticTemplate, errorClassOf, classClauseSummary,
} = require('../main/lib/diagnostic-signature');
const {
  assertOrThrow, assertEqualOrThrow, getResults, closeDatabase,
} = require('./helpers/test-setup');

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
  assertOrThrow(!leaky.signature.includes(CUSTOMER_NAME), 'the customer name is absent from the signature');
  assertOrThrow(!leaky.signature.includes('Rajesh'), 'no fragment of the customer name survives');
  assertOrThrow(!leaky.signature.includes(PHONE), 'the phone number is absent from the signature');
  assertOrThrow(!leaky.signature.includes(AMOUNT), 'the amount is absent from the signature');
  assertOrThrow(!leaky.signature.includes(FILE_PATH), 'the file path is absent from the signature');
  assertOrThrow(!leaky.summary.includes(CUSTOMER_NAME), 'the customer name is absent from the summary');
  assertOrThrow(!leaky.summary.includes(PHONE), 'the phone number is absent from the summary');
  assertOrThrow(leaky.signature.includes('<string>'), 'the quoted customer name became a quoted-string placeholder');
  assertOrThrow(leaky.signature.includes('<number>'), 'numeric values became a number placeholder');
  assertOrThrow(leaky.signature.includes('<path>'), 'the absolute path became a path placeholder');
  assertEqualOrThrow(leaky.error_class, 'Error', 'the error class is preserved');

  console.log('\n2. Two different customers\' copies of the same failure produce the same signature');
  const customerA = deriveDiagnosticSignature({ errorClass: 'SQLiteError', message: "no such table: 'orders'" });
  const customerB = deriveDiagnosticSignature({ errorClass: 'SQLiteError', message: "no such table: 'refunds'" });
  assertEqualOrThrow(customerA.signature, customerB.signature, 'two tills failing on different tables share one signature');
  const secondA = deriveDiagnosticSignature({ errorClass: 'TypeError', message: "Cannot read properties of undefined (reading 'orderNumber')" });
  const secondB = deriveDiagnosticSignature({ errorClass: 'TypeError', message: "Cannot read properties of undefined (reading 'tableName')" });
  assertEqualOrThrow(secondA.signature, secondB.signature, 'two different property names in one message share one signature');
  const thirdA = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Customer Rajesh Kumar has no saved address' });
  const thirdB = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Customer Ana Gonzalez has no saved address' });
  assertEqualOrThrow(thirdA.signature, thirdB.signature, 'a bare-word customer name never reaches the signature');
  assertOrThrow(!thirdA.signature.includes('Rajesh') && !thirdA.signature.includes('Ana'), 'neither customer name appears');
  const fourthA = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Payment of 412.75 to 5500112233445566 timed out' });
  const fourthB = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Payment of 980.10 to 5500119988776655 timed out' });
  assertEqualOrThrow(fourthA.signature, fourthB.signature, 'differing amounts and long numeric ids share one signature');
  assertOrThrow(!fourthA.signature.includes('412.75') && !fourthA.signature.includes('5500112233445566'), 'no amount or long id leaks');

  console.log('\n3. Typed placeholders distinguish the literal kinds');
  assertEqualOrThrow(
    deriveDiagnosticTemplate('failed on /var/lib/flo/a.db at 3'),
    'failed on <path> at <number>',
    'an absolute path and a number are typed separately',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate('device 550e8400-e29b-41d4-a716-446655440000 offline'),
    'device <id> offline',
    'a UUID becomes an identifier placeholder',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate("table 'orders' has no column named 'Rajesh Kumar'"),
    'table <string> has no column named <string>',
    'a quoted identifier becomes a quoted-string placeholder and stays one token',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate('no such table: orders'),
    'no such table: orders',
    'a schema reference after a known introducer survives so the cause stays readable',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate('UNIQUE constraint failed: orders.customer_id'),
    'UNIQUE constraint failed: orders.customer_id',
    'a dotted SQL reference inside a SQL phrase survives as a schema reference',
  );

  console.log('\n4. A URL is a structure, not a substring: the whole value becomes one placeholder');
  // These are the awkward cases on purpose. Removing one known host as a
  // substring would leave a host standing before it, after it, or either side
  // of intervening text, so each assertion is on the whole stored string and
  // none of them is a substring test.
  assertEqualOrThrow(
    deriveDiagnosticTemplate('not found api.stripe.com and backup.stripe.com'),
    'not found <url> and <url>',
    'a host after a structural word, and the next host after intervening text, are both replaced whole',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate('Failed to POST https://api.stripe.com/v1/charges'),
    'Failed to <url>',
    'a scheme, host and path in one value become a single placeholder',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate('connecting to 10.20.30.40:9100 timed out'),
    'to <url> timed out',
    'a host and port between structural words become one placeholder',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate('Retry localhost:3001 now'),
    '<url> now',
    'a schemeless host and port are recognised too',
  );
  const multiHost = deriveDiagnosticSignature({ errorClass: 'Error', message: 'not found api.stripe.com and backup.stripe.com' });
  assertEqualOrThrow(
    multiHost.signature,
    'Error: not found <url> and <url>',
    'no host survives anywhere in the stored signature',
  );
  assertEqualOrThrow(
    multiHost.summary,
    'An unexpected problem occurred: not found <url> and <url>.',
    'no host survives anywhere in the operator-visible summary',
  );
  // A dotted name that is not a host is still redacted rather than kept.
  assertEqualOrThrow(
    deriveDiagnosticSignature({ errorClass: 'Error', message: 'Failed login for john.smith' }).signature,
    'Error: Failed <url>',
    'a dotted name outside a SQL phrase is replaced, not kept',
  );
  assertEqualOrThrow(
    deriveDiagnosticSignature({ errorClass: 'Error', message: 'could not deliver to ops@acme.example' }).signature,
    'Error: could not to',
    'an address containing an at-sign is dropped entirely',
  );
  // A schema reference is not a URL, so the SQL case still reads.
  assertEqualOrThrow(
    deriveDiagnosticTemplate('UNIQUE constraint failed: orders.customer_id'),
    'UNIQUE constraint failed: orders.customer_id',
    'a dotted SQL reference inside a SQL phrase survives as a schema reference',
  );

  console.log('\n5. An ordinary preposition is not evidence that a dotted token is a database object');
  // The escape hatch that keeps a dotted token is deliberately narrow. "to",
  // "by" and "found" are ordinary words, not SQL introducers, and a dotted value
  // after one of them is a value.
  assertEqualOrThrow(
    deriveDiagnosticSignature({ errorClass: 'Error', message: 'connect to api.stripe.com' }).signature,
    'Error: to <url>',
    'a hostname after "to" never reaches the stored signature',
  );
  assertEqualOrThrow(
    deriveDiagnosticSignature({ errorClass: 'Error', message: 'auth failed by user.name' }).signature,
    'Error: failed by <url>',
    'a username after "by" never reaches the stored signature',
  );
  // The case the URL pattern cannot catch: an underscore is not a host-label
  // character, so this reaches the dotted rule and the narrowed vocabulary is
  // the only thing standing between it and the signature.
  assertEqualOrThrow(
    deriveDiagnosticSignature({ errorClass: 'Error', message: 'tax service not found billing.ledger_v2' }).signature,
    'Error: not found',
    'a dotted value after "not found" is dropped, because "found" is not a SQL introducer',
  );
  assertEqualOrThrow(
    deriveDiagnosticSignature({ errorClass: 'Error', message: 'order cannot be read for user.profile_data' }).signature,
    'Error: order cannot be read',
    'a dotted value after an ordinary preposition is dropped even mid-sentence',
  );
  // And the database detail that makes these diagnostics worth having still
  // survives, so the fix has not quietly stripped it.
  assertEqualOrThrow(
    deriveDiagnosticTemplate('no such table: orders'),
    'no such table: orders',
    'a table name after "table" still survives',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate('UNIQUE constraint failed: orders.customer_id'),
    'UNIQUE constraint failed: orders.customer_id',
    'a qualified column reference after a constraint failure still survives',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate('no such column: customer_id'),
    'no such column: customer_id',
    'a column name after "column" still survives',
  );
  assertEqualOrThrow(
    deriveDiagnosticTemplate('index idx_orders_customer'),
    'index idx_orders_customer',
    'an index name after "index" still survives',
  );

  console.log('\n6. Unclassifiable values are dropped rather than kept');
  assertEqualOrThrow(deriveDiagnosticTemplate(''), '', 'an empty message yields an empty template');
  assertEqualOrThrow(deriveDiagnosticTemplate(undefined), '', 'a missing message yields an empty template');
  assertEqualOrThrow(
    deriveDiagnosticTemplate('saga 7742 Blorptastic'),
    '<number>',
    'a bare word that is not a schema reference is dropped, the number is not',
  );
  const dropped = deriveDiagnosticSignature({ errorClass: 'Error', message: 'saga Zorblax 7742' });
  assertOrThrow(!dropped.signature.includes('Zorblax'), 'an unknown bare word is dropped from the signature');
  assertEqualOrThrow(dropped.signature, 'Error: <number>', 'only the confidently classified literal survives');
  // Known limit of the derivation, recorded rather than hidden: a value made
  // entirely of structural words cannot be told apart from the fixed phrase.
  assertOrThrow(
    deriveDiagnosticTemplate('Table Key has no saved address') === 'Table Key has no',
    'known residual: a value composed only of structural words survives (documented in the module)',
  );

  console.log('\n7. The signature is shown to a human as a sentence, not a placeholder stack');
  const dbFailure = deriveDiagnosticSignature({ errorClass: 'SQLiteError', message: 'no such table: orders' });
  assertEqualOrThrow(
    dbFailure.summary,
    'The database rejected a request: no such table: orders.',
    'a database failure reads as a sentence naming the table',
  );
  assertOrThrow(
    /^[A-Z]/.test(dbFailure.summary) && !dbFailure.summary.startsWith('<'),
    'the summary is plain language rather than a placeholder stack',
  );
  const typeFailure = deriveDiagnosticSignature({ errorClass: 'TypeError', message: "x.map is not a function" });
  assertEqualOrThrow(typeFailure.error_class, 'TypeError', 'the error class is normalised, not lowercased away');
  assertOrThrow(typeFailure.summary.startsWith('A value had the wrong type'), 'an unlisted class still gets a plain-language clause');

  console.log('\n8. Hostile and malformed input cannot widen what is stored');
  assertEqualOrThrow(deriveDiagnosticSignature(null).signature, 'Error', 'a null source still yields a class-only signature');
  assertEqualOrThrow(
    deriveDiagnosticSignature({ errorClass: 'Error<script>', message: 'x' }).error_class,
    'Error',
    'a class name that is not an identifier is refused',
  );
  assertEqualOrThrow(
    deriveDiagnosticSignature({ errorClass: 'Rajesh Kumar', message: 'x' }).error_class,
    'Error',
    'a class name carrying spaces is refused rather than stored',
  );
  const long = deriveDiagnosticTemplate("'secret-value' ".repeat(200));
  assertOrThrow(long.length <= 240, 'an over-long message is bounded');

  console.log('\n9. Error class extraction is defensive');
  assertEqualOrThrow(errorClassOf(new TypeError('x')), 'TypeError', 'a TypeError reports TypeError');
  assertEqualOrThrow(errorClassOf('a string'), 'Error', 'a non-error value reports the unknown class');
  assertEqualOrThrow(errorClassOf(null), 'Error', 'null reports the unknown class');
  assertEqualOrThrow(errorClassOf({ name: 'SQLiteError', message: 'x' }), 'SQLiteError', 'an error-shaped object reports its name');

  // PowerShell wraps a .NET method-call exception in its own text, so the whole
  // informative payload arrives as one quoted span and redacts to a placeholder.
  // No allowlist can rescue that, which is why degeneracy is measured, not reworded.
  const POWERSHELL_WRAPPED = 'Exception calling "SendRaw" with "1" argument(s): "printer is offline"';

  console.log('\n10. A template with no real words in it is reported as uninformative');
  const wrapped = deriveDiagnosticSignature({ errorClass: 'Error', message: POWERSHELL_WRAPPED });
  assertEqualOrThrow(wrapped.signature, 'Error: <string> with <string> <string>', 'the reported Windows case keeps its existing grouping key');
  assertOrThrow(wrapped.is_informative === false, 'a template made only of placeholders is not informative');
  const cupsGone = deriveDiagnosticSignature({ errorClass: 'Error', message: 'lp: No such file or directory' });
  assertOrThrow(cupsGone.is_informative === false, 'a two-word fragment is not informative');
  // What the operator gets is the floor, because `is_informative` is false; the
  // stored summary is pinned end to end in tests/diagnostics-screen.test.ts.
  assertOrThrow(!classClauseSummary(cupsGone.error_class).includes('No such'), 'the operator is not shown the two-word fragment');
  assertEqualOrThrow(deriveDiagnosticSignature({ errorClass: 'Error', message: 'getaddrinfo ENOTFOUND api.stripe.com' }).is_informative, false, 'a bare redacted host is not informative');
  assertEqualOrThrow(deriveDiagnosticSignature({ errorClass: 'Error', message: 'IPP status 0x409' }).is_informative, false, 'an empty template is not informative');
  // Punctuation left behind by a redacted placeholder is not a word.
  const punctuationOnly = deriveDiagnosticSignature({ errorClass: 'Error', message: '(api.stripe.com) (backup.stripe.com) (third.stripe.com)' });
  assertEqualOrThrow(punctuationOnly.signature, 'Error: (<url>) (<url>) (<url>)', 'each redacted host keeps its own placeholder');
  assertOrThrow(punctuationOnly.is_informative === false, 'punctuation-only fragments do not count as real words');
  assertEqualOrThrow(classClauseSummary('Error'), 'An unexpected problem occurred.', 'the floor for a non-print event is the class clause alone');
  assertEqualOrThrow(classClauseSummary('SQLiteError'), 'The database rejected a request.', 'the class clause is per error class');

  console.log('\n11. The floor is the plain-language line, and it carries no source text at all');
  const DEGENERATE_WITH_CUSTOMER_DATA = `Exception calling "SendRaw" with "1" argument(s): "Failed to settle bill for '${CUSTOMER_NAME}' at +91 ${PHONE} amount ${AMOUNT} from ${FILE_PATH}"`;
  const leakyDegenerate = deriveDiagnosticSignature({ errorClass: 'Error', message: DEGENERATE_WITH_CUSTOMER_DATA });
  assertOrThrow(leakyDegenerate.is_informative === false, 'customer data wrapped in one quoted span is degenerate');
  const floorSummary = leakyDegenerate.is_informative ? leakyDegenerate.summary : classClauseSummary(leakyDegenerate.error_class);
  assertEqualOrThrow(floorSummary, 'An unexpected problem occurred.', 'the floor is a fixed phrase, so the reason holds no source text');
  for (const secret of [CUSTOMER_NAME, 'Rajesh', PHONE, AMOUNT, FILE_PATH, 'SendRaw']) {
    assertOrThrow(!leakyDegenerate.signature.includes(secret), `the signature carries none of ${secret}`);
    assertOrThrow(!floorSummary.includes(secret), `the summary carries none of ${secret}`);
  }

  console.log('\n12. Two tills failing the same way store byte-identical text');
  const tillOne = deriveDiagnosticSignature({ errorClass: 'Error', message: POWERSHELL_WRAPPED });
  const tillTwo = deriveDiagnosticSignature({ errorClass: 'Error', message: 'Exception calling "SendRaw" with "2" argument(s): "printer is offline for FRONTDESK-LASER-01"' });
  assertEqualOrThrow(tillTwo.signature, tillOne.signature, 'the grouping key does not depend on the till or the argument count');
  assertEqualOrThrow(tillTwo.summary, tillOne.summary, 'the summary does not depend on the till or the argument count');
  assertOrThrow(!tillTwo.signature.includes('FRONTDESK'), 'the printer name is absent from the signature');
  assertOrThrow(tillTwo.is_informative === false, 'the printer name does not make the template informative');

  console.log('\n13. Cases that already read well are untouched by the new signal');
  for (const good of ['no such table: orders', 'UNIQUE constraint failed: orders.customer_id', 'printer is offline']) {
    const derived = deriveDiagnosticSignature({ errorClass: 'SQLiteError', message: good });
    assertOrThrow(derived.is_informative === true, `a readable message stays informative: ${good}`);
    assertEqualOrThrow(derived.summary, `The database rejected a request: ${good}.`, `a readable message keeps today's summary: ${good}`);
  }
  const stillGood = deriveDiagnosticSignature({ errorClass: 'Error', message: 'printer is offline' });
  assertEqualOrThrow(stillGood.summary, 'An unexpected problem occurred: printer is offline.', 'the reported unwrapped case keeps today\'s summary');
  assertEqualOrThrow(stillGood.signature, 'Error: printer is offline', 'the reported unwrapped case keeps today\'s signature');

  console.log('\n14. Every placeholder a template can carry is lowercased');
  for (const message of [POWERSHELL_WRAPPED, 'lp: No such file or directory', 'getaddrinfo ENOTFOUND api.stripe.com', 'IPP status 0x409', `<String>`, 'String <String>']) {
    const template = deriveDiagnosticTemplate(message);
    assertOrThrow(!/<[A-Z]/.test(template), `no placeholder can start with a capital letter: ${template}`);
  }

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
