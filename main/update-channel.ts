/** Resolves updater channel based on running version and beta opt-in settings. */

/** Setting key persisting the in-app beta channel opt-in. */
export const BETA_CHANNEL_SETTING_KEY = 'updates.beta_channel_enabled';

/** The only prerelease identifier FloCafe treats as a real update channel (#503). */
export type SupportedPrereleaseChannel = 'beta';

export interface ResolvedUpdateChannel {
  /** Value assigned to autoUpdater.channel; null leaves the default feed. */
  channel: SupportedPrereleaseChannel | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
}

export interface UpdateChannelInputs {
  /** Prerelease identifier of running semver (e.g. 'beta'), or null for stable. */
  versionPrereleaseChannel: string | null;
  /** Persisted in-app opt-in ("join the beta channel" switch). */
  betaOptIn: boolean;
}

/** Resolves effective updater channel from running version and persisted opt-in. */
export function resolveUpdateChannel(inputs: UpdateChannelInputs): ResolvedUpdateChannel {
  const betaBuild = inputs.versionPrereleaseChannel === 'beta';
  if (inputs.betaOptIn) {
    return { channel: 'beta', allowPrerelease: true, allowDowngrade: betaBuild };
  }
  return { channel: null, allowPrerelease: false, allowDowngrade: false };
}

/** Parses stored setting value for beta opt-in, defaulting by build type. */
export function parseStoredBetaChannelEnabled(
  value: string | null | undefined,
  defaultForBetaBuild: boolean = false
): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultForBetaBuild;
}

