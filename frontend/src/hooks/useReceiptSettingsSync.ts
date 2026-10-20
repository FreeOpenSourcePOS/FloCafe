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
let isHydrated = false;
let lastSyncTime = 0;
const FOCUS_SYNC_THROTTLE_MS = 60_000;

export function syncReceiptSettings(force = false): Promise<void> {
  if (syncPromise) {
    return syncPromise;
  }

  const now = Date.now();
  if (!force && isHydrated && now - lastSyncTime < FOCUS_SYNC_THROTTLE_MS) {
    return Promise.resolve();
  }

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
        lastSyncTime = Date.now();
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
  if (syncPromise) {
    await syncPromise;
  }
  if (isHydrated) return;
  await syncReceiptSettings(true);
}

export function resetReceiptSettingsSyncForTests(): void {
  syncPromise = null;
  isHydrated = false;
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
