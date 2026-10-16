'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { CaptureResult, PostHog } from 'posthog-js';
import { scrubPostHogEvent, scrubPathname, type ScrubbableEvent } from '@shared/posthog-scrub';
import { createScreenViewThrottle, screenKey } from '@shared/posthog-screen-views';
import { setPostHogClient } from '@/lib/posthog-client';
import { useAuthStore } from '@/store/auth';

let boot: Promise<PostHog | null> | null = null;
let client: PostHog | null = null;

const CONSENT_REFRESH_MS = 30_000;
const LINKED_KEYS = ['install_ref', 'store_ref', 'staff_ref'] as const;

/**
 * Consent and identity as main last reported them. Main checks both on every send; the renderer
 * re-reads them on an interval and on focus, so a consent change (Settings or cloud consent sync)
 * takes effect without a reload: with telemetry off, renderer events move to main's per-launch id
 * and carry no device, store, or staff link.
 */
const consent = { telemetry: false, diagnostics: false };
const identity = { distinctId: '', identified: false };
/** The signed-in staff member, so staff tags can be applied after a late boot or a consent change. */
const staff: { userId?: number | string; role?: string } = {};

type Bootstrap = Awaited<
  ReturnType<NonNullable<NonNullable<Window['electronAPI']>['getPostHogBootstrap']>>
>;

function applyBootstrap(bootstrap: Bootstrap | undefined): void {
  const enabled = bootstrap?.enabled === true;
  consent.telemetry = enabled && bootstrap.telemetryEnabled === true;
  consent.diagnostics = enabled && bootstrap.diagnosticsEnabled === true;
  if (enabled) {
    identity.distinctId = bootstrap.distinctId;
    identity.identified = bootstrap.identified === true;
  }
  if (!client) return;
  if (enabled) client.register(bootstrap.superProperties);
  if (staff.role) client.register({ staff_role: staff.role });
  if (!consent.telemetry) {
    for (const key of LINKED_KEYS) client.unregister(key);
  } else if (staff.userId !== undefined) {
    const current = client;
    void staffRef(identity.distinctId, staff.userId).then((ref) => {
      if (ref && consent.telemetry) current.register({ staff_ref: ref });
    });
  }
}

async function refreshConsent(): Promise<void> {
  try {
    applyBootstrap(await window.electronAPI?.getPostHogBootstrap?.());
  } catch {
    applyBootstrap(undefined);
  }
}

/** Puts the event on the id main reports now, not the one the page loaded with. */
function withCurrentIdentity(event: ScrubbableEvent): ScrubbableEvent {
  if (!identity.distinctId) return event;
  const properties: Record<string, unknown> = {
    ...(event.properties ?? {}),
    distinct_id: identity.distinctId,
  };
  if (!identity.identified && !consent.telemetry) properties.$process_person_profile = false;
  return { ...event, properties };
}

async function bootPostHog() {
  const read = window.electronAPI?.getPostHogBootstrap;
  if (!read) return null;
  let bootstrap: Awaited<ReturnType<NonNullable<typeof read>>>;
  try {
    bootstrap = await read();
  } catch {
    return null;
  }
  if (!bootstrap?.enabled) return null;
  applyBootstrap(bootstrap);
  const { default: posthog } = await import('posthog-js');
  // Bundled so exception autocapture never loads a remote script the CSP would block. It is always
  // on so diagnostics can be enabled mid-session; before_send drops exceptions while it is off.
  await import('posthog-js/dist/exception-autocapture');
  posthog.init(bootstrap.token, {
    api_host: bootstrap.host,
    person_profiles: 'identified_only',
    autocapture: false,
    // Pageviews are captured per screen by PostHogBootstrap, throttled.
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_external_dependency_loading: true,
    advanced_disable_feature_flags: true,
    advanced_disable_flags: true,
    disable_persistence: true,
    save_referrer: false,
    // Main identifies the account and aliases the device; the renderer only reuses the id.
    bootstrap: {
      distinctID: bootstrap.distinctId,
      isIdentifiedID: bootstrap.identified === true,
    },
    capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true },
    before_send: (event: CaptureResult | null): CaptureResult | null =>
      event &&
      (scrubPostHogEvent(withCurrentIdentity(event as unknown as ScrubbableEvent), {
        telemetryEnabled: consent.telemetry,
        allowExceptions: consent.diagnostics,
        defaultCapturePoint: 'renderer-autocapture',
      }) as unknown as CaptureResult | null),
  });
  client = posthog;
  applyBootstrap(bootstrap);
  setPostHogClient(posthog);
  return posthog;
}

/** Boots once enabled. A disabled result is not kept, so a later consent change can still boot. */
function postHog() {
  boot ??= bootPostHog()
    .catch(() => null)
    .then((posthog) => {
      if (!posthog) boot = null;
      return posthog;
    });
  return boot;
}

/** Re-reads consent, booting PostHog if it was off when the window loaded. */
function refresh(): void {
  void postHog().then((posthog) => {
    if (posthog) void refreshConsent();
  });
}

/** A per-installation hash of the user id: counts distinct staff without identifying anyone. */
async function staffRef(distinctId: string, userId: number | string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(`${distinctId}:${userId}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

const throttle = createScreenViewThrottle();

/**
 * Pins the renderer to the installation id, tags events with the signed-in staff role, and
 * sends one pageview per screen per window. Sends nothing until main returns a configured client.
 */
export function PostHogBootstrap() {
  const pathname = usePathname();
  const tab = useSearchParams().get('tab');
  const userId = useAuthStore((state) => state.user?.id);
  const role = useAuthStore((state) => state.currentTenant?.role);
  const staffVersion = useRef(0);
  const staffTagged = useRef<Promise<unknown>>(Promise.resolve());
  const staffKey = useRef('');

  useEffect(() => {
    const timer = window.setInterval(refresh, CONSENT_REFRESH_MS);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    const version = ++staffVersion.current;
    staff.userId = role ? userId : undefined;
    staff.role = userId !== undefined && role ? role : undefined;
    staffTagged.current = postHog().then(async (posthog) => {
      if (!posthog) return;
      if (userId === undefined || !role) {
        staffKey.current = '';
        posthog.unregister('staff_role');
        posthog.unregister('staff_ref');
        return;
      }
      const ref = consent.telemetry ? await staffRef(identity.distinctId, userId) : null;
      if (version !== staffVersion.current) return;
      staffKey.current = ref ?? role;
      posthog.register({ staff_role: role, ...(ref ? { staff_ref: ref } : {}) });
    });
  }, [userId, role]);

  useEffect(() => {
    if (!pathname) return;
    const screen = screenKey(pathname, tab);
    const tagged = staffTagged.current;
    void postHog().then(async (posthog) => {
      if (!posthog || !consent.telemetry) return;
      await tagged;
      // Per staff member, so one cashier's views never hide a manager's.
      const decision = throttle(`${staffKey.current}|${screen}`, Date.now());
      if (!decision.send) return;
      posthog.capture('$pageview', {
        screen: scrubPathname(pathname),
        ...(screen.includes('?tab=') ? { settings_tab: tab } : {}),
        repeat_views: decision.repeatViews,
      });
    });
  }, [pathname, tab]);

  return null;
}
