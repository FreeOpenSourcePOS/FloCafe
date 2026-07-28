const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

// better-sqlite3 ≤ v12 ships build/Release/better_sqlite3.node
// better-sqlite3 ≥ v13 ships prebuilds/darwin-arm64.node, prebuilds/darwin-x64.node, etc.
const NATIVE_BINARY_NAMES = new Set([
  'better_sqlite3.node',
  'darwin-arm64.node',
  'darwin-x64.node',
  'linux-arm64.node',
  'linux-x64.node',
  'linuxmusl-arm64.node',
  'linuxmusl-x64.node',
  'win32-arm64.node',
  'win32-x64.node',
]);

function findNativeBinaries(root) {
  const matches = [];
  const visit = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isFile() && NATIVE_BINARY_NAMES.has(entry.name)) {
        matches.push(candidate);
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(candidate);
      }
    }
  };

  if (fs.existsSync(root)) visit(root);
  return matches;
}

// Arch enum from builder-util: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
module.exports = async function afterPack(context) {
  const { appOutDir, packager, arch } = context;

  // ── Linux: copy AppStream metainfo to standard system path ────
  if (packager.platform.name === 'linux') {
    const metainfoSrc = path.join(packager.projectDir, 'assets/com.flo.desktop.metainfo.xml');
    const metainfoDest = path.join(appOutDir, 'share/metainfo/com.flo.desktop.metainfo.xml');
    if (fs.existsSync(metainfoSrc)) {
      try {
        fs.mkdirSync(path.dirname(metainfoDest), { recursive: true });
        fs.copyFileSync(metainfoSrc, metainfoDest);
        console.log(`→ afterPack: ✓ copied AppStream metainfo.xml`);
      } catch (error) {
        throw new Error(
          `afterPack: failed to copy metainfo from ${metainfoSrc} to ${metainfoDest}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return;
  }

  // ── Mac: validate better-sqlite3 in the packaged app ──────────
  if (packager.platform.name !== 'mac') return;
  if (arch === 4) return; // skip the universal merge step
  if (arch !== 1 && arch !== 3) return; // only x64 and arm64

  const archName = arch === 1 ? 'x64' : 'arm64';
  const expectedMachArch = arch === 1 ? 'x86_64' : 'arm64';

  // Expected prebuild filename for better-sqlite3 ≥ v13
  const expectedPrebuild = `darwin-${archName}.node`;

  const packagedBinaries = findNativeBinaries(appOutDir);
  // Prefer binaries inside app.asar.unpacked (where electron-builder puts them)
  const unpackedBinaries = packagedBinaries.filter((candidate) =>
    candidate.includes(`${path.sep}app.asar.unpacked${path.sep}`)
  );

  // Pick the best candidate: prefer the platform-specific prebuild, then any
  // legacy better_sqlite3.node, then anything else we found in the unpacked dir.
  const packagedBinary =
    unpackedBinaries.find((p) => path.basename(p) === expectedPrebuild) ||
    unpackedBinaries.find((p) => path.basename(p) === 'better_sqlite3.node') ||
    unpackedBinaries[0];

  if (packagedBinary && fs.statSync(packagedBinary).size > 0) {
    const inspection = spawnSync('file', [packagedBinary], { encoding: 'utf8' });
    if (inspection.status !== 0 || !inspection.stdout.includes(expectedMachArch)) {
      throw new Error(
        `packaged better-sqlite3 binary has unexpected architecture for darwin-${archName}: ${inspection.stdout || inspection.stderr}`
      );
    }
    console.log(`→ afterPack: ✓ validated darwin-${archName} better-sqlite3 binary at ${packagedBinary}`);
    return;
  }

  // Temporary diagnostics: preserve evidence when a runner packages a
  // prebuild under a different path. Do not accept a host binary silently.
  const sourceRoot = path.join(packager.projectDir, 'node_modules', 'better-sqlite3');
  const sourceBinaries = findNativeBinaries(sourceRoot);
  console.error(`→ afterPack: packaged better-sqlite3 binary search (${appOutDir}):`, packagedBinaries);
  console.error(`→ afterPack: project better-sqlite3 binary search (${sourceRoot}):`, sourceBinaries);
  throw new Error(
    `packaged better-sqlite3 native binary not found for darwin-${archName} under ${appOutDir}`
  );
};
