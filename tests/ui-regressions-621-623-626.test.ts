/**
 * Source-level guards for the UI regressions fixed by issues #621, #623, and #626.
 * Behavioral table update coverage lives in tables-string-ids.test.ts; these checks
 * keep the responsive layout and dark-mode utilities from being accidentally removed.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const tables = source('frontend/src/app/(dashboard)/tables/page.tsx');
assert.match(tables, /currentTenant\?\.role === 'owner'.*currentTenant\?\.role === 'manager'/, 'table management controls stay role-gated');
assert.match(tables, /api\.put\(`\/tables\/\$\{editingTable\.id\}`/, 'table editor persists through PUT');
assert.match(tables, /TABLE_NAME_DUPLICATE: tTables\('tableNameDuplicate'\)/, 'backend table errors map to localized UI messages');
assert.match(tables, /TABLE_LOCATION_INVALID: tTables\('tableLocationInvalid'\)/, 'backend location errors map to localized UI messages');
assert.match(tables, /Number\.isInteger\(capacity\).*capacity < 1/s, 'table capacity is validated before submission');
assert.match(tables, /tTables\('allFloors'\)/, 'floor filter retains its all-floors option');
assert.match(tables, /\[table\.floor, table\.section\]/, 'floor and section remain visible together');

const whatsapp = source('frontend/src/components/settings/WhatsAppEnableCard.tsx');
assert.match(whatsapp, /font-semibold text-foreground/, 'WhatsApp enable heading uses theme foreground');

const settings = source('frontend/src/app/(dashboard)/settings/page.tsx');
assert.match(settings, /dark:bg-yellow-950\/50 dark:border-yellow-800/, 'update warning has a dark-mode surface');
assert.match(settings, /text-yellow-700 dark:text-yellow-300/, 'update warning copy has dark-mode contrast');
assert.match(settings, /text-red-600 dark:text-red-300/, 'update failure copy has dark-mode contrast');

const kds = source('frontend/src/hooks/useKdsConnection.ts');
assert.match(kds, /bg-yellow-50 dark:bg-yellow-950\/60/, 'waiting KDS cards use a dark-mode background');
assert.match(kds, /text-yellow-700 dark:text-yellow-300/, 'waiting KDS labels use dark-mode text');

const customers = source('frontend/src/app/(dashboard)/customers/page.tsx');
assert.match(customers, /text-muted-foreground whitespace-nowrap.*formatDate/, 'ledger dates use semantic text color');
assert.match(customers, /text-end text-foreground whitespace-nowrap.*fmt\(b\.total\)/, 'ledger totals use semantic text color');

const payment = source('frontend/src/components/pos/PaymentModal.tsx');
assert.match(payment, /sm:max-w-4xl/, 'desktop payment modal stays wide');
assert.match(payment, /lg:grid lg:grid-cols-2/, 'desktop payment content stays side by side');
assert.match(payment, /max-h-\[75vh\] overflow-y-auto.*lg:grid lg:grid-cols-2/, 'desktop payment stays two-column with bounded overflow fallback');
assert.doesNotMatch(payment, /lg:overflow-visible/, 'desktop payment does not clip controls outside its bounded container');

console.log('✓ UI regression guards for issues #621, #623, and #626 passed');
