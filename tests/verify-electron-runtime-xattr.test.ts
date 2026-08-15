/**
 * Regression coverage for GHSA-wjr9-g33j-w22x (CWE-754): the macOS Electron
 * runtime verifier must not treat unexpected `xattr` failures as a clean
 * quarantine check. Only the documented "attribute absent" result (exit 1
 * with "No such xattr") is an acceptable clean state.
 *
 * This exercises the pure classification function from the cross-platform
 * verifier, so it runs on every platform without needing `xattr`/`codesign`.
 */
import * as assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyQuarantine } = require('../scripts/verify-electron-runtime.cjs');

function run() {
  console.log('Testing Electron runtime xattr classification...');

  // Present attribute (exit 0, value on stdout) → must fail as quarantined.
  const present = classifyQuarantine(0, '', '0083;1234567890;Electron');
  assert.equal(present.state, 'present', 'exit 0 with stdout is "present"');
  assert.equal(present.value, '0083;1234567890;Electron', 'present value is captured from stdout');

  // Absent attribute (exit 1 + "No such xattr") → the only clean state.
  const absent = classifyQuarantine(1, 'xattr: No such xattr: com.apple.quarantine', '');
  assert.equal(absent.state, 'absent', 'exit 1 with "No such xattr" is "absent"');

  // Unexpected failure (exit 1 + permission denied) → must NOT be clean.
  const permissionDenied = classifyQuarantine(1, 'xattr: [Errno 13] Permission denied: /path/Electron.app', '');
  assert.equal(permissionDenied.state, 'error', 'exit 1 with a permission error is "error", not clean');
  assert.match(permissionDenied.message, /Permission denied/, 'permission error message is preserved');

  // Unexpected failure (exit 1 + empty stderr) → must NOT be clean.
  const silentFailure = classifyQuarantine(1, '', '');
  assert.equal(silentFailure.state, 'error', 'exit 1 with no "No such xattr" stderr is "error", not clean');

  // Missing tool (exit 127) → must NOT be clean.
  const missingTool = classifyQuarantine(127, 'xattr: command not found', '');
  assert.equal(missingTool.state, 'error', 'exit 127 (missing tool) is "error", not clean');

  console.log('✅ Electron runtime xattr classification checks passed');
}

run();
