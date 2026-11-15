import { create } from 'zustand';
import api from '@/lib/api';
import { tenantCan } from '@/lib/permissions';
import type { Tenant } from '@/lib/types';
import { onSessionBoundary } from './session-events';

export const CLOUD_ACCOUNT_STATUS_CHANGED_EVENT = 'flo:cloud-account-status-changed';

export const ACTIONABLE_CLOUD_DELETION_STATUSES = ['pending', 'processing', 'failed'] as const;
const TERMINAL_CLOUD_DELETION_STATUSES = ['approved', 'completed', 'deleted'] as const;

export interface CloudAccountAttentionSnapshot {
  email?: string | null;
  cloud_account_available?: boolean;
  verified?: boolean;
  deletion_request?: {
    status?: string | null;
  } | null;
}

export interface CloudStatusAttentionSnapshot {
  cloud_registration_status?: string | null;
  cloud_deletion_status?: string | null;
}

export interface DerivedCloudAttention {
  emailNeedsAttention: boolean;
  deletionNeedsAttention: boolean;
  anyNeedsAttention: boolean;
}

export function deriveCloudAttention({
  canManageCloudAccount,
  account,
  accountLoadFailed,
  cloud,
}: {
  canManageCloudAccount: boolean;
  account: CloudAccountAttentionSnapshot | null;
  accountLoadFailed: boolean;
  cloud: CloudStatusAttentionSnapshot | null;
}): DerivedCloudAttention {
  if (!canManageCloudAccount) {
    return {
      emailNeedsAttention: false,
      deletionNeedsAttention: false,
      anyNeedsAttention: false,
    };
  }

  const emailNeedsAttention = Boolean(
    !accountLoadFailed &&
    account?.cloud_account_available !== false &&
    account?.email &&
    !account?.verified,
  );

  const accountDeletionStatus = account?.deletion_request?.status || '';
  const cloudDeletionStatus = cloud?.cloud_deletion_status || '';
  const isTerminalDeletion =
    cloud?.cloud_registration_status === 'deleted' ||
    (TERMINAL_CLOUD_DELETION_STATUSES as readonly string[]).includes(cloudDeletionStatus) ||
    (TERMINAL_CLOUD_DELETION_STATUSES as readonly string[]).includes(accountDeletionStatus);
  const effectiveDeletionStatus = accountDeletionStatus || cloudDeletionStatus;
  const deletionNeedsAttention =
    !isTerminalDeletion &&
    (ACTIONABLE_CLOUD_DELETION_STATUSES as readonly string[]).includes(effectiveDeletionStatus);

  return {
    emailNeedsAttention,
    deletionNeedsAttention,
    anyNeedsAttention: emailNeedsAttention || deletionNeedsAttention,
  };
}

export function notifyCloudAccountStatusChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CLOUD_ACCOUNT_STATUS_CHANGED_EVENT));
  }
}

interface CloudAttentionState extends DerivedCloudAttention {
  tenantId: number | null;
  loadedForTenantId: number | null;
  account: CloudAccountAttentionSnapshot | null;
  accountLoadFailed: boolean;
  cloud: CloudStatusAttentionSnapshot | null;
  refreshForTenant: (
    tenant: Tenant | null | undefined,
    options?: { force?: boolean },
  ) => Promise<void>;
  syncAccount: (
    tenantId: number | null,
    account: CloudAccountAttentionSnapshot | null,
    failed?: boolean,
  ) => void;
  syncCloudStatus: (tenantId: number | null, cloud: CloudStatusAttentionSnapshot | null) => void;
  reset: () => void;
}

let tenantGeneration = 0;
let accountGeneration = 0;
let cloudGeneration = 0;
let nextRefreshId = 0;
let inFlightRefresh: { tenantId: number; refreshId: number; promise: Promise<void> } | null = null;

function buildEmptyState(tenantId: number | null = null) {
  return {
    tenantId,
    loadedForTenantId: null,
    account: null,
    accountLoadFailed: false,
    cloud: null,
    emailNeedsAttention: false,
    deletionNeedsAttention: false,
    anyNeedsAttention: false,
  };
}

export const useCloudAttentionStore = create<CloudAttentionState>((set, get) => ({
  ...buildEmptyState(null),

  reset: () => {
    tenantGeneration += 1;
    accountGeneration += 1;
    cloudGeneration += 1;
    inFlightRefresh = null;
    set(buildEmptyState(null));
  },

  syncAccount: (tenantId, account, failed = false) => {
    if (tenantId === null) return;
    const current = get();
    if (current.tenantId !== tenantId) return;
    accountGeneration += 1;
    const nextAccount = failed ? null : account;
    const derived = deriveCloudAttention({
      canManageCloudAccount: true,
      account: nextAccount,
      accountLoadFailed: failed,
      cloud: current.cloud,
    });
    set({
      tenantId,
      loadedForTenantId: failed ? null : current.loadedForTenantId,
      account: nextAccount,
      accountLoadFailed: failed,
      cloud: current.cloud,
      ...derived,
    });
  },

  syncCloudStatus: (tenantId, cloud) => {
    if (tenantId === null) return;
    const current = get();
    if (current.tenantId !== tenantId) return;
    cloudGeneration += 1;
    const derived = deriveCloudAttention({
      canManageCloudAccount: true,
      account: current.account,
      accountLoadFailed: current.accountLoadFailed,
      cloud,
    });
    set({
      tenantId,
      account: current.account,
      accountLoadFailed: current.accountLoadFailed,
      cloud,
      ...derived,
    });
  },

  refreshForTenant: async (tenant, options) => {
    const canManageAccount = tenantCan(tenant, 'cloud.account.manage');
    if (!tenant || !canManageAccount) {
      tenantGeneration += 1;
      accountGeneration += 1;
      cloudGeneration += 1;
      inFlightRefresh = null;
      set(buildEmptyState(tenant?.id ?? null));
      return;
    }

    const tenantId = tenant.id;
    const force = options?.force === true;

    if (get().tenantId !== tenantId) {
      tenantGeneration += 1;
      accountGeneration += 1;
      cloudGeneration += 1;
      inFlightRefresh = null;
      set(buildEmptyState(tenantId));
    }

    if (!force) {
      if (get().loadedForTenantId === tenantId) return;
      if (inFlightRefresh && inFlightRefresh.tenantId === tenantId) {
        return inFlightRefresh.promise;
      }
    }

    const tenantGen = tenantGeneration;
    const acctGen = ++accountGeneration;
    const cldGen = ++cloudGeneration;
    const refreshId = ++nextRefreshId;
    const canManageCloud = tenantCan(tenant, 'cloud.manage');

    const promise = (async () => {
      const [accountResult, cloudResult] = await Promise.allSettled([
        api.get('/settings/cloud/account'),
        canManageCloud ? api.get('/settings/cloud') : Promise.resolve(null),
      ]);

      const current = get();
      if (tenantGen !== tenantGeneration || current.tenantId !== tenantId) return;

      const accountSucceeded = accountResult.status === 'fulfilled';
      const cloudSucceeded =
        !canManageCloud || (cloudResult.status === 'fulfilled' && Boolean(cloudResult.value));

      const applyAccount = acctGen === accountGeneration;
      const applyCloud = cldGen === cloudGeneration;
      if (!applyAccount && !applyCloud) return;

      const nextAccount = applyAccount
        ? accountSucceeded
          ? ((accountResult.value.data ?? null) as CloudAccountAttentionSnapshot | null)
          : null
        : current.account;
      const nextAccountLoadFailed = applyAccount ? !accountSucceeded : current.accountLoadFailed;
      const nextCloud = applyCloud
        ? cloudResult.status === 'fulfilled' && cloudResult.value
          ? ((cloudResult.value.data ?? null) as CloudStatusAttentionSnapshot | null)
          : null
        : current.cloud;

      const derived = deriveCloudAttention({
        canManageCloudAccount: true,
        account: nextAccount,
        accountLoadFailed: nextAccountLoadFailed,
        cloud: nextCloud,
      });

      const appliedFailure = (applyAccount && !accountSucceeded) || (applyCloud && !cloudSucceeded);
      const fullyLoaded = applyAccount && accountSucceeded && applyCloud && cloudSucceeded;

      set({
        tenantId,
        loadedForTenantId: appliedFailure
          ? null
          : fullyLoaded
            ? tenantId
            : current.loadedForTenantId,
        account: nextAccount,
        accountLoadFailed: nextAccountLoadFailed,
        cloud: nextCloud,
        ...derived,
      });
    })().finally(() => {
      if (inFlightRefresh?.refreshId === refreshId) {
        inFlightRefresh = null;
      }
    });

    inFlightRefresh = { tenantId, refreshId, promise };
    return promise;
  },
}));

onSessionBoundary(() => {
  useCloudAttentionStore.getState().reset();
});
