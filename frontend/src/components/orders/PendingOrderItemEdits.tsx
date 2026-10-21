'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import {
  clearOrderItemEditAttempt,
  listOrderItemEditAttempts,
  orderItemEditAttemptStorageKey,
  orderItemEditAttemptsEquivalent,
  readOrderItemEditAttempt,
  replayOrderItemEditAttempt,
  subscribeOrderItemEditAttemptsChanged,
  withOrderItemEditAttemptLock,
  type OrderItemEditAttemptSnapshot,
} from '@/lib/order-item-edit-attempt';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import type { Order, OrderItem } from '@/lib/types';

interface Props {
  orderId: number;
  /** Order lines (including superseded ones) used to name the pending item. */
  items?: OrderItem[];
  /** Same orders.item.edit gate the edit modal and inline edit controls use. */
  canEditItems: boolean;
  /** Called with item IDs that must show no competing edit control while unresolved. */
  onPendingItemsChanged?: (itemIds: number[]) => void;
  /** Parent refresh after a resolution changes or clears the saved record. */
  onItemEditResolved?: (orderId: number) => Promise<boolean> | void;
}

type InlineIssueKey =
  | 'pendingItemEditAuthRequired'
  | 'pendingItemEditRateLimited'
  | 'pendingItemEditHint'
  | 'pendingItemEditRefreshFailed'
  | 'pendingItemEditStorageError';
type InlineIssue = { messageKey: InlineIssueKey; message?: string } | null;

/**
 * Discoverable manual recovery for saved order-item edits that never got a
 * confirmed backend result. The record survives reloads, tab changes, hidden
 * superseded lines and terminal orders; resolving is the only way a saved edit
 * is replayed, and it always reuses the stored path, body and Idempotency-Key.
 */
export default function PendingOrderItemEdits({
  orderId,
  items,
  canEditItems,
  onPendingItemsChanged,
  onItemEditResolved,
}: Props) {
  const tOrders = useTranslations('orders');
  const tPos = useTranslations('pos');
  const tCommon = useTranslations('common');
  const tSettings = useTranslations('settings');
  const { user, currentTenant } = useAuthStore();
  const actorId = user ? String(user.id) : null;
  const tenantId = currentTenant?.id ?? null;

  const scanInitial = (): { attempts: OrderItemEditAttemptSnapshot[]; unreadable: boolean } => {
    if (tenantId === null || !actorId) return { attempts: [], unreadable: false };
    try {
      const listed = listOrderItemEditAttempts(tenantId, actorId, orderId);
      return { attempts: listed.attempts, unreadable: listed.hasUnreadableRecords };
    } catch {
      return { attempts: [], unreadable: true };
    }
  };

  const [initialScan] = useState(scanInitial);
  const [attempts, setAttempts] = useState<OrderItemEditAttemptSnapshot[]>(initialScan.attempts);
  const [hasUnreadableRecords, setHasUnreadableRecords] = useState(initialScan.unreadable);
  const [resolvingItemId, setResolvingItemId] = useState<number | null>(null);
  const [issues, setIssues] = useState<Record<number, InlineIssue>>({});
  const [refreshErrors, setRefreshErrors] = useState<
    Record<number, { orderId: number; confirmed: boolean }>
  >({});
  const [rejectionNotices, setRejectionNotices] = useState<Record<number, string>>({});
  const [storageErrors, setStorageErrors] = useState<Record<number, boolean>>({});

  const itemLabel = (itemId: number) =>
    items?.find((item) => item.id === itemId)?.product_name ?? `#${itemId}`;

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const rescan = useCallback(() => {
    if (tenantId === null || !actorId) {
      setAttempts([]);
      setHasUnreadableRecords(false);
      return;
    }
    try {
      const listed = listOrderItemEditAttempts(tenantId, actorId, orderId);
      if (!mountedRef.current) return;
      setAttempts(listed.attempts);
      setHasUnreadableRecords(listed.hasUnreadableRecords);
    } catch {
      if (!mountedRef.current) return;
      setAttempts([]);
      setHasUnreadableRecords(true);
    }
  }, [actorId, orderId, tenantId]);

  useEffect(() => {
    mountedRef.current = true;
    // Same-tab changes (custom event) and other-tab changes (storage event)
    // trigger a rescan; the module subscribes/unsubscribes both for this scope.
    const unsubscribe = subscribeOrderItemEditAttemptsChanged(
      tenantId === null || !actorId ? null : { tenantId, actorId, orderId },
      rescan,
    );
    // Re-affirm the scan after identity/order-driven resynchronization without
    // setting state synchronously inside the effect.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) rescan();
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      unsubscribe();
    };
  }, [actorId, orderId, rescan, tenantId]);

  // Keep onPendingItemsChanged in a ref so changes to parent callback instances
  // never trigger a re-notification or enter a render loop.
  const onPendingItemsChangedRef = useRef(onPendingItemsChanged);
  useEffect(() => {
    onPendingItemsChangedRef.current = onPendingItemsChanged;
  }, [onPendingItemsChanged]);

  const pendingItemIds = attempts.map((attempt) => attempt.itemId);
  const pendingKey = pendingItemIds.join(',');
  const lastNotifiedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastNotifiedKeyRef.current === pendingKey) return;
    lastNotifiedKeyRef.current = pendingKey;
    const ids = pendingKey ? pendingKey.split(',').map(Number) : [];
    onPendingItemsChangedRef.current?.(ids);
  }, [pendingKey]);

  const identity = useCallback(() => {
    const current = useAuthStore.getState();
    return {
      tenant: current.currentTenant?.id ?? null,
      actor: current.user ? String(current.user.id) : null,
      canEditItems: tenantCan(current.currentTenant, 'orders.item.edit'),
    };
  }, []);

  const retryRefresh = async (itemId: number, targetOrderId: number, confirmed: boolean) => {
    if (!onItemEditResolved) return;
    let refreshed = false;
    try {
      const outcome = onItemEditResolved(targetOrderId);
      refreshed = (await outcome) !== false;
    } catch {
      refreshed = false;
    }
    if (!mountedRef.current) return;
    setRefreshErrors((prev) => {
      const next = { ...prev };
      if (refreshed) delete next[itemId];
      else next[itemId] = { orderId: targetOrderId, confirmed };
      return next;
    });
  };

  const dismissRejection = (itemId: number) => {
    setRejectionNotices((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  };

  const resolve = async (attempt: OrderItemEditAttemptSnapshot) => {
    if (inFlightRef.current || !canEditItems) return;
    const scope = identity();
    if (scope.tenant === null || !scope.actor) {
      setIssues((prev) => ({
        ...prev,
        [attempt.itemId]: { messageKey: 'pendingItemEditAuthRequired' },
      }));
      return;
    }
    if (
      scope.tenant !== attempt.tenantId ||
      scope.actor !== attempt.actorId ||
      scope.tenant !== tenantId ||
      scope.actor !== actorId
    ) {
      rescan();
      return;
    }

    inFlightRef.current = true;
    setResolvingItemId(attempt.itemId);
    setIssues((prev) => ({ ...prev, [attempt.itemId]: null }));

    let outcomeHandled = false;
    try {
      const result = await withOrderItemEditAttemptLock(
        orderItemEditAttemptStorageKey(
          attempt.tenantId,
          attempt.actorId,
          attempt.orderId,
          attempt.itemId,
        ),
        async () => {
          // Re-check identity, mounted state, and permissions inside the lock
          // immediately before sending, so a queued recovery cannot dispatch
          // under a different token or revoked permission.
          if (!mountedRef.current) return null;
          const currentScope = identity();
          if (
            currentScope.tenant !== attempt.tenantId ||
            currentScope.actor !== attempt.actorId ||
            !currentScope.canEditItems
          ) {
            return null;
          }

          // Re-read inside the lock: the offered record must still exist and
          // still match, or the offer is stale and we rescan instead of sending.
          const current = readOrderItemEditAttempt(
            attempt.tenantId,
            attempt.actorId,
            attempt.orderId,
            attempt.itemId,
          );
          if (!current || !orderItemEditAttemptsEquivalent(current, attempt)) {
            return null;
          }
          return replayOrderItemEditAttempt({
            snapshot: current,
            send: async (path, body, idempotencyKey) => {
              const { data } = await api.patch(path, body, {
                headers: { 'Idempotency-Key': idempotencyKey },
              });
              return data.order as Order;
            },
          });
        },
      );

      const finalScope = identity();
      if (
        !mountedRef.current ||
        finalScope.actor !== scope.actor ||
        finalScope.tenant !== scope.tenant
      ) {
        return;
      }

      if (result === null) {
        // The offer went stale or identity changed while waiting for lock.
        rescan();
        outcomeHandled = true;
        return;
      }

      if (result.outcome === 'rejected') {
        // Definitive rejection (e.g. 409 stale edit version, 400/404/422).
        // Clear the matching record, refresh current order data, and display
        // the rejection message.
        const cleared = clearOrderItemEditAttempt(
          attempt.tenantId,
          attempt.actorId,
          attempt.orderId,
          attempt.itemId,
          attempt.idempotencyKey,
        );
        outcomeHandled = true;
        await retryRefresh(attempt.itemId, attempt.orderId, false);
        if (!mountedRef.current) return;
        if (!cleared) {
          setStorageErrors((prev) => ({ ...prev, [attempt.itemId]: true }));
        }
        const backendMessage = ((result.error as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? undefined) as string | undefined;
        setRejectionNotices((prev) => ({
          ...prev,
          [attempt.itemId]: backendMessage || tOrders('editItemFailed'),
        }));
        rescan();
        return;
      }

      if (result.outcome !== 'committed') {
        // Keep the record; surface the specific recoverable reason inline.
        const messageKey: InlineIssueKey =
          result.outcome === 'authRequired'
            ? 'pendingItemEditAuthRequired'
            : result.outcome === 'rateLimited'
              ? 'pendingItemEditRateLimited'
              : 'pendingItemEditHint';
        const backendMessage = ((result.error as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? undefined) as string | undefined;
        setIssues((prev) => ({
          ...prev,
          [attempt.itemId]: {
            messageKey,
            message:
              messageKey === 'pendingItemEditHint' && backendMessage ? backendMessage : undefined,
          } as InlineIssue,
        }));
        outcomeHandled = true;
        rescan();
        return;
      }

      // Committed. Compare-and-clear the matching record only.
      const cleared = clearOrderItemEditAttempt(
        attempt.tenantId,
        attempt.actorId,
        attempt.orderId,
        attempt.itemId,
        attempt.idempotencyKey,
      );
      outcomeHandled = true;
      await retryRefresh(attempt.itemId, attempt.orderId, true);
      if (!mountedRef.current) return;
      if (!cleared) {
        setStorageErrors((prev) => ({
          ...prev,
          [attempt.itemId]: true,
        }));
      }
      rescan();
    } catch {
      if (!mountedRef.current || !outcomeHandled) {
        rescan();
      }
    } finally {
      if (mountedRef.current) setResolvingItemId(null);
      inFlightRef.current = false;
    }
  };

  const hasRefreshErrors = Object.keys(refreshErrors).length > 0;
  const hasRejectionNotices = Object.keys(rejectionNotices).length > 0;
  const hasStorageErrors = Object.keys(storageErrors).length > 0;

  if (tenantId === null || !actorId) return null;
  if (
    attempts.length === 0 &&
    !hasUnreadableRecords &&
    !hasRefreshErrors &&
    !hasRejectionNotices &&
    !hasStorageErrors
  ) {
    return null;
  }

  return (
    <div
      className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3 space-y-2 mb-2"
      data-testid="pending-order-item-edits"
    >
      {attempts.map((attempt) => {
        const issue = issues[attempt.itemId] ?? null;
        const resolving = resolvingItemId === attempt.itemId;
        return (
          <div
            key={attempt.itemId}
            className="flex flex-col gap-1"
            data-pending-item-id={attempt.itemId}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {tOrders('pendingItemEdit')} ({itemLabel(attempt.itemId)})
                </p>
                <p className="text-xs text-muted-foreground">{tOrders('pendingItemEditHint')}</p>
              </div>
              {canEditItems ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={resolving || resolvingItemId !== null}
                  onClick={() => {
                    if (inFlightRef.current || resolving) return;
                    void resolve(attempt);
                  }}
                >
                  {resolving && <Loader2 size={14} className="animate-spin me-1.5" />}
                  {resolving
                    ? tOrders('resolvingPendingItemEdit')
                    : tOrders('resolvePendingItemEdit')}
                </Button>
              ) : null}
            </div>
            {issue && (
              <p
                className="text-xs text-red-600 dark:text-red-400"
                data-testid="pending-item-edit-issue"
              >
                {issue.message
                  ? `${tOrders(issue.messageKey)}: ${issue.message}`
                  : tOrders(issue.messageKey)}
              </p>
            )}
          </div>
        );
      })}

      {Object.entries(refreshErrors).map(([itemIdStr, refreshError]) => {
        const itemId = Number(itemIdStr);
        return (
          <div
            key={`refresh-err-${itemId}`}
            className="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="pending-item-edit-refresh-failed"
          >
            <span>
              {refreshError.confirmed
                ? tOrders('pendingItemEditRefreshFailed')
                : tPos('loadOrderFailed')}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="retry-refresh-button"
              onClick={() =>
                void retryRefresh(itemId, refreshError.orderId, refreshError.confirmed)
              }
            >
              {tSettings('retry')}
            </Button>
          </div>
        );
      })}

      {Object.entries(rejectionNotices).map(([itemIdStr, message]) => {
        const itemId = Number(itemIdStr);
        return (
          <div
            key={`reject-${itemId}`}
            className="flex items-center justify-between gap-2 text-xs text-red-600 dark:text-red-400"
            data-testid="pending-item-edit-rejection"
          >
            <span>
              {tOrders('pendingItemEdit')} ({itemLabel(itemId)}): {message}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => dismissRejection(itemId)}
            >
              {tCommon('close')}
            </Button>
          </div>
        );
      })}

      {(hasUnreadableRecords || hasStorageErrors) && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="pending-item-edit-storage-warning"
        >
          {tOrders('pendingItemEditStorageError')}
        </p>
      )}
    </div>
  );
}
