import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import kill-ports functions
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isFloProcess, FLO_PATTERNS } = require('../kill-ports.js');

const rootDir = path.resolve(__dirname, '..');
const resetScript = path.join(rootDir, 'scripts/dev/nuclear-reset.sh');

function mkdirp(target: string) {
  fs.mkdirSync(target, { recursive: true });
}

function runReset(platform: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [resetScript, '--electron-cache-only'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE: '',
      CI: '',
      FLO_RESET_PLATFORM: platform,
      ...env,
    },
  });
}

function runTest() {
  console.log('Testing kill-ports.js process identity matching...');

  // Positive cases (should match as Flo processes)
  const positiveCases = [
    'node /Users/dev/FloCafe/dist/index.js',
    '/Applications/Flo Cafe.app/Contents/MacOS/Flo Cafe',
    '/usr/bin/flocafe --no-sandbox',
    'electron . --appName=flo-desktop',
    'node /path/to/FloCafe/dev-server.js',
    'node /path/to/FloCafe/dist/index.js',
    'com.flo.desktop.helper',
    'flo-pos-service',
  ];

  for (const cmd of positiveCases) {
    assert.strictEqual(
      isFloProcess(cmd),
      true,
      `Expected "${cmd}" to match Flo process patterns`,
    );
  }

  // Negative cases (should NOT match as Flo processes)
  const negativeCases = [
    'node /Users/dev/other-project/index.js',
    'node /Users/other-project/dist/index.js',
    'node /Users/other-project/dev-server.js',
    'node /home/user/app/dev-server.js',
    'node /Users/dev/FloCafe/other-server.js',
    'node /Users/dev/FloCafe-tools/dev-server.js',
    'python3 -m http.server 3000',
    'nginx: master process',
    'postgres -D /data',
    'redis-server *:6379',
  ];

  for (const cmd of negativeCases) {
    assert.strictEqual(
      isFloProcess(cmd),
      false,
      `Expected "${cmd}" to NOT match Flo process patterns`,
    );
  }

  console.log('✓ kill-ports.js pattern matching verified');

  console.log('Testing scripts/dev/nuclear-reset.sh confirmation guard...');

  // Running the reset script in non-interactive mode without -y should fail.
  const nonInteractiveResult = spawnSync('bash', [resetScript], {
    encoding: 'utf8',
    env: { ...process.env, FORCE: '', CI: '' },
  });

  assert.strictEqual(
    nonInteractiveResult.status,
    1,
    'Expected non-interactive reset without -y flag to fail with exit code 1',
  );
  assert.match(
    nonInteractiveResult.stdout + nonInteractiveResult.stderr,
    /Non-interactive shell detected/i,
    'Expected output to warn about non-interactive shell',
  );

  console.log('✓ development reset non-interactive confirmation guard verified');

  console.log('Testing nuclear-reset.sh Electron cache paths...');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reset-cache-test-'));
  try {
    const darwinHome = path.join(tmpDir, 'darwin-home');
    const darwinPaths = [
      path.join(darwinHome, 'Library/Application Support/flo-desktop/Cache'),
      path.join(darwinHome, 'Library/Application Support/flo-desktop/Code Cache'),
      path.join(darwinHome, 'Library/Caches/flo-desktop'),
    ];
    darwinPaths.forEach(mkdirp);
    const darwinResult = runReset('Darwin', { HOME: darwinHome });
    assert.strictEqual(darwinResult.status, 0, `Expected Darwin cache cleanup to pass: ${darwinResult.stderr}`);
    darwinPaths.forEach((cachePath) => {
      assert.strictEqual(fs.existsSync(cachePath), false, `Expected Darwin cache path to be removed: ${cachePath}`);
    });
    assert.match(darwinResult.stdout, /Cleared: Electron app cache/, 'Expected Darwin app cache removal message');
    assert.match(darwinResult.stdout, /Cleared: Electron code cache/, 'Expected Darwin code cache removal message');
    assert.match(darwinResult.stdout, /Cleared: Electron system cache/, 'Expected Darwin system cache removal message');

    const linuxHome = path.join(tmpDir, 'linux-home');
    const linuxConfigHome = path.join(tmpDir, 'linux-config');
    const linuxCacheHome = path.join(tmpDir, 'linux-cache');
    const linuxPaths = [
      path.join(linuxConfigHome, 'flo-desktop/Cache'),
      path.join(linuxConfigHome, 'flo-desktop/Code Cache'),
      path.join(linuxCacheHome, 'flo-desktop'),
    ];
    linuxPaths.forEach(mkdirp);
    const linuxResult = runReset('Linux', {
      HOME: linuxHome,
      XDG_CONFIG_HOME: linuxConfigHome,
      XDG_CACHE_HOME: linuxCacheHome,
    });
    assert.strictEqual(linuxResult.status, 0, `Expected Linux cache cleanup to pass: ${linuxResult.stderr}`);
    linuxPaths.forEach((cachePath) => {
      assert.strictEqual(fs.existsSync(cachePath), false, `Expected Linux cache path to be removed: ${cachePath}`);
    });

    const windowsAppData = path.join(tmpDir, 'windows-appdata');
    const windowsLocalAppData = path.join(tmpDir, 'windows-localappdata');
    const windowsPaths = [
      path.join(windowsAppData, 'flo-desktop/Cache'),
      path.join(windowsAppData, 'flo-desktop/Code Cache'),
      path.join(windowsLocalAppData, 'flo-desktop'),
    ];
    windowsPaths.forEach(mkdirp);
    const windowsResult = runReset('Windows_NT', {
      APPDATA: windowsAppData,
      LOCALAPPDATA: windowsLocalAppData,
    });
    assert.strictEqual(windowsResult.status, 0, `Expected Windows cache cleanup to pass: ${windowsResult.stderr}`);
    windowsPaths.forEach((cachePath) => {
      assert.strictEqual(fs.existsSync(cachePath), false, `Expected Windows cache path to be removed: ${cachePath}`);
    });

    const missingWindowsResult = runReset('Windows_NT', {
      APPDATA: '',
      LOCALAPPDATA: '',
    });
    assert.strictEqual(missingWindowsResult.status, 0, 'Expected missing Windows cache roots to be reported without failing');
    assert.match(
      missingWindowsResult.stdout,
      /Skipped: Electron app\/code cache unavailable \(APPDATA is not set\)/,
      'Expected missing APPDATA diagnostic',
    );
    assert.match(
      missingWindowsResult.stdout,
      /Skipped: Electron system cache unavailable \(LOCALAPPDATA is not set\)/,
      'Expected missing LOCALAPPDATA diagnostic',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('✓ nuclear reset Electron cache paths verified');

  console.log('All dev tooling script tests passed cleanly!');
}

runTest();
