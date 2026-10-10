// Git-hook installation for contributor checkouts only. CI, production installs, source
// archives without a work tree and frontend-only installs must install dependencies without
// touching Git configuration, so every non-contributor environment is skipped explicitly.
// Linked worktrees share Git configuration with the main checkout: install with HUSKY=0 there.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function skip(reason) {
  console.log(`husky: skipped (${reason})`);
}

function currentHooksPath() {
  const result = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

async function install() {
  if (process.env.HUSKY === '0') return skip('HUSKY=0');
  if (process.env.CI || process.env.NODE_ENV === 'production') {
    return skip('non-contributor environment');
  }
  if (!fs.existsSync(path.join(repoRoot, '.git'))) return skip('no Git work tree');

  const hooksPath = currentHooksPath();
  if (hooksPath && hooksPath !== '.husky/_') {
    return skip(`core.hooksPath is already set to ${hooksPath} by another tool`);
  }

  let husky;
  try {
    ({ default: husky } = await import('husky'));
  } catch {
    return skip('husky is not installed (development dependencies omitted)');
  }

  const failure = husky();
  if (failure) {
    console.error(`husky: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('husky: Git hooks installed at .husky/_');
}

await install();
