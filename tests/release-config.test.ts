/**
 * Release integrity checks — catches the class of bug where macOS
 * auto-update silently 404'd on latest-mac.yml for every release from
 * v1.6.7 through v1.9.11: electron-builder needs a `zip` mac target to
 * produce that manifest, and the release workflow has to actually upload
 * it (and the Windows/NSIS equivalent, latest.yml) alongside the installer.
 * None of this requires an actual platform build — it's a config/workflow
 * shape check, fast enough to run on every `npm test`.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function run() {
  console.log('Testing release config + workflow integrity...');

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const build = pkg.build;

  // ── electron-builder config ──────────────────────────────────────────
  assert.ok(build?.publish?.provider === 'github', 'build.publish must target GitHub releases');

  const macTargets = (build?.mac?.target || []).map((t: any) => t.target);
  assert.ok(
    macTargets.includes('zip'),
    'mac build target must include "zip" — DMG alone cannot be used for electron-updater\'s ' +
    'silent background updates, and without a zip target electron-builder never produces latest-mac.yml'
  );

  const winTargets = (build?.win?.target || []).map((t: any) => t.target);
  assert.ok(
    winTargets.includes('nsis'),
    'win build target must include "nsis" — electron-updater\'s Windows auto-update relies on ' +
    'the NSIS installer + latest.yml'
  );

  // ── release workflow uploads the auto-update manifests, not just installers ──
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');

  const macJob = workflow.split(/^\s*release-mac:/m)[1]?.split(/^\s*release-windows:/m)[0] || '';
  assert.ok(macJob.includes('latest-mac.yml'), 'release-mac job must upload latest-mac.yml');
  assert.ok(/release\/\*\.zip\b/.test(macJob), 'release-mac job must upload the .zip artifact');
  assert.ok(macJob.includes('.zip.blockmap'), 'release-mac job must upload the .zip.blockmap');

  const winJob = workflow.split(/^\s*release-windows:/m)[1] || '';
  assert.ok(winJob.includes('latest.yml'), 'release-windows job must upload latest.yml');
  assert.ok(winJob.includes('.exe.blockmap'), 'release-windows job must upload the .exe.blockmap');

  console.log('✅ Release config + workflow integrity checks passed');
}

run();
