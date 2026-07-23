import { useCallback, useSyncExternalStore } from 'react';

export type KdsViewMode = 'tabs' | 'kanban';

const VIEW_STORAGE_KEY = 'kds_view_override';
const VIEW_CHANGE_EVENT = 'kds_view_override_changed';

function readOverride(): KdsViewMode | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return v === 'tabs' || v === 'kanban' ? v : null;
}

/**
 * Resolves the active KDS view mode for this session.
 *
 * Resolution order (highest wins):
 *   1. localStorage `kds_view_override` (per-session chef toggle)
 *   2. Server setting `kds_default_view` (admin/owner default)
 *   3. Final fallback: `tabs`
 *
 * `serverDefault` should come from `GET /api/kds/info`. Until that fetch
 * resolves, we use `tabs` so existing tenants see no regression.
 */
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
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
    window.dispatchEvent(new Event(VIEW_CHANGE_EVENT));
  }, []);

  const viewMode = override ?? serverDefault ?? 'tabs';
  return { viewMode, setViewMode };
}
