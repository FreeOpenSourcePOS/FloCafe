'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { activeVariants } from '@/lib/product-variants';
import { formatItemHeading } from '@/lib/printer/item-heading';
import {
  clearOrderItemEditAttempt,
  isUnresolvedOrderItemEditFailure,
  newOrderItemEditAttempt,
  orderItemEditAttemptStorageKey,
  persistOrderItemEditAttempt,
  readOrderItemEditAttempt,
  withOrderItemEditAttemptLock,
  type OrderItemEditAttemptBody,
  type OrderItemEditAttemptMode,
  type OrderItemEditAttemptSnapshot,
} from '@/lib/order-item-edit-attempt';
import { useAuthStore } from '@/store/auth';
import type { Order, OrderItem, Product } from '@/lib/types';

interface Props {
  orderId: number;
  item: OrderItem;
  onClose: () => void;
  onSaved: (order: Order) => void;
}

interface AttemptState {
  attempt: OrderItemEditAttemptSnapshot | null;
  storageBlocked: boolean;
}

function readInitialAttemptState(
  tenantId: number | null,
  actorId: string | null,
  orderId: number,
  itemId: number,
): AttemptState {
  if (tenantId === null || !actorId) {
    return { attempt: null, storageBlocked: true };
  }
  try {
    return {
      attempt: readOrderItemEditAttempt(tenantId, actorId, orderId, itemId),
      storageBlocked: false,
    };
  } catch {
    return { attempt: null, storageBlocked: true };
  }
}

/** Owner-only edit of a live order line: change its quantity or swap it for another product. */
export default function EditOrderItemModal({ orderId, item, onClose, onSaved }: Props) {
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const { user, currentTenant } = useAuthStore();
  const actorId = user ? String(user.id) : null;
  const tenantId = currentTenant?.id ?? null;

  const [attemptState, setAttemptState] = useState<AttemptState>(() =>
    readInitialAttemptState(tenantId, actorId, orderId, item.id),
  );
  const lockedAttempt = attemptState.attempt;

  const [mode, setMode] = useState<OrderItemEditAttemptMode>(
    () => lockedAttempt?.mode ?? 'quantity',
  );
  const [quantity, setQuantity] = useState(() =>
    String(
      lockedAttempt?.body.quantity ??
        lockedAttempt?.body.replacement?.quantity ??
        item.quantity,
    ),
  );
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [variantId, setVariantId] = useState(
    () => lockedAttempt?.body.replacement?.variant_id ?? '',
  );
  const [saving, setSaving] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (mode !== 'replace' || products.length > 0) return;
    api
      .get('/products?active=1')
      .then((res) => setProducts((res.data?.products ?? res.data ?? []) as Product[]))
      .catch(() => toast.error(tOrders('editItemFailed')));
  }, [mode, products.length, tOrders]);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products
      .filter((product) => (product.addon_groups ?? []).every((group) => group.is_active === false))
      .filter((product) => !needle || product.name.toLowerCase().includes(needle))
      .slice(0, 30);
  }, [products, search]);

  const effectiveSelected = useMemo(() => {
    if (lockedAttempt?.mode === 'replace' && lockedAttempt.body.replacement?.product_id) {
      return (
        products.find((p) => p.id === lockedAttempt.body.replacement?.product_id) ?? selected
      );
    }
    return selected;
  }, [lockedAttempt, products, selected]);

  const variants = effectiveSelected ? activeVariants(effectiveSelected.variants) : [];
  const parsedQuantity = Number(quantity);
  const quantityValid = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
  const operationLocked = saving || lockedAttempt !== null;
  const canSave =
    !attemptState.storageBlocked &&
    (lockedAttempt !== null ||
      (quantityValid &&
        (mode === 'quantity'
          ? parsedQuantity !== Number(item.quantity)
          : !!effectiveSelected && (variants.length === 0 || !!variantId))));

  const handleClose = () => {
    if (inFlightRef.current || saving) return;
    onClose();
  };

  const save = async () => {
    if (inFlightRef.current || saving || !canSave) return;
    if (tenantId === null || !actorId || attemptState.storageBlocked) {
      toast.error(tOrders('editItemFailed'));
      return;
    }

    inFlightRef.current = true;
    setSaving(true);
    let persisted = lockedAttempt !== null;

    try {
      const scopedKey = orderItemEditAttemptStorageKey(tenantId, actorId, orderId, item.id);
      const committedOrder = await withOrderItemEditAttemptLock(scopedKey, async () => {
        const existing = readOrderItemEditAttempt(tenantId, actorId, orderId, item.id);
        let snapshot: OrderItemEditAttemptSnapshot;

        if (existing) {
          snapshot = existing;
          persisted = true;
          setAttemptState({ attempt: snapshot, storageBlocked: false });
        } else {
          const expectedEditVersion =
            typeof item.edit_version === 'number' &&
            Number.isSafeInteger(item.edit_version) &&
            item.edit_version >= 0
              ? item.edit_version
              : 0;
          const body: OrderItemEditAttemptBody =
            mode === 'quantity'
              ? {
                  expected_edit_version: expectedEditVersion,
                  quantity: parsedQuantity,
                }
              : {
                  expected_edit_version: expectedEditVersion,
                  replacement: {
                    product_id: effectiveSelected!.id,
                    quantity: parsedQuantity,
                    ...(variantId ? { variant_id: variantId } : {}),
                  },
                };

          snapshot = newOrderItemEditAttempt({
            mode,
            path: `/orders/${orderId}/items/${item.id}/edit`,
            orderId,
            itemId: item.id,
            body,
            actorId,
            tenantId,
          });
          persistOrderItemEditAttempt(snapshot);
          persisted = true;
          setAttemptState({ attempt: snapshot, storageBlocked: false });
        }

        try {
          const { data } = await api.patch(snapshot.path, snapshot.body, {
            headers: { 'Idempotency-Key': snapshot.idempotencyKey },
          });
          if (
            clearOrderItemEditAttempt(
              snapshot.tenantId,
              snapshot.actorId,
              snapshot.orderId,
              snapshot.itemId,
              snapshot.idempotencyKey,
            )
          ) {
            setAttemptState({ attempt: null, storageBlocked: false });
          }
          return data.order as Order;
        } catch (error) {
          const status = (error as { response?: { status?: unknown } })?.response?.status;
          if (!isUnresolvedOrderItemEditFailure(error) && status !== 401 && status !== 403) {
            if (
              clearOrderItemEditAttempt(
                snapshot.tenantId,
                snapshot.actorId,
                snapshot.orderId,
                snapshot.itemId,
                snapshot.idempotencyKey,
              )
            ) {
              setAttemptState({ attempt: null, storageBlocked: false });
            }
          }
          throw error;
        }
      });

      toast.success(tOrders('itemEdited'));
      onSaved(committedOrder);
      inFlightRef.current = false;
      setSaving(false);
      onClose();
    } catch (error) {
      if (!persisted) {
        setAttemptState((current) =>
          current.attempt ? current : { attempt: null, storageBlocked: true },
        );
      }
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      toast.error(message || tOrders('editItemFailed'));
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  };

  const heading = formatItemHeading(item.product_name, item.variant_selection);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-card rounded-xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="font-semibold text-foreground truncate">
            {tOrders('editItemTitle', { name: heading })}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            className="size-8 flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
            aria-label={tCommon('close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <div className="flex gap-2">
            {(['quantity', 'replace'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={mode === value ? 'default' : 'outline'}
                disabled={operationLocked}
                onClick={() => {
                  if (inFlightRef.current || operationLocked) return;
                  setMode(value);
                }}
              >
                {value === 'quantity' ? tOrders('editQuantityTab') : tOrders('editReplaceTab')}
              </Button>
            ))}
          </div>

          {mode === 'replace' && (
            <div className="space-y-2">
              <input
                type="search"
                value={search}
                disabled={operationLocked}
                onChange={(event) => {
                  if (inFlightRef.current || operationLocked) return;
                  setSearch(event.target.value);
                }}
                placeholder={tOrders('editSearchProducts')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
              />
              <div className="max-h-48 overflow-y-auto rounded-md border border-border divide-y divide-border">
                {matches.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">{tOrders('editNoProducts')}</p>
                )}
                {matches.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    disabled={operationLocked}
                    onClick={() => {
                      if (inFlightRef.current || operationLocked) return;
                      setSelected(product);
                      setVariantId('');
                    }}
                    className={`w-full flex justify-between px-3 py-2 text-sm text-start hover:bg-muted disabled:opacity-50 ${effectiveSelected?.id === product.id ? 'bg-muted font-medium' : ''}`}
                  >
                    <span className="truncate">{product.name}</span>
                    <span className="text-muted-foreground shrink-0 ms-2">
                      {fmt(Number(product.price))}
                    </span>
                  </button>
                ))}
              </div>
              {variants.length > 0 && (
                <select
                  value={variantId}
                  disabled={operationLocked}
                  onChange={(event) => {
                    if (inFlightRef.current || operationLocked) return;
                    setVariantId(event.target.value);
                  }}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">{tOrders('editChooseVariant')}</option>
                  {variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.name} · {fmt(Number(variant.price))}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <label className="block text-sm">
            <span className="text-muted-foreground">{tOrders('editNewQuantity')}</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={quantity}
              disabled={operationLocked}
              onChange={(event) => {
                if (inFlightRef.current || operationLocked) return;
                setQuantity(event.target.value);
              }}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <Button type="button" variant="outline" onClick={handleClose} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button type="button" onClick={save} disabled={!canSave || saving}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            {tCommon('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
