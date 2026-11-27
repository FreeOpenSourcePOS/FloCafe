import { execFile } from 'child_process';
import type { FirewallState } from './secure-network';

/** Waiting on a human answering the UAC prompt, so far longer than a normal command. */
const ELEVATION_TIMEOUT_MS = 180_000;

export const FIREWALL_RULE_NAME = 'FloCafe Secure Network';

/** Every HTTPS port the ladders can land on: 443 for the main surface, then 3441-3470. */
export const FIREWALL_LOCAL_PORTS = '443,3441-3470';

export function buildAddRuleArgs(executablePath: string): string[] {
  return [
    'advfirewall',
    'firewall',
    'add',
    'rule',
    `name=${FIREWALL_RULE_NAME}`,
    'dir=in',
    'action=allow',
    `program=${executablePath}`,
    'protocol=TCP',
    `localport=${FIREWALL_LOCAL_PORTS}`,
    'profile=private',
    'remoteip=localsubnet',
    'enable=yes',
  ];
}

export function buildDeleteRuleArgs(): string[] {
  return ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE_NAME}`];
}

export function buildShowRuleArgs(): string[] {
  return ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE_NAME}`];
}

/**
 * `netsh ... show rule` exits non-zero when no rule matches. Its field labels are localized, so
 * only the exit code and the (untranslated) rule name in the output are used.
 */
export function parseRulePresent(output: string, exitCode: number): boolean {
  return exitCode === 0 && output.toLowerCase().includes(FIREWALL_RULE_NAME.toLowerCase());
}

export function parseNetworkProfile(output: string): FirewallState['networkProfile'] {
  const categories = output
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (categories.includes('public')) return 'public';
  if (categories.includes('private')) return 'private';
  if (categories.some((c) => c.startsWith('domain'))) return 'domain';
  return 'unknown';
}

/** Inner script: delete then add, exiting with the add's result so a failure is never reported as success. */
export function buildFirewallRepairScript(executablePath: string): string {
  const quote = (arg: string): string => `'${arg.replace(/'/g, "''")}'`;
  const call = (args: string[]): string => `& netsh ${args.map(quote).join(' ')}`;
  return `${call(buildDeleteRuleArgs())}; ${call(buildAddRuleArgs(executablePath))}; exit $LASTEXITCODE`;
}

/**
 * Outer script: one elevated process (one UAC prompt) running the inner script, whose exit code is
 * propagated. Only started from an explicit owner action, never at startup.
 */
export function buildElevatedAddRuleScript(executablePath: string): string {
  const encoded = Buffer.from(buildFirewallRepairScript(executablePath), 'utf16le').toString(
    'base64',
  );
  return (
    `$ErrorActionPreference = 'Stop'; ` +
    `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
    `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; ` +
    `if (-not $p) { exit 1 }; exit $p.ExitCode`
  );
}

function run(
  file: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
      const exitCode = (error as { code?: unknown } | null)?.code;
      resolve({
        stdout: String(stdout ?? ''),
        code: error ? (typeof exitCode === 'number' && exitCode !== 0 ? exitCode : 1) : 0,
      });
    });
  });
}

export async function readWindowsFirewallState(): Promise<FirewallState> {
  if (process.platform !== 'win32') {
    return { supported: false, ruleInstalled: null, networkProfile: 'unknown' };
  }
  const rule = await run('netsh', buildShowRuleArgs());
  const profile = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-NetConnectionProfile | ForEach-Object { $_.NetworkCategory.ToString() }) -join "`n"',
  ]);
  return {
    supported: true,
    ruleInstalled: parseRulePresent(rule.stdout, rule.code),
    networkProfile: parseNetworkProfile(profile.stdout),
  };
}

/** Starts the elevated rule creation. Resolves false if the owner declines the UAC prompt. */
export async function installFirewallRuleElevated(executablePath: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', buildElevatedAddRuleScript(executablePath)],
    ELEVATION_TIMEOUT_MS,
  );
  return result.code === 0;
}
