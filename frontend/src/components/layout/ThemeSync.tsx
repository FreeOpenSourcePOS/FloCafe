'use client';

import { useEffect, useRef, useState } from 'react';
import { useThemeMode, THEME_REHYDRATION_EVENT } from '@/store/theme';
import type { ThemeMode } from '@/store/theme';
import api from '@/lib/api';

const THEME_MIRROR_KEY = 'flo-theme-resolved';
const RETRY_DELAY_MS = 1000;
/** One delayed re-check for a long-lived popup whose transient outage outlived startup. */
const RECHECK_DELAY_MS = 60_000;

function isThemeModeValue(v: string | null): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

const cancellableSleep = (ms: number, isCancelled: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (isCancelled()) {
      clearTimeout(t);
      resolve();
    }
  });

/**
 * Renderer-side theme engine. Source precedence: DB > param > mirror > OS.
 * Owner windows hydrate from SQLite and own the mirror; followers seed from
 * the param, the mirror, or an authed fetch — an OS-guess never writes the
 * mirror. Boot setMode is skipped once the user chooses in this window.
 * Pushes are fire-and-forget; a failed follower fetch schedules one re-check.
 */
export function ThemeSync() {
  const mode = useThemeMode((s) => s.mode);
  const setMode = useThemeMode((s) => s.setMode);
  const [hydrated, setHydrated] = useState(false);
  const authoritative = useRef(false);

  useEffect(() => {
    // Effect scope so cleanup can cancel a pending re-check.
    // covers the long-lived 60s recheck schedule across re-boots.
    let cancelled = false;
    let recheckCancelled = false;
    let recheckHandle: ReturnType<typeof setTimeout> | null = null;
    const userHasChosen = () => useThemeMode.getState().userSelected;

    /** Bounded fetch used by boot and the post-hydration re-check. */
    const fetchThemeMode = async (isCancelled: () => boolean): Promise<ThemeMode | null> => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (isCancelled()) return null;
        try {
          const res = await api.get('/settings/theme_mode');
          if (isCancelled()) return null;
          const raw = res.data?.setting?.value ?? null;
          if (isThemeModeValue(raw)) return raw;
        } catch {
          // 401 (api.ts interceptor redirects), 404, offline — try again.
        }
        if (attempt < 2 && !isCancelled()) {
          await cancellableSleep(RETRY_DELAY_MS, isCancelled);
        }
      }
      return null;
    };

    const boot = async () => {
      if (cancelled) return;
      // Cancel any pending recheck from a prior boot before (re-)scheduling.
      recheckCancelled = true;
      if (recheckHandle) {
        clearTimeout(recheckHandle);
        recheckHandle = null;
      }
      recheckCancelled = false;

      const hasPosToken = (() => {
        try { return Boolean(localStorage.getItem('token')); }
        catch { return false; }
      })();
      let dbMode: ThemeMode | null = null;
      let dbAttempted = false; // true once the bounded fetch has definitively resolved

      if (window.electronAPI) {
        try {
          const all = await window.electronAPI.getSettings();
          if (!cancelled && !userHasChosen() && all && typeof all === 'object' && !('error' in all)) {
            const raw = (all as Record<string, string | null>).theme_mode;
            if (isThemeModeValue(raw)) setMode(raw);
          }
        } catch {
          // Read failure → keep 'system'.
        }
      } else {
        let fromUrl: string | null = null;
        try {
          fromUrl = new URLSearchParams(location.search).get('theme');
        } catch {
          // Ignore malformed URLs.
        }
        const paramResolved = isThemeModeValue(fromUrl) ? fromUrl : null;

        // Token gate: without a POS token the fetch is a guaranteed 401
        // and api.ts's interceptor hard-redirects to /auth/login. KDS
        // windows have no token, so the ?theme= param carries the truth.
        if (hasPosToken) {
          dbMode = await fetchThemeMode(() => cancelled);
          dbAttempted = true;
        }

        let mirrorResolved: string | null = null;
        if (!dbMode) {
          try {
            mirrorResolved = localStorage.getItem(THEME_MIRROR_KEY);
          } catch {
            // Ignore private-browsing quota errors.
          }
        }

        // Authoritative marking: DB and param always; a mirror seed only
        // when no fetch was attempted (a mirror read after a failed fetch
        // paints but never writes back — it may be stale).
        if (!userHasChosen()) {
          if (dbMode) {
            authoritative.current = true;
            setMode(dbMode);
          } else if (paramResolved) {
            authoritative.current = true;
            setMode(paramResolved);
          } else if (isThemeModeValue(mirrorResolved)) {
            if (!dbAttempted) authoritative.current = true;
            setMode(mirrorResolved);
          }
        }
      }

      if (hasPosToken && dbAttempted && !dbMode) {
        recheckHandle = setTimeout(async () => {
          if (recheckCancelled) return;
          const resolved = await fetchThemeMode(() => recheckCancelled);
          if (recheckCancelled) return;
          if (resolved && !userHasChosen()) {
            authoritative.current = true;
            setMode(resolved);
          }
        }, RECHECK_DELAY_MS);
      }

      if (!cancelled) setHydrated(true);
    };
    boot();
    // Theme store boots pre-auth; re-hydrate once a token exists (post-login).
    const onAuthChanged = () => { void boot(); };
    window.addEventListener(THEME_REHYDRATION_EVENT, onAuthChanged);
    return () => {
      cancelled = true;
      recheckCancelled = true;
      if (recheckHandle) clearTimeout(recheckHandle);
      window.removeEventListener(THEME_REHYDRATION_EVENT, onAuthChanged);
    };
  }, [setMode]);

  useEffect(() => {
    if (!hydrated || typeof document === 'undefined') return;
    const html = document.documentElement;
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

    const apply = () => {
      const isDark = mode === 'dark' || (mode === 'system' && Boolean(media?.matches));
      html.classList.toggle('dark', isDark);
      if (window.electronAPI || authoritative.current) {
        try {
          localStorage.setItem(THEME_MIRROR_KEY, isDark ? 'dark' : 'light');
        } catch {
          // Best-effort mirror.
        }
      }
      // Fire-and-forget: never block the renderer on chrome re-painting.
      window.electronAPI?.setThemeEffective(isDark)?.catch(() => {});
    };

    apply();
    if (mode !== 'system' || !media) return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [mode, hydrated]);

  return null;
}
