const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

// Arch enum from builder-util: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
module.exports = async function afterPack(context) {
  const { appOutDir, packager, arch } = context;

  // ── Linux: copy AppStream metainfo to standard system path ────
  if (packager.platform.name === 'linux') {
    const metainfoSrc = path.join(packager.projectDir, 'assets/com.flo.desktop.metainfo.xml');
    const metainfoDest = path.join(appOutDir, 'share/metainfo/com.flo.desktop.metainfo.xml');
    if (fs.existsSync(metainfoSrc)) {
      fs.mkdirSync(path.dirname(metainfoDest), { recursive: true });
      fs.copyFileSync(metainfoSrc, metainfoDest);
      console.log(`→ afterPack: ✓ copied AppStream metainfo.xml`);
    }
    return;
  }

  // ── Mac: rebuild better-sqlite3 for arm64 ─────────────────────
  if (packager.platform.name !== 'mac') return;
  if (arch === 4) return; // skip the universal merge step
  if (arch !== 1 && arch !== 3) return; // only x64 and arm64

  const archName = arch === 1 ? 'x64' : 'arm64';
  const electronVersion = packager.electronVersion;
  const projectDir = packager.projectDir;

  console.log(`\n→ afterPack: rebuilding better-sqlite3 for darwin-${archName} (electron ${electronVersion})...`);

  const result = spawnSync(
    'npx',
    ['@electron/rebuild', '-f', '-w', 'better-sqlite3', '--arch', archName, '--target', electronVersion],
    { cwd: projectDir, stdio: 'inherit', shell: true }
  );

  if (result.status !== 0) {
    throw new Error(`better-sqlite3 rebuild failed for darwin-${archName} (exit ${result.status})`);
  }

  const srcBinary = path.join(
    projectDir,
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  );

  const destBinary = path.join(
    appOutDir,
    'Flo Cafe.app',
    'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  );

  if (!fs.existsSync(destBinary)) {
    console.warn(`→ afterPack: dest binary not found at ${destBinary}, skipping copy`);
    return;
  }

  fs.copyFileSync(srcBinary, destBinary);
  console.log(`→ afterPack: ✓ installed darwin-${archName} better-sqlite3 binary`);
};
