import { useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore, type ReceiptSettingsHydrationData } from '@/store/pos-settings';
import type { Tenant } from '@/lib/types';
import { tenantCan } from '@/lib/permissions';

export function canSyncReceiptSettings(tenant: Tenant | null | undefined): boolean {
  if (!tenant) return false;
  return (
    tenantCan(tenant, 'settings.view') ||
    tenantCan(tenant, 'bills.read') ||
    tenantCan(tenant, 'bills.print') ||
    tenantCan(tenant, 'orders.read') ||
    tenantCan(tenant, 'bills.generate')
  );
}

let syncPromise: Promise<void> | null = null;
let isHydrated = false;

export function syncReceiptSettings(): Promise<void> {
  const currentTenant = useAuthStore.getState().currentTenant;
  if (!canSyncReceiptSettings(currentTenant)) {
    return Promise.resolve();
  }

  syncPromise = api
    .get<ReceiptSettingsHydrationData>('/settings/business')
    .then((res) => {
      if (res?.data) {
        usePosSettingsStore.getState().hydrateReceiptSettings(res.data);
        isHydrated = true;
      }
    })
    .catch(() => {
      // Graceful fallback: offline/network failure leaves existing persisted settings intact
    })
    .finally(() => {
      syncPromise = null;
    });

  return syncPromise;
}

export async function ensureReceiptSettingsLoaded(): Promise<void> {
  if (isHydrated) return;
  if (syncPromise) {
    await syncPromise;
    return;
  }
  await syncReceiptSettings();
}

export function resetReceiptSettingsSyncForTests(): void {
  syncPromise = null;
  isHydrated = false;
}

export function useReceiptSettingsSync(): void {
  const currentTenant = useAuthStore((s) => s.currentTenant);

  useEffect(() => {
    if (!canSyncReceiptSettings(currentTenant)) return;

    let active = true;
    const sync = () => {
      if (!active) return;
      syncReceiptSettings();
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
