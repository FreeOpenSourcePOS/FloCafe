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
    tenantCan(tenant, 'bills.generate')
  );
}

let syncPromise: Promise<void> | null = null;
let inFlightTenantId: string | number | null = null;
let isHydrated = false;
let hydratedTenantId: string | number | null = null;
let lastSyncTime = 0;
const FOCUS_SYNC_THROTTLE_MS = 60_000;

export function syncReceiptSettings(force = false): Promise<void> {
  const currentTenant = useAuthStore.getState().currentTenant;
  if (!canSyncReceiptSettings(currentTenant)) {
    return Promise.resolve();
  }

  const tenantIdAtStart = currentTenant?.id ?? null;
  if (syncPromise && inFlightTenantId === tenantIdAtStart) {
    return syncPromise;
  }

  const tenantChanged = tenantIdAtStart !== hydratedTenantId;
  const now = Date.now();
  if (!force && !tenantChanged && isHydrated && now - lastSyncTime < FOCUS_SYNC_THROTTLE_MS) {
    return Promise.resolve();
  }

  inFlightTenantId = tenantIdAtStart;
  const requestPromise = api
    .get<ReceiptSettingsHydrationData>('/settings/business')
    .then((res) => {
      if (useAuthStore.getState().currentTenant?.id !== tenantIdAtStart) {
        return;
      }
      if (res?.data) {
        usePosSettingsStore.getState().hydrateReceiptSettings(res.data);
        isHydrated = true;
        hydratedTenantId = tenantIdAtStart;
        lastSyncTime = Date.now();
      }
    })
    .catch(() => {
      // Graceful fallback: offline/network failure leaves existing persisted settings intact
    })
    .finally(() => {
      if (syncPromise === requestPromise) {
        syncPromise = null;
        inFlightTenantId = null;
      }
    });

  syncPromise = requestPromise;
  return requestPromise;
}

export async function ensureReceiptSettingsLoaded(): Promise<void> {
  const currentTenantId = useAuthStore.getState().currentTenant?.id ?? null;
  if (syncPromise && inFlightTenantId === currentTenantId) {
    await syncPromise;
  }
  const latestTenantId = useAuthStore.getState().currentTenant?.id ?? null;
  if (isHydrated && hydratedTenantId === latestTenantId) return;
  await syncReceiptSettings(true);
}

export function resetReceiptSettingsSyncForTests(): void {
  syncPromise = null;
  inFlightTenantId = null;
  isHydrated = false;
  hydratedTenantId = null;
  lastSyncTime = 0;
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
