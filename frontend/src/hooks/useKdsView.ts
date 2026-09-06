import { useCallback, useSyncExternalStore } from 'react';

export type KdsViewMode = 'tabs' | 'kanban';

const VIEW_STORAGE_KEY = 'kds_view_override';
const VIEW_CHANGE_EVENT = 'kds_view_override_changed';

function readOverride(): KdsViewMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return v === 'tabs' || v === 'kanban' ? v : null;
  } catch {
    return null;
  }
}

/** Resolves active KDS view mode with precedence:
 * session override > server default > 'tabs' fallback. */
export function useKdsView(serverDefault: KdsViewMode | null): {
  viewMode: KdsViewMode;
  setViewMode: (v: KdsViewMode) => void;
} {
  const override = useSyncExternalStore(
    (cb) => {
      window.addEventListener(VIEW_CHANGE_EVENT, cb);
      return () => window.removeEventListener(VIEW_CHANGE_EVENT, cb);
    },
    readOverride,
    () => null,
  );

  const setViewMode = useCallback((v: KdsViewMode) => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      // Keep the in-memory event working when storage is unavailable.
    }
    window.dispatchEvent(new Event(VIEW_CHANGE_EVENT));
  }, []);

  const viewMode = override ?? serverDefault ?? 'tabs';
  return { viewMode, setViewMode };
}
