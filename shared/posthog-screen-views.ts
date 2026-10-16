/**
 * One pageview per screen per window; skipped views are counted in `repeatViews`, so cashiers
 * switching screens all day stay inside the free event allowance.
 */

export const SCREEN_VIEW_WINDOW_MS = 30 * 60_000;

export interface ScreenViewDecision {
  send: boolean;
  /** Views of this screen folded into this one since the last pageview sent for it. */
  repeatViews: number;
}

export function createScreenViewThrottle(windowMs = SCREEN_VIEW_WINDOW_MS) {
  const screens = new Map<string, { sentAt: number; folded: number }>();
  let current: string | null = null;
  return (screen: string, now: number): ScreenViewDecision => {
    if (screen === current) return { send: false, repeatViews: 0 };
    current = screen;
    const seen = screens.get(screen);
    if (seen && now - seen.sentAt < windowMs) {
      seen.folded += 1;
      return { send: false, repeatViews: 0 };
    }
    const repeatViews = seen?.folded ?? 0;
    screens.set(screen, { sentAt: now, folded: 0 });
    return { send: true, repeatViews };
  };
}

/** The settings tab is the feature a settings visit is about; other query values are dropped. */
export function screenKey(pathname: string, tab: string | null): string {
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return tab && /^[a-z][a-z0-9-]{0,40}$/.test(tab) && path.startsWith('/settings/')
    ? `${path}?tab=${tab}`
    : path;
}
