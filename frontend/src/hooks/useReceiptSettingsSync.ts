import { useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore, type ReceiptSettingsHydrationData } from '@/store/pos-settings';
import type { Tenant } from '@/lib/types';
import { tenantCan } from '@/lib/permissions';

export class PrintCancelledOnTenantChangeError extends Error {
  readonly code = 'PRINT_CANCELLED_TENANT_CHANGED';

  constructor() {
    super('Print cancelled because active tenant changed');
    this.name = 'PrintCancelledOnTenantChangeError';
  }
}

export function isPrintCancelledOnTenantChangeError(err: unknown): boolean {
  return (
    err instanceof PrintCancelledOnTenantChangeError ||
    (typeof err === 'object' &&
      err !== null &&
      ((err as { name?: unknown }).name === 'PrintCancelledOnTenantChangeError' ||
        (err as { code?: unknown }).code === 'PRINT_CANCELLED_TENANT_CHANGED'))
  );
}

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
let inFlightRequestId = 0;
let activeRequestId = 0;
let isHydrated = false;
let hydratedTenantId: string | number | null = null;
let lastObservedTenantId: string | number | null =
  useAuthStore.getState().currentTenant?.id ?? null;
let lastSyncTime = 0;
let isApplyingSyncedSettings = false;
const FOCUS_SYNC_THROTTLE_MS = 60_000;

function invalidateReceiptSettingsHydration(): void {
  isHydrated = false;
  hydratedTenantId = null;
  lastSyncTime = 0;
}

useAuthStore.subscribe((state) => {
  const nextTenantId = state.currentTenant?.id ?? null;
  if (nextTenantId !== lastObservedTenantId) {
    lastObservedTenantId = nextTenantId;
    activeRequestId += 1;
    invalidateReceiptSettingsHydration();
  }
});

usePosSettingsStore.subscribe(() => {
  if (isApplyingSyncedSettings) return;
  const currentTenantId = useAuthStore.getState().currentTenant?.id ?? null;
  if (hydratedTenantId !== null && currentTenantId !== hydratedTenantId) {
    invalidateReceiptSettingsHydration();
  }
});

export function syncReceiptSettings(force = false): Promise<void> {
  const currentTenant = useAuthStore.getState().currentTenant;
  const tenantIdAtStart = currentTenant?.id ?? null;
  if (tenantIdAtStart !== lastObservedTenantId) {
    lastObservedTenantId = tenantIdAtStart;
    activeRequestId += 1;
    invalidateReceiptSettingsHydration();
  }

  if (!canSyncReceiptSettings(currentTenant)) {
    return Promise.resolve();
  }

  if (
    syncPromise &&
    inFlightTenantId === tenantIdAtStart &&
    inFlightRequestId === activeRequestId
  ) {
    return syncPromise;
  }

  const tenantChanged = tenantIdAtStart !== hydratedTenantId;
  if (tenantChanged) {
    invalidateReceiptSettingsHydration();
  }

  const now = Date.now();
  if (!force && !tenantChanged && isHydrated && now - lastSyncTime < FOCUS_SYNC_THROTTLE_MS) {
    return Promise.resolve();
  }

  const requestId = ++activeRequestId;
  inFlightTenantId = tenantIdAtStart;
  inFlightRequestId = requestId;
  const requestPromise = api
    .get<ReceiptSettingsHydrationData>('/settings/business')
    .then((res) => {
      if (
        requestId !== activeRequestId ||
        syncPromise !== requestPromise ||
        useAuthStore.getState().currentTenant?.id !== tenantIdAtStart
      ) {
        return;
      }
      if (res?.data) {
        isApplyingSyncedSettings = true;
        try {
          usePosSettingsStore.getState().hydrateReceiptSettings(res.data);
        } finally {
          isApplyingSyncedSettings = false;
        }
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
        inFlightRequestId = 0;
      }
    });

  syncPromise = requestPromise;
  return requestPromise;
}

export async function ensureReceiptSettingsLoaded(
  expectedTenantId?: string | number | null,
): Promise<boolean> {
  const currentTenantId = useAuthStore.getState().currentTenant?.id ?? null;
  if (currentTenantId !== lastObservedTenantId) {
    lastObservedTenantId = currentTenantId;
    activeRequestId += 1;
    invalidateReceiptSettingsHydration();
  }

  const tenantIdAtStart = expectedTenantId !== undefined ? expectedTenantId : currentTenantId;
  if (currentTenantId !== tenantIdAtStart) {
    return false;
  }

  if (
    syncPromise &&
    inFlightTenantId === tenantIdAtStart &&
    inFlightRequestId === activeRequestId
  ) {
    await syncPromise;
  }

  if ((useAuthStore.getState().currentTenant?.id ?? null) !== tenantIdAtStart) {
    return false;
  }

  if (isHydrated && hydratedTenantId === tenantIdAtStart) {
    return true;
  }

  await syncReceiptSettings(true);

  return (useAuthStore.getState().currentTenant?.id ?? null) === tenantIdAtStart;
}

export function resetReceiptSettingsSyncForTests(): void {
  syncPromise = null;
  inFlightTenantId = null;
  inFlightRequestId = 0;
  activeRequestId += 1;
  isHydrated = false;
  hydratedTenantId = null;
  lastObservedTenantId = useAuthStore.getState().currentTenant?.id ?? null;
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
