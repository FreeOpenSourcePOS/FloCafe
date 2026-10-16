'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import AddonModal from '@/components/pos/AddonModal';
import { formatItemHeading } from '@/lib/printer/item-heading';
import { cartVariantUnitPrice } from '@/lib/cart-price';
import {
  attemptBodiesMatch,
  clearOrderItemEditAttempt,
  newOrderItemEditAttempt,
  orderItemEditAttemptStorageKey,
  persistOrderItemEditAttempt,
  readOrderItemEditAttempt,
  replayOrderItemEditAttempt,
  withOrderItemEditAttemptLock,
  type OrderItemEditAttemptBody,
  type OrderItemEditAttemptMode,
  type OrderItemEditAttemptSnapshot,
} from '@/lib/order-item-edit-attempt';
import { useAuthStore } from '@/store/auth';
import type { Addon, Order, OrderItem, Product, ProductVariant } from '@/lib/types';

interface Props {
  orderId: number;
  item: OrderItem;
  /** Quote the variant's online platform price, matching the order this line belongs to. */
  onlinePlatformSelected?: boolean;
  onClose: () => void;
  onSaved: (order: Order) => void;
  onIdentityChanged: () => void;
}

interface AttemptState {
  attempt: OrderItemEditAttemptSnapshot | null;
  storageBlocked: boolean;
}

interface ReplacementConfig {
  product: Product;
  quantity: number;
  variant: ProductVariant | null;
  addons: Addon[];
  instructions: string;
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
export default function EditOrderItemModal({
  orderId,
  item,
  onlinePlatformSelected = false,
  onClose,
  onSaved,
  onIdentityChanged,
}: Props) {
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

  const isStarted = !['pending'].includes(item.status);

  const [mode, setMode] = useState<OrderItemEditAttemptMode>(
    () => lockedAttempt?.mode ?? 'quantity',
  );
  const [quantity, setQuantity] = useState(() =>
    String(
      lockedAttempt?.body.quantity ?? lockedAttempt?.body.replacement?.quantity ?? item.quantity,
    ),
  );
  const [reason, setReason] = useState(() => lockedAttempt?.body.reason ?? '');
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [replacementConfig, setReplacementConfig] = useState<ReplacementConfig | null>(null);
  const [customizingProduct, setCustomizingProduct] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (mode !== 'replace' || products.length > 0) return;
    api
      .get('/products?active=1')
      .then((res) => setProducts((res.data?.products ?? res.data ?? []) as Product[]))
      .catch(() => toast.error(tOrders('editItemFailed')));
  }, [mode, products.length, tOrders]);

  const effectiveReplacement = useMemo<ReplacementConfig | null>(() => {
    if (replacementConfig) return replacementConfig;
    if (
      !lockedAttempt ||
      lockedAttempt.mode !== 'replace' ||
      !lockedAttempt.body.replacement ||
      products.length === 0
    ) {
      return null;
    }
    const rep = lockedAttempt.body.replacement;
    const foundProd = products.find((p) => p.id === rep.product_id);
    if (!foundProd) return null;
    const foundVariant = rep.variant_id
      ? (foundProd.variants?.find((v) => v.id === rep.variant_id) ?? null)
      : null;
    return {
      product: foundProd,
      quantity: rep.quantity,
      variant: foundVariant,
      addons: (rep.addons ?? []).map((a) => ({
        id: String(a.id ?? ''),
        name: a.name ?? '',
        price: Number(a.price ?? 0),
        quantity: Number(a.quantity ?? 1),
        addon_group_id: '',
        track_inventory: false,
        stock_quantity: 0,
        low_stock_threshold: 0,
        is_active: true,
        sort_order: 0,
      })),
      instructions: rep.special_instructions ?? '',
    };
  }, [replacementConfig, lockedAttempt, products]);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products
      .filter((product) => !needle || product.name.toLowerCase().includes(needle))
      .slice(0, 30);
  }, [products, search]);

  const parsedQuantity = Number(quantity);
  const quantityValid = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
  const isDecrease = parsedQuantity < Number(item.quantity);
  const reasonValid = !isStarted || !isDecrease || reason.trim().length > 0;
  const operationLocked = saving || lockedAttempt !== null;
  const canSave =
    !attemptState.storageBlocked &&
    reasonValid &&
    (lockedAttempt !== null ||
      (quantityValid &&
        (mode === 'quantity' ? parsedQuantity !== Number(item.quantity) : !!effectiveReplacement)));

  const handleClose = () => {
    if (inFlightRef.current || saving) return;
    onClose();
  };

  const refreshAfterConflict = async () => {
    try {
      const { data } = await api.get(`/orders/${orderId}`);
      const refreshedOrder = (data?.order ?? data) as Order | undefined;
      if (refreshedOrder && typeof refreshedOrder === 'object' && 'id' in refreshedOrder) {
        onSaved(refreshedOrder);
      }
    } catch {
      // Best-effort refresh before closing the conflicted modal.
    }
    inFlightRef.current = false;
    setSaving(false);
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

    const buildBody = (): OrderItemEditAttemptBody => {
      const expectedEditVersion =
        typeof item.edit_version === 'number' &&
        Number.isSafeInteger(item.edit_version) &&
        item.edit_version >= 0
          ? item.edit_version
          : 0;
      return mode === 'quantity'
        ? {
            expected_edit_version: expectedEditVersion,
            quantity: parsedQuantity,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          }
        : {
            expected_edit_version: expectedEditVersion,
            replacement: {
              product_id: effectiveReplacement!.product.id,
              quantity: parsedQuantity,
              ...(effectiveReplacement!.variant?.id
                ? { variant_id: effectiveReplacement!.variant.id }
                : {}),
              addons: effectiveReplacement!.addons.map((a) => ({
                id: a.id,
                name: a.name,
                price: a.price,
                quantity: a.quantity,
              })),
              ...(effectiveReplacement!.instructions
                ? { special_instructions: effectiveReplacement!.instructions }
                : {}),
            },
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          };
    };

    try {
      const scopedKey = orderItemEditAttemptStorageKey(tenantId, actorId, orderId, item.id);
      const committedOrder = await withOrderItemEditAttemptLock(scopedKey, async () => {
        const existing = readOrderItemEditAttempt(tenantId, actorId, orderId, item.id);
        let snapshot: OrderItemEditAttemptSnapshot;

        if (existing) {
          const intended = lockedAttempt ?? { mode, body: buildBody() };
          if (
            existing.mode !== intended.mode ||
            !attemptBodiesMatch(existing.body, intended.body)
          ) {
            return null;
          }
          snapshot = existing;
          persisted = true;
          setAttemptState({ attempt: snapshot, storageBlocked: false });
        } else {
          snapshot = newOrderItemEditAttempt({
            mode,
            path: `/orders/${orderId}/items/${item.id}/edit`,
            orderId,
            itemId: item.id,
            body: buildBody(),
            actorId,
            tenantId,
          });
          persistOrderItemEditAttempt(snapshot);
          persisted = true;
          setAttemptState({ attempt: snapshot, storageBlocked: false });
        }

        const result = await replayOrderItemEditAttempt<Order>({
          snapshot,
          send: async (path, body, idempotencyKey) => {
            const { data } = await api.patch(path, body, {
              headers: { 'Idempotency-Key': idempotencyKey },
            });
            return data.order as Order;
          },
        });

        if (result.outcome === 'committed') {
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
          return result.data;
        }
        if (result.outcome === 'rejected') {
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
        // unresolved / authRequired / forbidden / rateLimited: the saved record
        // stays because these responses cannot establish that an earlier
        // request committed.
        throw result.error;
      });

      if (committedOrder === null) {
        toast.error(tOrders('editItemFailed'));
        await refreshAfterConflict();
        return;
      }

      // Identity may have changed while the awaited lock ran; never install
      // another actor's or order's results into the current view.
      const postLockIdentity = useAuthStore.getState();
      const postLockActorId = postLockIdentity.user ? String(postLockIdentity.user.id) : null;
      if (postLockIdentity.currentTenant?.id !== tenantId || postLockActorId !== actorId) {
        inFlightRef.current = false;
        setSaving(false);
        onClose();
        onIdentityChanged();
        return;
      }

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
      const status = (error as { response?: { status?: unknown } })?.response?.status;
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      toast.error(message || tOrders('editItemFailed'));
      if (status === 409) {
        await refreshAfterConflict();
        return;
      }
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  };

  const heading = formatItemHeading(item.product_name, item.variant_selection);

  return (
    <>
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
              <Button
                type="button"
                size="sm"
                variant={mode === 'quantity' ? 'default' : 'outline'}
                disabled={operationLocked}
                onClick={() => {
                  if (inFlightRef.current || operationLocked) return;
                  setMode('quantity');
                }}
              >
                {tOrders('editQuantityTab')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'replace' ? 'default' : 'outline'}
                disabled={operationLocked || isStarted}
                onClick={() => {
                  if (inFlightRef.current || operationLocked || isStarted) return;
                  setMode('replace');
                }}
              >
                {tOrders('editReplaceTab')}
              </Button>
            </div>

            {isStarted && (
              <p className="text-xs text-muted-foreground bg-muted p-2 rounded-md">
                {tOrders('editPreparationStartedHint')}
              </p>
            )}

            {mode === 'replace' && effectiveReplacement && (
              <div className="rounded-lg border border-border p-3 bg-muted/40 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {effectiveReplacement.product.name}
                      {effectiveReplacement.variant && ` (${effectiveReplacement.variant.name})`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {fmt(
                        cartVariantUnitPrice(
                          {
                            product: effectiveReplacement.product,
                            variant: effectiveReplacement.variant,
                          },
                          onlinePlatformSelected,
                        ),
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={operationLocked}
                    onClick={() => setCustomizingProduct(effectiveReplacement.product)}
                  >
                    {tCommon('edit')}
                  </Button>
                </div>
                {effectiveReplacement.addons.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    + {effectiveReplacement.addons.map((a) => a.name).join(', ')}
                  </p>
                )}
                {effectiveReplacement.instructions && (
                  <p className="text-xs italic text-muted-foreground">
                    &ldquo;{effectiveReplacement.instructions}&rdquo;
                  </p>
                )}
              </div>
            )}

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
                        setCustomizingProduct(product);
                      }}
                      className={`w-full flex justify-between px-3 py-2 text-sm text-start hover:bg-muted disabled:opacity-50 ${effectiveReplacement?.product.id === product.id ? 'bg-muted font-medium' : ''}`}
                    >
                      <span className="truncate">{product.name}</span>
                      <span className="text-muted-foreground shrink-0 ms-2">
                        {fmt(Number(product.price))}
                      </span>
                    </button>
                  ))}
                </div>
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

            {isDecrease && (
              <label className="block text-sm">
                <span className="text-muted-foreground">
                  {isStarted ? tOrders('editWasteReasonLabel') : tCommon('reasonOptional')}
                </span>
                <input
                  type="text"
                  value={reason}
                  maxLength={200}
                  disabled={operationLocked}
                  onChange={(event) => {
                    if (inFlightRef.current || operationLocked) return;
                    setReason(event.target.value);
                  }}
                  placeholder={isStarted ? tOrders('editWasteReasonPlaceholder') : ''}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
                />
              </label>
            )}
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

      {customizingProduct && (
        <div className="relative z-[70]">
          <AddonModal
            product={customizingProduct}
            currency={currentTenant?.currency || 'USD'}
            country={currentTenant?.country}
            onlinePlatformSelected={onlinePlatformSelected}
            initialQuantity={parsedQuantity > 0 ? parsedQuantity : 1}
            initialVariant={
              effectiveReplacement?.product.id === customizingProduct.id
                ? effectiveReplacement.variant
                : null
            }
            initialAddons={
              effectiveReplacement?.product.id === customizingProduct.id
                ? effectiveReplacement.addons
                : []
            }
            initialInstructions={
              effectiveReplacement?.product.id === customizingProduct.id
                ? effectiveReplacement.instructions
                : ''
            }
            mode="edit"
            onAdd={(prod, qty, addons, instructions, variant) => {
              setReplacementConfig({
                product: prod,
                quantity: qty,
                variant,
                addons,
                instructions,
              });
              setQuantity(String(qty));
              setCustomizingProduct(null);
            }}
            onClose={() => setCustomizingProduct(null)}
          />
        </div>
      )}
    </>
  );
}
