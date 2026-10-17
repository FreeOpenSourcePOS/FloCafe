import { useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore, type ReceiptSettingsHydrationData } from '@/store/pos-settings';
import { tenantCan } from '@/lib/permissions';

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
