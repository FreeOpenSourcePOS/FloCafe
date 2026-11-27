/** An installed KDS or Server App must open its own page, not the POS dashboard. */
import * as fs from 'fs';
import * as path from 'path';
import { assertEqualOrThrow, assertIncludesOrThrow } from './helpers/test-setup';

const frontend = path.join(__dirname, '../frontend');
const read = (file: string) => fs.readFileSync(path.join(frontend, file), 'utf8');

for (const [page, file] of [
  ['/kds-standalone', 'kds-manifest.json'],
  ['/server-standalone', 'server-manifest.json'],
]) {
  assertIncludesOrThrow(
    read(`src/app${page}/layout.tsx`),
    `manifest: '/${file}'`,
    `${page} links its own manifest`,
  );
  const manifest = JSON.parse(read(`public/${file}`));
  assertEqualOrThrow(manifest.start_url, page, `the installed app opens ${page}`);
  assertEqualOrThrow(manifest.id, page, `${page} installs apart from the POS`);
}

console.log('install manifest tests passed');
process.exit(0);
