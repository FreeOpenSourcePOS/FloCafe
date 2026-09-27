'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const nodeModulesDir = path.join(frontendDir, 'node_modules');

// Install frontend dependencies only if not already present
if (!fs.existsSync(nodeModulesDir)) {
  console.log('[build:frontend] Installing frontend dependencies...');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installResult = spawnSync(npmCmd, ['ci'], {
    cwd: frontendDir,
    stdio: 'inherit',
    shell: true,
  });
  if (installResult.status !== 0) {
    process.exit(installResult.status ?? 1);
  }
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const buildResult = spawnSync(npmCmd, ['run', 'build'], {
  cwd: frontendDir,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    NEXT_BUILD_MODE: 'desktop',
  },
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}
