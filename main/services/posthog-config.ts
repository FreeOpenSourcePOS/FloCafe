/** PostHog project configuration. Absent settings mean the client sends nothing. */

import { getSettingValue } from '../db';
import { isOfficialReleaseBuild } from './build-identity';

export const POSTHOG_PROJECT_TOKEN_SETTING = 'posthog_project_token';
export const POSTHOG_HOST_SETTING = 'posthog_host';

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
 * Where events from this process belong, or null when it must not connect. Only release-workflow
 * builds are `production`. A developer opts in with FLO_POSTHOG_DEV=1 and gets `development`,
 * which every event carries so PostHog's internal-and-test filter can drop it. Test suites run as
 * plain Node (ELECTRON_RUN_AS_NODE), often with a stubbed isPackaged, and never connect.
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
 * Reads the settings rows. In development, FLO_POSTHOG_DEV_TOKEN (and optionally
 * FLO_POSTHOG_DEV_HOST) points at a separate project so test data never reaches production.
 * No other environment variable configures the client.
 */
export function readPostHogConfig(): PostHogConfig | null {
  try {
    const token = getSettingValue(POSTHOG_PROJECT_TOKEN_SETTING) ?? '';
    const host = getSettingValue(POSTHOG_HOST_SETTING) ?? '';
    const devToken = process.env.FLO_POSTHOG_DEV_TOKEN?.trim();
    if (devToken && postHogEnvironment() === 'development') {
      return parsePostHogConfig(devToken, process.env.FLO_POSTHOG_DEV_HOST?.trim() || host);
    }
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
