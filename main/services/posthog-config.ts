/** PostHog project configuration. Without a token the client sends nothing. */

import { getSettingValue } from '../db';
import { isOfficialReleaseBuild, readBuildPostHogSettings } from './build-identity';

export const POSTHOG_PROJECT_TOKEN_SETTING = 'posthog_project_token';
export const POSTHOG_HOST_SETTING = 'posthog_host';
export const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';

export interface PostHogConfig {
  token: string;
  host: string;
}

/** Accepts an http(s) origin. Credentials and any other scheme are rejected. */
export function parsePostHogConfig(token: string, host: string): PostHogConfig | null {
  const trimmedToken = token.trim();
  const trimmedHost = host.trim();
  if (!trimmedToken || !trimmedHost) return null;
  let url: URL;
  try {
    url = new URL(trimmedHost);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname) return null;
  return { token: trimmedToken, host: url.origin };
}

export type PostHogEnvironment = 'production' | 'development';

/**
 * `production` for release builds, `development` with FLO_POSTHOG_DEV=1, else null (no connection).
 * Test suites run as plain Node, so they never connect even with a stubbed isPackaged.
 */
export function postHogEnvironment(): PostHogEnvironment | null {
  if (process.env.CI) return null;
  if (process.env.FLO_MATRIX_OFFLINE === '1') return null;
  if (process.env.E2E_TASK_LOCAL_PORTS) return null;
  if ((process as NodeJS.Process & { type?: string }).type !== 'browser') return null;
  if (process.env.FLO_POSTHOG_DEV === '1') return 'development';
  return isOfficialReleaseBuild() ? 'production' : null;
}

export function postHogNetworkSuppressed(): boolean {
  return postHogEnvironment() === null;
}

/**
 * Token and host: FLO_POSTHOG_DEV_* in development, then the settings row, then
 * build-identity.json; the host defaults to EU Cloud.
 */
export function readPostHogConfig(): PostHogConfig | null {
  try {
    const build = readBuildPostHogSettings();
    const host =
      getSettingValue(POSTHOG_HOST_SETTING)?.trim() || build.host || DEFAULT_POSTHOG_HOST;
    const devToken = process.env.FLO_POSTHOG_DEV_TOKEN?.trim();
    if (devToken && postHogEnvironment() === 'development') {
      return parsePostHogConfig(devToken, process.env.FLO_POSTHOG_DEV_HOST?.trim() || host);
    }
    const token = getSettingValue(POSTHOG_PROJECT_TOKEN_SETTING)?.trim() || build.token || '';
    return parsePostHogConfig(token, host);
  } catch {
    return null;
  }
}

/** Origin allowed on connect-src, or null when PostHog must not be contacted. */
export function postHogConnectOrigin(): string | null {
  if (postHogNetworkSuppressed()) return null;
  return readPostHogConfig()?.host ?? null;
}
