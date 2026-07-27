import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Import kill-ports functions
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isFloProcess, FLO_PATTERNS } = require('../kill-ports.js');

const rootDir = path.resolve(__dirname, '..');

function runTest() {
  console.log('Testing kill-ports.js process identity matching...');

  // Positive cases (should match as Flo processes)
  const positiveCases = [
    'node /Users/dev/FloCafe/dist/index.js',
    '/Applications/Flo Cafe.app/Contents/MacOS/Flo Cafe',
    '/usr/bin/flocafe --no-sandbox',
    'electron . --appName=flo-desktop',
    'node /path/to/FloCafe/dev-server.js',
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

  console.log('Testing nuclear-reset.sh confirmation guard...');

  // Running nuclear-reset.sh in non-interactive mode without -y should fail
  const nonInteractiveResult = spawnSync('bash', [path.join(rootDir, 'nuclear-reset.sh')], {
    encoding: 'utf8',
    env: { ...process.env, FORCE: '', CI: '' },
  });

  assert.strictEqual(
    nonInteractiveResult.status,
    1,
    'Expected non-interactive nuclear-reset.sh without -y flag to fail with exit code 1',
  );
  assert.match(
    nonInteractiveResult.stdout + nonInteractiveResult.stderr,
    /Non-interactive shell detected/i,
    'Expected output to warn about non-interactive shell',
  );

  console.log('✓ nuclear-reset.sh non-interactive confirmation guard verified');

  console.log('All dev tooling script tests passed cleanly!');
}

runTest();
