/**
 * PostHog identities. A person is the customer account (a hash of the store email), so every
 * terminal and every reinstall with the same email is one person. Each device has an
 * `install_ref` derived from the OS machine id, stable across reinstalls; it is the anonymous id
 * until the account is known and is then aliased into the account. With telemetry off nothing
 * links to either: events use a random id per launch.
 */

import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import { getDatabase, getSettingValue, upsertSettings } from '../db';

const INSTALL_SEED_SETTING = 'posthog_install_seed';
const ACCOUNT_REF_SETTING = 'posthog_account_ref';
const ALIASED_SETTING = 'posthog_aliased';
const LAUNCH_ID = randomUUID();

let cachedInstallRef: string | null = null;

function ref(namespace: string, value: string): string {
  return createHash('sha256').update(`flocafe-${namespace}:${value}`).digest('hex').slice(0, 16);
}

/** Extracts the OS machine id from the output each platform's source produces. */
export function parseMachineId(platform: NodeJS.Platform, output: string): string | null {
  const match =
    platform === 'darwin'
      ? /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{16,})"/.exec(output)
      : platform === 'win32'
        ? /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{16,})/.exec(output)
        : /^([0-9A-Fa-f]{32})\s*$/.exec(output.trim());
  const id = match?.[1]?.toLowerCase() ?? null;
  return id && !/^[0-]+$/.test(id) ? id : null;
}

function readMachineId(): string | null {
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 2_000,
      });
      return parseMachineId('darwin', output);
    }
    if (process.platform === 'win32') {
      const output = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
        { encoding: 'utf8', timeout: 2_000, windowsHide: true },
      );
      return parseMachineId('win32', output);
    }
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = parseMachineId(process.platform, fs.readFileSync(file, 'utf8'));
        if (id) return id;
      } catch {
        // Try the next source.
      }
    }
  } catch {
    // Sandboxed or unsupported: fall back to a stored seed.
  }
  return null;
}

/** The device: a hash of the machine id, or of a stored random seed when the OS gives none. */
export function readInstallRef(): string {
  if (cachedInstallRef) return cachedInstallRef;
  const machineId = readMachineId();
  if (machineId) {
    cachedInstallRef = ref('install', machineId);
    return cachedInstallRef;
  }
  let seed = getSettingValue(INSTALL_SEED_SETTING);
  if (!seed) {
    seed = randomUUID();
    upsertSettings({ [INSTALL_SEED_SETTING]: seed });
  }
  cachedInstallRef = ref('install', seed);
  return cachedInstallRef;
}

function normalizedEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
}

export function accountRefForEmail(email: string): string | undefined {
  const normalized = normalizedEmail(email);
  return normalized ? ref('account', normalized) : undefined;
}

/**
 * The customer account, also used as `store_ref`. The first key this database derives is kept,
 * so editing the store email later does not split the person; a reinstall derives it again.
 */
export function readAccountRef(): string | undefined {
  const stored = getSettingValue(ACCOUNT_REF_SETTING);
  if (stored && /^[0-9a-f]{16}$/.test(stored)) return stored;
  const owner = getDatabase()
    .prepare('SELECT email FROM users ORDER BY rowid ASC LIMIT 1')
    .get() as { email?: string | null } | undefined;
  const account =
    accountRefForEmail(getSettingValue('email') ?? '') ?? accountRefForEmail(owner?.email ?? '');
  if (account) upsertSettings({ [ACCOUNT_REF_SETTING]: account });
  return account;
}

export interface PostHogIdentity {
  distinctId: string;
  /** True for the account; device and per-launch ids stay anonymous. */
  identified: boolean;
  installRef?: string;
  accountRef?: string;
}

export function resolvePostHogIdentity(telemetryEnabled: boolean): PostHogIdentity {
  if (!telemetryEnabled) return { distinctId: `anon_${LAUNCH_ID}`, identified: false };
  const installRef = readInstallRef();
  const accountRef = readAccountRef();
  return accountRef
    ? { distinctId: `acct_${accountRef}`, identified: true, installRef, accountRef }
    : { distinctId: `inst_${installRef}`, identified: false, installRef };
}

/** The device id still needs aliasing into this account. Each pair is aliased once. */
export function pendingAlias(identity: PostHogIdentity): string | null {
  if (!identity.accountRef || !identity.installRef) return null;
  const pair = `${identity.accountRef}|${identity.installRef}`;
  return getSettingValue(ALIASED_SETTING) === pair ? null : `inst_${identity.installRef}`;
}

export function markAliased(identity: PostHogIdentity): void {
  if (identity.accountRef && identity.installRef) {
    upsertSettings({ [ALIASED_SETTING]: `${identity.accountRef}|${identity.installRef}` });
  }
}
