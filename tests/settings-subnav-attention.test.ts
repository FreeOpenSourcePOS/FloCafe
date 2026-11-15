/**
 * Regression tests for shared cloud attention state between the sidebar
 * Settings indicator and Settings sub-navigation items (`Account`, `Privacy`).
 *
 * Run: npm run test:settings-subnav-attention
 */

import assert from 'node:assert/strict';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const Module = require('node:module') as {
  createRequire: (filename: string) => NodeRequire;
  _resolveFilename: (...args: any[]) => string;
  _load: (request: string, parent: any, isMain: boolean) => any;
};
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const zustandPath = frontendRequire.resolve('zustand');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

type MockApiCall = { path: string };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTenant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    business_name: 'E2E Cafe',
    role: 'owner',
    plan: 'free',
    status: 'active',
    business_type: 'restaurant',
    language: 'en',
    ...overrides,
  };
}

async function run() {
  const apiCalls: MockApiCall[] = [];
  let getHandler: (url: string) => Promise<{ data: any }> = async () => ({ data: {} });

  Module._resolveFilename = function (request: string, parent: any, ...rest: any[]) {
    if (request.startsWith('@/')) {
      const target = path.join(ROOT, 'frontend/src', request.slice(2));
      return originalResolveFilename.call(this, target, parent, ...rest);
    }
    if (request === 'zustand') {
      return zustandPath;
    }
    return originalResolveFilename.call(this, request, parent, ...rest);
  };

  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request === '@/lib/api') {
      return {
        __esModule: true,
        default: {
          get: async (url: string) => {
            apiCalls.push({ path: url });
            return getHandler(url);
          },
        },
      };
    }
    return originalLoad.apply(this, arguments as any);
  };

  try {
    const storePath = require.resolve('../frontend/src/store/cloud-attention');
    delete require.cache[storePath];
    const { deriveCloudAttention, useCloudAttentionStore } =
      require('../frontend/src/store/cloud-attention') as typeof import('../frontend/src/store/cloud-attention');

    // 1. Pure derivation: unverified email activates Account only
    const unverified = deriveCloudAttention({
      canManageCloudAccount: true,
      account: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
      accountLoadFailed: false,
      cloud: { cloud_registration_status: 'registered', cloud_deletion_status: '' },
    });
    assert.deepEqual(unverified, {
      emailNeedsAttention: true,
      deletionNeedsAttention: false,
      anyNeedsAttention: true,
    });

    // 2. Pure derivation: actionable deletion statuses activate Privacy only
    for (const status of ['pending', 'processing', 'failed'] as const) {
      const fromAccount = deriveCloudAttention({
        canManageCloudAccount: true,
        account: {
          cloud_account_available: false,
          email: null,
          verified: false,
          deletion_request: { status },
        },
        accountLoadFailed: false,
        cloud: { cloud_registration_status: 'deletion_pending', cloud_deletion_status: '' },
      });
      assert.deepEqual(
        fromAccount,
        {
          emailNeedsAttention: false,
          deletionNeedsAttention: true,
          anyNeedsAttention: true,
        },
        `account deletion_request.status=${status} must mark deletionNeedsAttention`,
      );

      const fromCloudStatus = deriveCloudAttention({
        canManageCloudAccount: true,
        account: {
          cloud_account_available: false,
          email: null,
          verified: false,
          deletion_request: null,
        },
        accountLoadFailed: false,
        cloud: { cloud_registration_status: 'deletion_pending', cloud_deletion_status: status },
      });
      assert.deepEqual(
        fromCloudStatus,
        {
          emailNeedsAttention: false,
          deletionNeedsAttention: true,
          anyNeedsAttention: true,
        },
        `cloud_deletion_status=${status} must mark deletionNeedsAttention`,
      );
    }

    // 3. Terminal deletion and verified email produce no attention
    assert.deepEqual(
      deriveCloudAttention({
        canManageCloudAccount: true,
        account: {
          cloud_account_available: false,
          email: null,
          verified: false,
          deletion_request: { status: 'pending' },
        },
        accountLoadFailed: false,
        cloud: { cloud_registration_status: 'deleted', cloud_deletion_status: 'deleted' },
      }),
      {
        emailNeedsAttention: false,
        deletionNeedsAttention: false,
        anyNeedsAttention: false,
      },
    );

    assert.deepEqual(
      deriveCloudAttention({
        canManageCloudAccount: true,
        account: { cloud_account_available: true, email: 'owner@flo.local', verified: true },
        accountLoadFailed: false,
        cloud: { cloud_registration_status: 'registered', cloud_deletion_status: '' },
      }),
      {
        emailNeedsAttention: false,
        deletionNeedsAttention: false,
        anyNeedsAttention: false,
      },
    );

    // 4. Non-owner / missing cloud.account.manage permission never shows attention
    assert.deepEqual(
      deriveCloudAttention({
        canManageCloudAccount: false,
        account: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
        accountLoadFailed: false,
        cloud: { cloud_registration_status: 'registered', cloud_deletion_status: 'failed' },
      }),
      {
        emailNeedsAttention: false,
        deletionNeedsAttention: false,
        anyNeedsAttention: false,
      },
    );

    // 5. Store refresh deduplicates same-tenant non-forced refreshes and syncs updates
    useCloudAttentionStore.getState().reset();
    apiCalls.length = 0;
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') {
        return {
          data: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
        };
      }
      if (url === '/settings/cloud') {
        return { data: { cloud_registration_status: 'registered', cloud_deletion_status: '' } };
      }
      throw new Error(`Unexpected GET ${url}`);
    };

    const ownerTenant = makeTenant({ id: 1, role: 'owner' });
    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    assert.equal(apiCalls.length, 2);
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, true);
    assert.equal(useCloudAttentionStore.getState().deletionNeedsAttention, false);
    assert.equal(useCloudAttentionStore.getState().anyNeedsAttention, true);

    // Non-forced repeat for same tenant does not refetch
    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    assert.equal(apiCalls.length, 2);

    // Syncing verified account clears attention immediately without network calls
    useCloudAttentionStore.getState().syncAccount(1, {
      cloud_account_available: true,
      email: 'owner@flo.local',
      verified: true,
    });
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, false);
    assert.equal(useCloudAttentionStore.getState().anyNeedsAttention, false);

    // 6. Custom role with cloud.account.manage but without cloud.manage still detects unverified email
    useCloudAttentionStore.getState().reset();
    apiCalls.length = 0;
    const customAccountOnlyTenant = makeTenant({
      id: 2,
      role: 'manager',
      permission_ids: ['settings.view', 'cloud.account.manage'],
    });
    await useCloudAttentionStore.getState().refreshForTenant(customAccountOnlyTenant as any);
    assert.deepEqual(
      apiCalls.map((c) => c.path),
      ['/settings/cloud/account'],
    );
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, true);

    // 7. Tenant switch discards stale in-flight response from previous tenant
    useCloudAttentionStore.getState().reset();
    apiCalls.length = 0;
    const slowAccount = createDeferred<{ data: any }>();
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') return slowAccount.promise;
      return { data: { cloud_registration_status: 'registered', cloud_deletion_status: '' } };
    };
    const pendingRefresh = useCloudAttentionStore
      .getState()
      .refreshForTenant(makeTenant({ id: 10, role: 'owner' }) as any);
    // Switch to non-owner tenant before tenant 10 resolves
    await useCloudAttentionStore
      .getState()
      .refreshForTenant(makeTenant({ id: 11, role: 'cashier' }) as any);
    slowAccount.resolve({
      data: { cloud_account_available: true, email: 'stale@flo.local', verified: false },
    });
    await pendingRefresh;
    assert.equal(useCloudAttentionStore.getState().tenantId, 11);
    assert.equal(useCloudAttentionStore.getState().anyNeedsAttention, false);

    // 8. Session boundary resets cloud attention state
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') {
        return {
          data: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
        };
      }
      return { data: { cloud_registration_status: 'registered', cloud_deletion_status: '' } };
    };
    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    assert.equal(useCloudAttentionStore.getState().anyNeedsAttention, true);
    const { notifySessionBoundary } =
      require('../frontend/src/store/session-events') as typeof import('../frontend/src/store/session-events');
    notifySessionBoundary('logout');
    assert.equal(useCloudAttentionStore.getState().anyNeedsAttention, false);
    assert.equal(useCloudAttentionStore.getState().tenantId, null);

    // 9. syncAccount and syncCloudStatus ignore calls for non-active or logged-out tenants
    useCloudAttentionStore.getState().syncAccount(1, {
      cloud_account_available: true,
      email: 'stale@flo.local',
      verified: false,
    });
    useCloudAttentionStore.getState().syncCloudStatus(1, {
      cloud_registration_status: 'deletion_pending',
      cloud_deletion_status: 'pending',
    });
    assert.equal(useCloudAttentionStore.getState().tenantId, null);
    assert.equal(useCloudAttentionStore.getState().anyNeedsAttention, false);

    await useCloudAttentionStore
      .getState()
      .refreshForTenant(makeTenant({ id: 2, role: 'owner' }) as any);
    useCloudAttentionStore.getState().syncAccount(1, {
      cloud_account_available: true,
      email: 'tenant1@flo.local',
      verified: false,
    });
    useCloudAttentionStore.getState().syncCloudStatus(1, {
      cloud_registration_status: 'deletion_pending',
      cloud_deletion_status: 'pending',
    });
    assert.equal(useCloudAttentionStore.getState().tenantId, 2);
    assert.equal(useCloudAttentionStore.getState().account?.email, 'owner@flo.local');
    assert.equal(useCloudAttentionStore.getState().deletionNeedsAttention, false);

    // 10. syncAccount and syncCloudStatus supersede an in-flight same-tenant refresh
    useCloudAttentionStore.getState().reset();
    apiCalls.length = 0;
    const staleRefreshAccount = createDeferred<{ data: any }>();
    let refreshAttempt = 0;
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') {
        refreshAttempt += 1;
        if (refreshAttempt === 1) return staleRefreshAccount.promise;
        return {
          data: { cloud_account_available: true, email: 'owner@flo.local', verified: true },
        };
      }
      return { data: { cloud_registration_status: 'registered', cloud_deletion_status: '' } };
    };
    const inFlightSameTenant = useCloudAttentionStore
      .getState()
      .refreshForTenant(ownerTenant as any);
    useCloudAttentionStore.getState().syncAccount(1, {
      cloud_account_available: true,
      email: 'owner@flo.local',
      verified: true,
    });
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, false);
    staleRefreshAccount.resolve({
      data: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
    });
    await inFlightSameTenant;
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, false);
    assert.equal(useCloudAttentionStore.getState().account?.verified, true);

    // Subsequent non-forced refresh starts a new request because inFlightRefresh was cleared
    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    assert.equal(refreshAttempt, 2);

    // Same superseding guarantee for syncCloudStatus
    useCloudAttentionStore.getState().reset();
    const staleDeletionAccount = createDeferred<{ data: any }>();
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') return staleDeletionAccount.promise;
      return {
        data: { cloud_registration_status: 'deletion_pending', cloud_deletion_status: 'pending' },
      };
    };
    const inFlightDeletionRefresh = useCloudAttentionStore
      .getState()
      .refreshForTenant(ownerTenant as any);
    useCloudAttentionStore.getState().syncCloudStatus(1, {
      cloud_registration_status: 'deleted',
      cloud_deletion_status: 'deleted',
    });
    assert.equal(useCloudAttentionStore.getState().deletionNeedsAttention, false);
    staleDeletionAccount.resolve({
      data: {
        cloud_account_available: false,
        email: null,
        verified: false,
        deletion_request: { status: 'pending' },
      },
    });
    await inFlightDeletionRefresh;
    assert.equal(useCloudAttentionStore.getState().deletionNeedsAttention, false);
    assert.equal(useCloudAttentionStore.getState().cloud?.cloud_deletion_status, 'deleted');

    // 11. syncCloudStatus during an in-flight refresh keeps the pending account result, and vice versa
    useCloudAttentionStore.getState().reset();
    const delayedUnverifiedAccount = createDeferred<{ data: any }>();
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') return delayedUnverifiedAccount.promise;
      return { data: { cloud_registration_status: 'unregistered', cloud_deletion_status: '' } };
    };
    const pendingOrderflowRefresh = useCloudAttentionStore
      .getState()
      .refreshForTenant(ownerTenant as any);
    useCloudAttentionStore.getState().syncCloudStatus(1, {
      cloud_registration_status: 'registered',
      cloud_deletion_status: '',
    });
    delayedUnverifiedAccount.resolve({
      data: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
    });
    await pendingOrderflowRefresh;
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, true);
    assert.equal(useCloudAttentionStore.getState().anyNeedsAttention, true);
    assert.equal(useCloudAttentionStore.getState().cloud?.cloud_registration_status, 'registered');

    useCloudAttentionStore.getState().reset();
    const delayedPendingCloud = createDeferred<{ data: any }>();
    getHandler = async (url) => {
      if (url === '/settings/cloud') return delayedPendingCloud.promise;
      return { data: { cloud_account_available: true, email: 'owner@flo.local', verified: false } };
    };
    const pendingAccountSyncRefresh = useCloudAttentionStore
      .getState()
      .refreshForTenant(ownerTenant as any);
    useCloudAttentionStore.getState().syncAccount(1, {
      cloud_account_available: true,
      email: 'owner@flo.local',
      verified: true,
    });
    delayedPendingCloud.resolve({
      data: { cloud_registration_status: 'deletion_pending', cloud_deletion_status: 'pending' },
    });
    await pendingAccountSyncRefresh;
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, false);
    assert.equal(useCloudAttentionStore.getState().deletionNeedsAttention, true);
    assert.equal(useCloudAttentionStore.getState().account?.verified, true);

    // 12. Partial failure when permitted /settings/cloud rejects does not cache loadedForTenantId
    useCloudAttentionStore.getState().reset();
    apiCalls.length = 0;
    let cloudStatusFailureCount = 0;
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') {
        return {
          data: {
            cloud_account_available: false,
            email: null,
            verified: false,
            deletion_request: null,
          },
        };
      }
      cloudStatusFailureCount += 1;
      if (cloudStatusFailureCount === 1) {
        throw new Error('502 Bad Gateway');
      }
      return {
        data: { cloud_registration_status: 'deletion_pending', cloud_deletion_status: 'pending' },
      };
    };
    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, null);
    assert.equal(useCloudAttentionStore.getState().deletionNeedsAttention, false);

    // Subsequent non-forced refresh retries /settings/cloud and recovers deletion attention
    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    assert.equal(cloudStatusFailureCount, 2);
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, 1);
    assert.equal(useCloudAttentionStore.getState().deletionNeedsAttention, true);

    // Custom role lacking cloud.manage still marks tenant loaded after /settings/cloud/account succeeds
    useCloudAttentionStore.getState().reset();
    apiCalls.length = 0;
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') {
        return {
          data: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    };
    await useCloudAttentionStore.getState().refreshForTenant(customAccountOnlyTenant as any);
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, 2);
    await useCloudAttentionStore.getState().refreshForTenant(customAccountOnlyTenant as any);
    assert.equal(apiCalls.length, 1);

    // 13. syncAccount(..., true) invalidates loadedForTenantId so non-forced refresh retries
    useCloudAttentionStore.getState().reset();
    apiCalls.length = 0;
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') {
        return {
          data: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
        };
      }
      return { data: { cloud_registration_status: 'registered', cloud_deletion_status: '' } };
    };
    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, 1);
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, true);
    assert.equal(apiCalls.length, 2);

    useCloudAttentionStore.getState().syncAccount(1, null, true);
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, null);
    assert.equal(useCloudAttentionStore.getState().accountLoadFailed, true);
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, false);

    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    assert.equal(apiCalls.length, 4);
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, 1);
    assert.equal(useCloudAttentionStore.getState().accountLoadFailed, false);
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, true);

    // 14. Superseded in-flight refresh completing after a newer forced refresh preserves loadedForTenantId
    useCloudAttentionStore.getState().reset();
    apiCalls.length = 0;
    const staleForcedAccount = createDeferred<{ data: any }>();
    let forcedAttempt = 0;
    getHandler = async (url) => {
      if (url === '/settings/cloud/account') {
        forcedAttempt += 1;
        if (forcedAttempt === 1) return staleForcedAccount.promise;
        return {
          data: { cloud_account_available: true, email: 'owner@flo.local', verified: true },
        };
      }
      return { data: { cloud_registration_status: 'registered', cloud_deletion_status: '' } };
    };
    const olderRefresh = useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any, { force: true });
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, 1);
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, false);

    staleForcedAccount.resolve({
      data: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
    });
    await olderRefresh;
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, 1);
    assert.equal(useCloudAttentionStore.getState().emailNeedsAttention, false);
    assert.equal(useCloudAttentionStore.getState().account?.verified, true);

    const callsBeforeRepeat = apiCalls.length;
    await useCloudAttentionStore.getState().refreshForTenant(ownerTenant as any);
    assert.equal(apiCalls.length, callsBeforeRepeat);

    // Partial supersede: forced refresh with syncAccount(..., false) preserves loadedForTenantId,
    // while syncAccount(..., true) keeps loadedForTenantId cleared.
    const partialForcedCloud = createDeferred<{ data: any }>();
    getHandler = async (url) => {
      if (url === '/settings/cloud') return partialForcedCloud.promise;
      return {
        data: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
      };
    };
    const partialForcedRefresh = useCloudAttentionStore
      .getState()
      .refreshForTenant(ownerTenant as any, { force: true });
    useCloudAttentionStore.getState().syncAccount(1, {
      cloud_account_available: true,
      email: 'owner@flo.local',
      verified: true,
    });
    partialForcedCloud.resolve({
      data: { cloud_registration_status: 'registered', cloud_deletion_status: '' },
    });
    await partialForcedRefresh;
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, 1);
    assert.equal(useCloudAttentionStore.getState().account?.verified, true);

    const failedSyncCloud = createDeferred<{ data: any }>();
    getHandler = async (url) => {
      if (url === '/settings/cloud') return failedSyncCloud.promise;
      return {
        data: { cloud_account_available: true, email: 'owner@flo.local', verified: false },
      };
    };
    const refreshDuringFailedSync = useCloudAttentionStore
      .getState()
      .refreshForTenant(ownerTenant as any, { force: true });
    useCloudAttentionStore.getState().syncAccount(1, null, true);
    failedSyncCloud.resolve({
      data: { cloud_registration_status: 'registered', cloud_deletion_status: '' },
    });
    await refreshDuringFailedSync;
    assert.equal(useCloudAttentionStore.getState().loadedForTenantId, null);
    assert.equal(useCloudAttentionStore.getState().accountLoadFailed, true);

    console.log('settings-subnav-attention unit tests: all assertions passed');
  } finally {
    Module._resolveFilename = originalResolveFilename;
    Module._load = originalLoad;
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
