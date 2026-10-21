import type { PostHog } from 'posthog-js';

let client: PostHog | null = null;

export function setPostHogClient(next: PostHog): void {
  client = next;
}

/** Sends an error an error boundary caught. No-op until PostHog is configured and consented. */
export function capturePostHogBoundaryError(error: Error): void {
  try {
    client?.captureException(error, { capture_point: 'react-error-boundary' });
  } catch {
    // PostHog never disrupts error recovery.
  }
}
