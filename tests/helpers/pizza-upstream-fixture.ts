/**
 * Run by tests/pizza-migrations.test.ts in a child process against an unmodified upstream tree:
 * writes a database and a backup that no pizza code has ever touched.
 */
const Module = require('module');
const originalLoad = Module._load;
const path = require('node:path');
const outDir = process.env.PIZZA_FIXTURE_OUT as string;
const upstreamTree = process.env.PIZZA_FIXTURE_TREE as string;
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => outDir, getVersion: () => 'upstream' } };
  return originalLoad.apply(this, arguments as any);
};

const upstream = require(path.join(upstreamTree, 'main/db'));

(async () => {
  upstream.initDatabase();
  const db = upstream.getDatabase();
  db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('up-cat', 'Upstream category');
  db.prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)').run(
    'up-prod',
    'up-cat',
    'Upstream product',
    12.5,
  );
  await upstream.createBackup(path.join(outDir, 'upstream-backup.db'));
  db.pragma('wal_checkpoint(TRUNCATE)');
  upstream.closeDatabase();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
