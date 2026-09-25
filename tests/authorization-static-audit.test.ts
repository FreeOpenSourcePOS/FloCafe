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

console.log('Authorization static enforcement audit passed');
