#!/usr/bin/env node
/*
 * The Windows uninstaller has no safe PowerShell runtime on the Unix CI lanes.
 * Run the real Pester fixture when PowerShell and Pester are available; otherwise
 * report the limitation explicitly and leave Windows-only execution to CI or a
 * Windows maintainer workstation.
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findPowerShell() {
  for (const command of process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh']) {
    const probe = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (probe.status === 0) return command;
  }
  return null;
}

if (process.platform !== 'win32') {
  console.log('SKIP windows uninstaller Pester tests: Windows runtime required (this runner is not Windows).');
  process.exit(0);
}

const powershell = findPowerShell();
if (!powershell) {
  console.log('SKIP windows uninstaller Pester tests: PowerShell is unavailable on this Windows runner.');
  process.exit(0);
}

const pesterProbe = spawnSync(
  powershell,
  ['-NoProfile', '-NonInteractive', '-Command', "$p = Get-Module -ListAvailable -Name Pester | Sort-Object Version -Descending | Select-Object -First 1; if ($p -and $p.Version.Major -ge 5) { exit 0 } elseif ($p) { exit 78 } else { exit 77 }"],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
if (pesterProbe.status === 77) {
  console.log('SKIP windows uninstaller Pester tests: Pester is not installed (Windows-runtime limitation).');
  process.exit(0);
}
if (pesterProbe.status === 78) {
  console.log('SKIP windows uninstaller Pester tests: Pester 5 or newer is required.');
  process.exit(0);
}
if (pesterProbe.status !== 0) {
  process.stderr.write(pesterProbe.stderr || 'Unable to inspect the installed Pester module.\n');
  process.exit(pesterProbe.status || 1);
}

const testPath = path.resolve(__dirname, 'windows-uninstaller.Tests.ps1');
const command = `Invoke-Pester -Path '${testPath.replaceAll("'", "''")}' -CI`;
const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
  encoding: 'utf8',
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
