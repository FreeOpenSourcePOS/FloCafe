import { execFile } from 'child_process';
import type { FirewallState } from './secure-network';

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

/** `netsh ... show rule` prints rule fields when present and a "No rules match" line otherwise. */
export function parseRulePresent(output: string, exitCode: number): boolean {
  if (exitCode !== 0) return false;
  return new RegExp(`Rule Name:\\s+${FIREWALL_RULE_NAME}`, 'i').test(output);
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

/**
 * PowerShell script that re-runs the rule creation elevated. Only started from an explicit owner
 * action, so Windows shows one UAC prompt per click and never at startup.
 */
export function buildElevatedAddRuleScript(executablePath: string): string {
  // Start-Process joins ArgumentList with spaces and does not quote, so tokens with spaces are quoted here.
  const processToken = (arg: string): string => (/\s/.test(arg) ? `"${arg}"` : arg);
  const psList = (args: string[]): string =>
    args.map((arg) => `'${processToken(arg).replace(/'/g, "''")}'`).join(',');
  const elevated = (args: string[]): string =>
    `Start-Process -FilePath netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @(${psList(args)})`;
  return `${elevated(buildDeleteRuleArgs())};${elevated(buildAddRuleArgs(executablePath))}`;
}

function run(file: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
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
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    buildElevatedAddRuleScript(executablePath),
  ]);
  return result.code === 0;
}
