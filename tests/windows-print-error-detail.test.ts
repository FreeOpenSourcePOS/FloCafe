/**
 * Issue #789 regression coverage for Windows raw-print process failures.
 *
 * `printViaUSBWindows()` passes the raw-print helper as a PowerShell
 * `-EncodedCommand`, and Node's `execFile` error message embeds the complete
 * command line. When PowerShell failed at the process level without writing to
 * stderr, the printer `detail` used to be that message, so the whole base64
 * helper reached the API response, the toast, and the support ticket.
 *
 * These cases drive the real `printViaUSB()` transport with a stub `powershell`
 * first on PATH (the code path itself is platform-agnostic below the
 * `process.platform` check), so the subprocess error shapes are the ones Node
 * and PowerShell actually produce.
 *
 * Run: npm run test:thermal-capabilities
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { printViaUSB, describeWindowsPrintProcessFailure } from '../main/printers/thermal';

const FAKE_MODE_ENV = 'FLO_FAKE_PS_MODE';
const MAX_DETAIL_LENGTH = 400;

const STUB_POWERSHELL = `#!/bin/sh
case "$FLO_FAKE_PS_MODE" in
  exit_empty_stderr)
    exit 1
    ;;
  clean_stderr)
    printf 'Printer is offline\\n' >&2
    exit 1
    ;;
  clixml_stderr)
    printf '#< CLIXML\\r\\n<Objs Version="1.1.0.1"><S S="Error">The RPC server is unavailable._x000D__x000A_</S></Objs>\\r\\n' >&2
    exit 1
    ;;
  payload_path_stderr)
    printf "Could not find file '%s'.\\n" "$FLO_PRINT_FILE" >&2
    exit 1
    ;;
  verbose_stderr)
    printf '%s\\n' "________________________________________" >&2
    i=0
    while [ $i -lt 200 ]; do
      printf 'Exception calling SendRaw with spool detail %s\\n' "$i" >&2
      i=$((i + 1))
    done
    exit 1
    ;;
  signal_death)
    kill -9 $$
    ;;
  hang)
    sleep 30
    ;;
  *)
    printf 'unknown stub mode\\n' >&2
    exit 2
    ;;
esac
`;

/** Matches a base64 blob the way the encoded helper would appear. */
const BASE64_BLOB = /[A-Za-z0-9+/]{60,}={0,2}/;
const PAYLOAD_FILE_NAME = /flo_print_\d+_\d+\.bin/;

let stubDir = '';
let emptyDir = '';
let originalPath = '';
let originalPlatform = '';

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function runWindowsDispatch(
  mode: string,
  options: { signal?: AbortSignal; hidePowerShell?: boolean } = {},
): Promise<{ ok: boolean; detail?: string; failureClass?: string }> {
  process.env[FAKE_MODE_ENV] = mode;
  process.env.PATH = options.hidePowerShell
    ? emptyDir
    : `${stubDir}${path.delimiter}${originalPath}`;
  return printViaUSB(Buffer.from('FLO-RAW-PRINT-PAYLOAD'), 'Fake Printer', options.signal);
}

function assertNoSubprocessEvidence(detail: string, label: string): void {
  assert.ok(!detail.includes('-EncodedCommand'), `${label}: encoded-command switch must not escape`);
  assert.ok(!detail.includes('-NoProfile'), `${label}: command arguments must not escape`);
  assert.ok(!detail.includes('Command failed:'), `${label}: the raw command line must not escape`);
  assert.ok(!BASE64_BLOB.test(detail), `${label}: the encoded helper payload must not escape`);
  assert.ok(!PAYLOAD_FILE_NAME.test(detail), `${label}: the payload temp file must not escape`);
  assert.ok(!detail.includes(stubDir), `${label}: helper paths must not escape`);
}

function assertProcessClassifications(): void {
  // Stable classifications for the process-level shapes Node reports, plus
  // the defensive default for anything unrecognized.
  assert.equal(
    describeWindowsPrintProcessFailure({ killed: true, signal: 'SIGTERM', code: null, message: 'Command failed: powershell -EncodedCommand AAAA' }),
    'Windows print command timed out',
  );
  assert.equal(
    describeWindowsPrintProcessFailure({ name: 'AbortError', code: 'ABORT_ERR' }),
    'Windows print command was cancelled',
  );
  assert.equal(
    describeWindowsPrintProcessFailure({ code: 'ENOENT', syscall: 'spawn powershell' }),
    'Could not start the Windows print helper',
  );
  assert.equal(
    describeWindowsPrintProcessFailure({ code: 'EACCES', syscall: 'spawn powershell' }),
    'Could not start the Windows print helper',
  );
  assert.equal(describeWindowsPrintProcessFailure({}), 'Windows raw print failed');
}

async function main(): Promise<void> {
  assertProcessClassifications();

  originalPlatform = process.platform;
  originalPath = process.env.PATH || '';

  // On native Windows hosts, child_process.execFile('powershell') resolves
  // via PATHEXT (.exe) and cannot execute an extensionless POSIX shell script.
  // The subprocess transport cases below run on POSIX hosts with a mocked
  // process.platform = 'win32'.
  if (originalPlatform === 'win32') {
    console.log('Issue #789 Windows raw-print failure detail tests passed (win32 unit mode)');
    return;
  }

  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fake-powershell-'));
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-empty-path-'));
  fs.writeFileSync(path.join(stubDir, 'powershell'), STUB_POWERSHELL, { mode: 0o755 });
  setPlatform('win32');

  try {
    // 1. The reported leak: the subprocess fails at the process level with no
    //    stderr, so the only available text was the command-bearing err.message.
    const emptyStderr = await runWindowsDispatch('exit_empty_stderr');
    assert.equal(emptyStderr.ok, false, 'a process-level failure reports a failure');
    assert.ok(emptyStderr.detail, 'a process-level failure keeps a diagnostic');
    assert.equal(emptyStderr.detail, 'Windows print helper exited with code 1');
    assert.ok(
      (emptyStderr.detail || '').length <= MAX_DETAIL_LENGTH,
      'the detail stays within the outward size bound',
    );
    assertNoSubprocessEvidence(emptyStderr.detail || '', 'empty stderr');

    // 2. Useful clean stderr is preserved instead of being replaced by the
    //    process classification, and it still drives the failure class.
    const cleanStderr = await runWindowsDispatch('clean_stderr');
    assert.equal(cleanStderr.detail, 'Printer is offline');
    assert.equal(cleanStderr.failureClass, 'offline', 'clean stderr keeps its classification');

    // 3. Existing CLIXML/progress framing cleanup keeps working through the
    //    dispatch boundary.
    const clixml = await runWindowsDispatch('clixml_stderr');
    assert.equal(clixml.detail, 'The RPC server is unavailable.');

    // 4. A temporary payload path inside otherwise useful stderr is redacted.
    const payloadPath = await runWindowsDispatch('payload_path_stderr');
    assert.equal(payloadPath.detail, "Could not find file '<payload file>'.");

    // 5. Long diagnostics are bounded before they leave the transport.
    const verbose = await runWindowsDispatch('verbose_stderr');
    assert.ok(verbose.detail, 'verbose stderr still yields a diagnostic');
    assert.ok(
      (verbose.detail || '').length <= MAX_DETAIL_LENGTH,
      `verbose stderr is bounded (got ${(verbose.detail || '').length} chars)`,
    );
    assert.ok((verbose.detail || '').includes('SendRaw'), 'the useful stderr text survives the bound');
    assert.ok((verbose.detail || '').endsWith('[truncated]'), 'the bound is marked as truncated');

    // 6. The helper executable is missing.
    const missingHelper = await runWindowsDispatch('exit_empty_stderr', { hidePowerShell: true });
    assert.equal(missingHelper.detail, 'Could not start the Windows print helper');
    assertNoSubprocessEvidence(missingHelper.detail || '', 'missing helper');

    // 7. Abort/termination while the helper is running.
    const controller = new AbortController();
    const aborted = runWindowsDispatch('hang', { signal: controller.signal });
    setTimeout(() => controller.abort(), 250);
    const abortResult = await aborted;
    assert.equal(abortResult.detail, 'Windows print command was cancelled');
    assertNoSubprocessEvidence(abortResult.detail || '', 'aborted helper');

    // 8. A helper killed by a signal it did not receive from us.
    const signalDeath = await runWindowsDispatch('signal_death');
    assert.equal(signalDeath.detail, 'Windows print helper was terminated (SIGKILL)');
    assertNoSubprocessEvidence(signalDeath.detail || '', 'terminated helper');

    console.log('Issue #789 Windows raw-print failure detail tests passed');
  } finally {
    delete process.env[FAKE_MODE_ENV];
    process.env.PATH = originalPath;
    setPlatform(originalPlatform);
    if (stubDir) fs.rmSync(stubDir, { recursive: true, force: true });
    if (emptyDir) fs.rmSync(emptyDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
