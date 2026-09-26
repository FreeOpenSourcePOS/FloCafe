/** Guards against reintroducing role-group authorization after the permission migration. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(fullPath) : entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

const runtimeFiles = [
  ...filesUnder(path.join(root, 'main', 'routes')),
  ...filesUnder(path.join(root, 'main', 'services')),
  path.join(root, 'main', 'kds-server.ts'),
  path.join(root, 'main', 'server-app.ts'),
];

for (const file of runtimeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /\brequireRole\s*\(/, `${path.relative(root, file)} must authorize with permissions`);
}

const allowedRolePolicyFiles = new Set([
  'main/routes/kds.ts',
  'main/routes/kitchen.ts',
  'main/routes/order-items.ts',
  'main/routes/orders.ts',
  'main/routes/bills.ts',
  'main/routes/index.ts',
  'main/routes/staff.ts',
  'main/services/kds.ts',
  'main/services/refund.ts',
  'main/kds-server.ts',
]);
for (const file of runtimeFiles) {
  const relative = path.relative(root, file);
  if (allowedRolePolicyFiles.has(relative)) continue;
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /\bhasRole\s*\(/, `${relative} contains an unreviewed direct role check`);
}

// The order card used to take one `isOwnerOrManager` prop and gate the refund
// button, the voided-items list, and item restoration with it, which let one
// permission quietly govern three others in both directions.
const ordersPage = fs.readFileSync(path.join(root, 'frontend/src/app/(dashboard)/orders/page.tsx'), 'utf8');
const orderCard = fs.readFileSync(path.join(root, 'frontend/src/components/orders/OrderCard.tsx'), 'utf8');

for (const permissionId of ['orders.item.cancel', 'orders.item.restore', 'refunds.initiate']) {
  assert.match(
    ordersPage,
    new RegExp(`tenantCan\\(currentTenant, '${permissionId.replace(/\./g, '\\.')}'\\)`),
    `the orders page reads ${permissionId} for itself`,
  );
}
for (const capability of ['canCancelItems', 'canRestoreItems', 'canRefund']) {
  assert.match(orderCard, new RegExp(`\\b${capability}: boolean;`), `OrderCard takes ${capability} as its own capability`);
  assert.match(ordersPage, new RegExp(`${capability}=\\{${capability}\\}`), `the orders page passes ${capability} through unchanged`);
}
assert.doesNotMatch(orderCard, /isOwnerOrManager/, 'the order card no longer collapses three permissions into one flag');
assert.match(orderCard, /\{canCancelItems && !isPaid/, 'item cancellation is gated on orders.item.cancel');
assert.match(orderCard, /\{inactiveItems\.length > 0 && canRestoreItems && \(/, 'viewing voided items is gated on orders.item.restore');
assert.match(orderCard, /\{showVoidedItems && inactiveItems\.length > 0 && canRestoreItems && \(/, 'restoring voided items is gated on orders.item.restore');
assert.match(orderCard, /\{canRefund && hasEligibleRefund && \(/, 'the refund button is gated on refunds.initiate');

console.log('Authorization static enforcement audit passed');
