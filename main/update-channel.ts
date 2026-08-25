/**
 * Update-channel resolution for the app self-updater (#463 beta channel,
 * decision #503, child of epic #467's honest-state model).
 *
 * This module is intentionally pure (no Electron imports) so the channel
 * resolution rules can be unit-tested exhaustively, mirroring
 * main/update-state.ts.
 *
 * Policy (#503):
 *  - Beta builds publish as prerelease-flagged GitHub releases with tags like
 *    `3.3.1-beta.1` and electron-updater manifests prefixed `beta` (beta.yml,
 *    beta-mac.yml, ...). A client only sees them when prereleases are enabled
 *    for it; stable installs follow GitHub's Latest release unless the user
 *    explicitly opts into the beta channel.
 *  - Nightly releases are explicitly rejected: no nightly publish path exists,
 *    and a version stamped `*-nightly.*` is treated as an unsupported
 *    prerelease (stable updates only).
 *  - Promotion from beta to stable is always a deliberate human action; there
 *    is no automatic promotion path anywhere in this resolution.
 */

/**
 * settings-table key persisting the in-app "beta channel" opt-in. Stored in
 * the same SQLite settings store as the rest of the app configuration so it
 * survives restarts and travels with backups.
 */
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
  /**
   * Prerelease identifier of the running version's semver (e.g. 'beta' for
   * 3.3.1-beta.1), or null for a stable version.
   */
  versionPrereleaseChannel: string | null;
  /** Persisted in-app opt-in ("join the beta channel" switch). */
  betaOptIn: boolean;
}

/**
 * Resolve the effective updater channel from the running version and the
 * persisted opt-in:
 *  - A build follows the beta channel whenever `betaOptIn` is true (whether
 *    running stable or beta).
 *  - When `betaOptIn` is false, the install follows the stable feed (`channel: null`)
 *    with `allowDowngrade: false`. If currently running a beta build, it safely
 *    remains on that version until the next matching or newer stable release
 *    is published (graduating to stable without database rollbacks).
 *  - Any other prerelease stamp (nightly, alpha, local experiments) without an
 *    explicit opt-in gets stable updates so an untracked stamp never subscribes
 *    it to a dead feed.
 *
 * `allowDowngrade` is only enabled for a beta build that remains on the beta
 * feed, whose promotional testing may move between prerelease comparisons.
 */
export function resolveUpdateChannel(inputs: UpdateChannelInputs): ResolvedUpdateChannel {
  const betaBuild = inputs.versionPrereleaseChannel === 'beta';
  if (inputs.betaOptIn) {
    return { channel: 'beta', allowPrerelease: true, allowDowngrade: betaBuild };
  }
  return { channel: null, allowPrerelease: false, allowDowngrade: false };
}

/**
 * Interpret the raw settings-table value for the beta opt-in.
 *  - Explicit 'true' enables the channel.
 *  - Explicit 'false' disables the channel.
 *  - Unset or malformed values fall back to `defaultForBetaBuild` (true for beta builds,
 *    false for stable).
 */
export function parseStoredBetaChannelEnabled(
  value: string | null | undefined,
  defaultForBetaBuild: boolean = false
): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultForBetaBuild;
}

