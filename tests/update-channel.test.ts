/**
 * Unit tests for the update-channel resolution (#463 beta channel, #503).
 *
 * Covers the pure module main/update-channel.ts:
 *  - resolveUpdateChannel: version-derived beta channel, in-app opt-in from a
 *    stable install, unsupported prerelease stamps (nightly/alpha) falling
 *    back to stable-only;
 *  - parseStoredBetaChannelEnabled: strict persisted-preference parsing with
 *    safe "stable" defaults.
 *
 * Run: npm run test:update-channel
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BETA_CHANNEL_SETTING_KEY,
  parseStoredBetaChannelEnabled,
  resolveUpdateChannel,
} from '../main/update-channel';

const BETA_BUILD_FEED = { channel: 'beta' as const, allowPrerelease: true, allowDowngrade: true };
const BETA_OPT_IN_FEED = { channel: 'beta' as const, allowPrerelease: true, allowDowngrade: false };
const STABLE_FEED = { channel: null, allowPrerelease: false, allowDowngrade: false };

test('a beta-stamped build always follows the beta feed', () => {
  assert.deepEqual(resolveUpdateChannel({ versionPrereleaseChannel: 'beta', betaOptIn: false }), BETA_BUILD_FEED);
  assert.deepEqual(resolveUpdateChannel({ versionPrereleaseChannel: 'beta', betaOptIn: true }), BETA_BUILD_FEED);
});

test('a stable build only joins beta through an explicit opt-in', () => {
  assert.deepEqual(resolveUpdateChannel({ versionPrereleaseChannel: null, betaOptIn: false }), STABLE_FEED);
  assert.deepEqual(
    resolveUpdateChannel({ versionPrereleaseChannel: null, betaOptIn: true }),
    BETA_OPT_IN_FEED,
    'opt-in must enable prereleases so the client can find beta.yml'
  );
});

test('unsupported prerelease stamps never subscribe to an untracked channel (#503)', () => {
  for (const stamp of ['nightly', 'alpha', 'rc', 'local.20260824']) {
    assert.deepEqual(
      resolveUpdateChannel({ versionPrereleaseChannel: stamp, betaOptIn: false }),
      STABLE_FEED,
      `${stamp} versions must fall back to stable updates`
    );
  }
});

test('an explicit opt-in wins over any running-version stamp', () => {
  assert.deepEqual(resolveUpdateChannel({ versionPrereleaseChannel: 'nightly', betaOptIn: true }), BETA_OPT_IN_FEED);
});

test('stable beta opt-in does not permit downgrades', () => {
  const resolved = resolveUpdateChannel({ versionPrereleaseChannel: null, betaOptIn: true });
  assert.equal(resolved.allowDowngrade, false);
});

test('a beta-stamped build permits a downgrade to a promoted stable release', () => {
  const resolved = resolveUpdateChannel({ versionPrereleaseChannel: 'beta', betaOptIn: false });
  assert.equal(resolved.allowDowngrade, true);
});

test('parseStoredBetaChannelEnabled is strict; anything else means stable', () => {
  assert.equal(parseStoredBetaChannelEnabled('true'), true);
  for (const value of ['false', '1', 'TRUE', 'yes', '', null, undefined]) {
    assert.equal(parseStoredBetaChannelEnabled(value as string | null | undefined), false, `value ${JSON.stringify(value)} must mean stable`);
  }
});

test('settings key is namespaced and stable across restarts', () => {
  assert.match(BETA_CHANNEL_SETTING_KEY, /^updates\.[a-z_]+$/);
});
