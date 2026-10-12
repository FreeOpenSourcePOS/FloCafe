'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { activeVariants } from '@/lib/product-variants';
import { formatItemHeading } from '@/lib/printer/item-heading';
import type { Order, OrderItem, Product } from '@/lib/types';

interface Props {
  orderId: number;
  item: OrderItem;
  onClose: () => void;
  onSaved: (order: Order) => void;
}

type Mode = 'quantity' | 'replace';

/** Owner-only edit of a live order line: change its quantity or swap it for another product. */
export default function EditOrderItemModal({ orderId, item, onClose, onSaved }: Props) {
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const [mode, setMode] = useState<Mode>('quantity');
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [variantId, setVariantId] = useState('');
  const [saving, setSaving] = useState(false);

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

  const variants = selected ? activeVariants(selected.variants) : [];
  const parsedQuantity = Number(quantity);
  const quantityValid = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
  const canSave =
    quantityValid &&
    (mode === 'quantity'
      ? parsedQuantity !== Number(item.quantity)
      : !!selected && (variants.length === 0 || !!variantId));

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const body =
        mode === 'quantity'
          ? { quantity: parsedQuantity }
          : {
              replacement: {
                product_id: selected!.id,
                quantity: parsedQuantity,
                ...(variantId ? { variant_id: variantId } : {}),
              },
            };
      const { data } = await api.patch(`/orders/${orderId}/items/${item.id}/edit`, body);
      toast.success(tOrders('itemEdited'));
      onSaved(data.order as Order);
      onClose();
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      toast.error(message || tOrders('editItemFailed'));
    } finally {
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
            onClick={onClose}
            className="size-8 flex items-center justify-center rounded-md hover:bg-muted"
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
                onClick={() => setMode(value)}
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
                onChange={(event) => setSearch(event.target.value)}
                placeholder={tOrders('editSearchProducts')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <div className="max-h-48 overflow-y-auto rounded-md border border-border divide-y divide-border">
                {matches.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">{tOrders('editNoProducts')}</p>
                )}
                {matches.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => {
                      setSelected(product);
                      setVariantId('');
                    }}
                    className={`w-full flex justify-between px-3 py-2 text-sm text-start hover:bg-muted ${selected?.id === product.id ? 'bg-muted font-medium' : ''}`}
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
                  onChange={(event) => setVariantId(event.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
              onChange={(event) => setQuantity(event.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
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
