import type { PostHog } from 'posthog-js';
import { scrubRequestPath } from '@shared/posthog-scrub';

let client: PostHog | null = null;

export function setPostHogClient(next: PostHog): void {
  client = next;
}

/** An axios failure has no app frame, so the request it failed on is the only clue. */
function axiosRequest(error: unknown): Record<string, unknown> {
  const failure = error as {
    isAxiosError?: unknown;
    config?: { method?: string; url?: string };
    response?: { status?: number };
  } | null;
  if (failure?.isAxiosError !== true) return {};
  // Only the leading segment: a call can put a customer name or a search term in the path.
  const route = scrubRequestPath(failure.config?.url);
  const status = failure.response?.status;
  return {
    ...(failure.config?.method ? { http_method: failure.config.method.toUpperCase() } : {}),
    ...(route ? { http_route: route } : {}),
    ...(typeof status === 'number' ? { http_status: status } : {}),
  };
}

/** Sends an error an error boundary caught. No-op until PostHog is configured and consented. */
export function capturePostHogBoundaryError(error: Error): void {
  try {
    // The scrubber turns this into a route pattern: no query, no ids.
    const $pathname = typeof window === 'undefined' ? undefined : window.location.pathname;
    client?.captureException(error, {
      capture_point: 'react-error-boundary',
      ...($pathname ? { $pathname } : {}),
      ...axiosRequest(error),
    });
  } catch {
    // PostHog never disrupts error recovery.
  }
}
