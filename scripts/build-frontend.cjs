'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const rootDir = path.join(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const nodeModulesDir = path.join(frontendDir, 'node_modules');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const useShell = process.platform === 'win32';

function hasCurrentFrontendDependencies() {
  const installedLockPath = path.join(nodeModulesDir, '.package-lock.json');
  if (!fs.existsSync(nodeModulesDir) || !fs.existsSync(installedLockPath)) return false;

  try {
    const lockfile = JSON.parse(fs.readFileSync(path.join(frontendDir, 'package-lock.json'), 'utf8'));
    const installedLockfile = JSON.parse(fs.readFileSync(installedLockPath, 'utf8'));
    if (lockfile.lockfileVersion !== installedLockfile.lockfileVersion) return false;

    const lockedPackages = lockfile.packages;
    const installedPackages = installedLockfile.packages;
    if (!lockedPackages || !installedPackages) return false;

    for (const [packagePath, installedPackage] of Object.entries(installedPackages)) {
      if (packagePath === '') continue;
      if (!lockedPackages[packagePath] || !isDeepStrictEqual(installedPackage, lockedPackages[packagePath])) return false;
    }

    for (const [packagePath, lockedPackage] of Object.entries(lockedPackages)) {
      if (packagePath === '' || lockedPackage.optional) continue;
      if (!installedPackages[packagePath]) return false;
    }
  } catch {
    return false;
  }

  const checkResult = spawnSync(npmCmd, ['ls', '--all', '--json'], {
    cwd: frontendDir,
    stdio: 'ignore',
    shell: useShell,
  });
  return checkResult.status === 0;
}

if (!hasCurrentFrontendDependencies()) {
  console.log('[build:frontend] Installing frontend dependencies...');
  const installResult = spawnSync(npmCmd, ['ci'], {
    cwd: frontendDir,
    stdio: 'inherit',
    shell: useShell,
  });
  if (installResult.status !== 0) {
    process.exit(installResult.status ?? 1);
  }
}

const buildResult = spawnSync(npmCmd, ['run', 'build'], {
  cwd: frontendDir,
  stdio: 'inherit',
  shell: useShell,
  env: {
    ...process.env,
    NEXT_BUILD_MODE: 'desktop',
  },
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}
