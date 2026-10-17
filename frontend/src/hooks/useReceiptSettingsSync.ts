import { useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore, type ReceiptSettingsHydrationData } from '@/store/pos-settings';
import { tenantCan } from '@/lib/permissions';

/**
 * Hydrates receipt display settings into posSettings from the backend settings API.
 * Ensures browser print and POS receipt preview have the current store headers,
 * footers, and visibility flags without requiring the operator to open Settings.
 */
export async function syncReceiptSettings(): Promise<void> {
  const currentTenant = useAuthStore.getState().currentTenant;
  if (!currentTenant) return;
  if (!tenantCan(currentTenant, 'settings.view')) return;

  try {
    const { data } = await api.get<ReceiptSettingsHydrationData>('/settings/business');
    if (data) {
      usePosSettingsStore.getState().hydrateReceiptSettings(data);
    }
  } catch {
    // Fail gracefully: offline operation preserves existing/persisted settings
  }
}

export function useReceiptSettingsSync(): void {
  const currentTenant = useAuthStore((s) => s.currentTenant);

  useEffect(() => {
    if (!currentTenant) return;
    if (!tenantCan(currentTenant, 'settings.view')) return;

    let active = true;
    const sync = () => {
      api
        .get<ReceiptSettingsHydrationData>('/settings/business')
        .then((res) => {
          if (!active || !res?.data) return;
          usePosSettingsStore.getState().hydrateReceiptSettings(res.data);
        })
        .catch(() => {});
    };

    sync();

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', sync);
      return () => {
        active = false;
        window.removeEventListener('focus', sync);
      };
    }
    return () => {
      active = false;
    };
  }, [currentTenant]);
}
