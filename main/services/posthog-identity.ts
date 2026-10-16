/**
 * PostHog identities per sharing level: `full` is the account (a hash of the store email),
 * `anonymous` is the device (a hash of a stored random seed), `off` is a random id per launch.
 */

import { createHash, randomUUID } from 'crypto';
import { getDatabase, getSettingValue, isTelemetryEnabled, upsertSettings } from '../db';

export const PRODUCT_ANALYTICS_LEVEL_SETTING = 'product_analytics_level';
export const PRODUCT_ANALYTICS_LEVELS = ['full', 'anonymous', 'off'] as const;
export type ProductAnalyticsLevel = (typeof PRODUCT_ANALYTICS_LEVELS)[number];

const INSTALL_SEED_SETTING = 'posthog_install_seed';
const ACCOUNT_REF_SETTING = 'posthog_account_ref';
const ALIASED_SETTING = 'posthog_aliased';
const LAUNCH_ID = randomUUID();

function ref(namespace: string, value: string): string {
  return createHash('sha256').update(`flocafe-${namespace}:${value}`).digest('hex').slice(0, 16);
}

/** The device: a hash of a random seed generated once and kept in this database. */
export function readInstallRef(): string {
  let seed = getSettingValue(INSTALL_SEED_SETTING);
  if (!seed) {
    seed = randomUUID();
    upsertSettings({ [INSTALL_SEED_SETTING]: seed });
  }
  return ref('install', seed);
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

export function parseProductAnalyticsLevel(value: unknown): ProductAnalyticsLevel | null {
  return PRODUCT_ANALYTICS_LEVELS.includes(value as ProductAnalyticsLevel)
    ? (value as ProductAnalyticsLevel)
    : null;
}

function onboarded(): boolean {
  return getSettingValue('onboarding_completed') === 'true';
}

/** Telemetry off wins. An onboarded store that has not chosen yet shares anonymously. */
export function readProductAnalyticsLevel(): ProductAnalyticsLevel {
  if (!isTelemetryEnabled()) return 'off';
  const stored = parseProductAnalyticsLevel(getSettingValue(PRODUCT_ANALYTICS_LEVEL_SETTING));
  if (stored === 'full') return 'full';
  return stored || onboarded() ? 'anonymous' : 'off';
}

/** The owner still has to answer the one-time sharing question. */
export function productAnalyticsChoicePending(): boolean {
  return (
    isTelemetryEnabled() &&
    onboarded() &&
    !parseProductAnalyticsLevel(getSettingValue(PRODUCT_ANALYTICS_LEVEL_SETTING))
  );
}

export function resolvePostHogIdentity(level: ProductAnalyticsLevel): PostHogIdentity {
  if (level === 'off') return { distinctId: `anon_${LAUNCH_ID}`, identified: false };
  const installRef = readInstallRef();
  const accountRef = level === 'full' ? readAccountRef() : undefined;
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
