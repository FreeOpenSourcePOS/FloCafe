'use client';

import { useState } from 'react';
import { X, Plus, Minus } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Product, Addon, AddonGroup } from '@/lib/types';

interface Props {
  product: Product;
  currency: string;
  onAdd: (product: Product, quantity: number, addons: Addon[], specialInstructions: string) => void;
  onClose: () => void;
  initialQuantity?: number;
  initialAddons?: Addon[];
  initialInstructions?: string;
  mode?: 'add' | 'edit';
}

function groupInitialAddons(addons: Addon[]): Record<string | number, Addon[]> {
  const grouped: Record<string | number, Addon[]> = {};
  for (const addon of addons) {
    const groupId = addon.addon_group_id;
    if (groupId == null) continue;
    grouped[groupId] = [...(grouped[groupId] || []), addon];
  }
  return grouped;
}

export default function AddonModal({
  product, onAdd, onClose,
  initialQuantity = 1, initialAddons = [], initialInstructions = '', mode = 'add',
}: Props) {
  const { t } = useI18n();
  const fmt = useFormatCurrency();
  const [selected, setSelected] = useState<Record<string | number, Addon[]>>(() => groupInitialAddons(initialAddons));
  const [quantity, setQuantity] = useState(initialQuantity);
  const [instructions, setInstructions] = useState(initialInstructions);

  const groups = product.addon_groups || [];

  const getGroupTotalQuantity = (groupId: string | number): number => {
    const list = selected[groupId] || [];
    return list.reduce((sum, a) => sum + (a.quantity || 1), 0);
  };

  const updateAddonQuantity = (group: AddonGroup, addon: Addon, delta: number) => {
    const groupId = group.id;
    const currentList = selected[groupId] || [];
    const existingIndex = currentList.findIndex((a) => a.id === addon.id);
    const currentQty = existingIndex >= 0 ? (currentList[existingIndex].quantity || 1) : 0;
    const newQty = currentQty + delta;

    if (newQty <= 0) {
      const updatedList = currentList.filter((a) => a.id !== addon.id);
      setSelected({ ...selected, [groupId]: updatedList });
    } else {
      const currentGroupTotal = currentList.reduce((sum, a) => sum + (a.quantity || 1), 0);
      const newGroupTotal = currentGroupTotal + delta;
      const max = group.max_selection || 999;
      if (delta > 0 && newGroupTotal > max) {
        toast.error(t('pos.maxSelectionReached', { count: max }));
        return;
      }

      if (existingIndex >= 0) {
        const updatedList = [...currentList];
        updatedList[existingIndex] = { ...updatedList[existingIndex], quantity: newQty };
        setSelected({ ...selected, [groupId]: updatedList });
      } else {
        setSelected({ ...selected, [groupId]: [...currentList, { ...addon, quantity: newQty }] });
      }
    }
  };

  const toggleAddonCheckbox = (group: AddonGroup, addon: Addon) => {
    const currentList = selected[group.id] || [];
    const exists = currentList.some((a) => a.id === addon.id);
    if (exists) {
      updateAddonQuantity(group, addon, -1);
    } else {
      updateAddonQuantity(group, addon, 1);
    }
  };

  const getAddonQuantity = (groupId: string | number, addonId: string | number): number => {
    const list = selected[groupId] || [];
    const item = list.find((a) => a.id === addonId);
    return item ? (item.quantity || 1) : 0;
  };

  const allAddons = Object.values(selected).flat();
  const addonTotal = allAddons.reduce((sum, a) => sum + Number(a.price) * (a.quantity || 1), 0);
  const itemTotal = (Number(product.price) + addonTotal) * quantity;

  const isValid = groups.every((g) => {
    const count = getGroupTotalQuantity(g.id);
    const requiredMin = Boolean(g.is_required) ? Math.max(1, g.min_selection || 1) : (g.min_selection || 0);
    if (count < requiredMin) return false;
    if (g.max_selection && count > g.max_selection) return false;
    return true;
  });

  const handleAdd = () => {
    if (!isValid) return;
    onAdd(product, quantity, allAddons, instructions);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] flex flex-col">
        <div className="flex justify-between items-center p-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{product.name}</h2>
            <p className="text-brand font-semibold">{fmt(Number(product.price))}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {groups.map((group) => {
            const count = getGroupTotalQuantity(group.id);
            const activeAddons = (group.addons || []).filter((a) => a.is_active);
            const allowMultiple = Boolean(group.allow_multiple_quantities);

            return (
              <div key={group.id}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-sm text-gray-900">{group.name}</h3>
                  <span className="flex items-center gap-2">
                    {Boolean(group.is_required) && (
                      <span className="text-xs text-red-500 font-medium">{t('pos.required')}</span>
                    )}
                    {group.max_selection ? (() => {
                      const remaining = Math.max(0, group.max_selection - count);
                      const isZero = remaining === 0;
                      return (
                        <span className={`font-semibold transition-all ${
                          isZero
                            ? 'text-sm text-amber-500'
                            : 'text-xs text-sky-500'
                        }`}>
                          {isZero ? t('pos.selectionComplete') : t('pos.remainingCount', { count: remaining })}
                        </span>
                      );
                    })() : null}
                  </span>
                </div>
                {group.description && <p className="text-xs text-gray-400 mb-2">{group.description}</p>}
                <div className="space-y-1">
                  {activeAddons.map((addon) => {
                    const addonQty = getAddonQuantity(group.id, addon.id);
                    const isSel = addonQty > 0;

                    if (allowMultiple) {
                      return (
                        <div
                          key={addon.id}
                          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                            isSel
                              ? 'border-brand bg-brand-light text-brand'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{addon.name}</span>
                            <span className={`text-xs ${isSel ? 'text-brand font-semibold' : 'text-gray-500'}`}>
                              {Number(addon.price) === 0 ? t('pos.freeAddon') : `+${fmt(Number(addon.price))}`}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {isSel ? (
                              <div className="flex items-center gap-1.5 bg-white border border-brand rounded-lg p-0.5">
                                <button
                                  type="button"
                                  onClick={() => updateAddonQuantity(group, addon, -1)}
                                  className="w-6 h-6 rounded flex items-center justify-center text-brand hover:bg-brand-light"
                                >
                                  <Minus size={14} />
                                </button>
                                <span className="text-xs font-bold w-4 text-center text-brand">{addonQty}</span>
                                <button
                                  type="button"
                                  onClick={() => updateAddonQuantity(group, addon, 1)}
                                  className="w-6 h-6 rounded flex items-center justify-center text-brand hover:bg-brand-light"
                                >
                                  <Plus size={14} />
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => updateAddonQuantity(group, addon, 1)}
                                className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 hover:bg-gray-200"
                              >
                                <Plus size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={addon.id}
                        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                          isSel
                            ? 'border-brand bg-brand-light text-brand'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{addon.name}</span>
                          <span className={`text-xs ${isSel ? 'text-brand font-semibold' : 'text-gray-500'}`}>
                            {Number(addon.price) === 0 ? t('pos.freeAddon') : `+${fmt(Number(addon.price))}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {isSel ? (
                            <div className="flex items-center gap-1.5 bg-white border border-brand rounded-lg p-0.5">
                              <button
                                type="button"
                                onClick={() => toggleAddonCheckbox(group, addon)}
                                className="w-6 h-6 rounded flex items-center justify-center text-brand hover:bg-brand-light"
                              >
                                <Minus size={14} />
                              </button>
                              <span className="text-xs font-bold w-4 text-center text-brand">1</span>
                              <button
                                type="button"
                                disabled
                                className="w-6 h-6 rounded flex items-center justify-center text-gray-300 cursor-not-allowed opacity-50"
                              >
                                <Plus size={14} />
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleAddonCheckbox(group, addon)}
                              className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 hover:bg-gray-200"
                            >
                              <Plus size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const requiredMin = Boolean(group.is_required) ? Math.max(1, group.min_selection || 1) : (group.min_selection || 0);
                  if (requiredMin > 0 && count < requiredMin) {
                    return (
                      <p className="text-xs text-red-500 mt-1">{t('pos.selectAtLeast', { count: requiredMin })}</p>
                    );
                  }
                  return null;
                })()}
              </div>
            );
          })}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('pos.specialInstructions')}</label>
            <input
              type="text"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value.slice(0, 100))}
              placeholder={t('pos.specialInstructionsPlaceholder')}
              maxLength={100}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand"
            />
            <p className="text-xs text-gray-400 text-right mt-0.5">{instructions.length}/100</p>
          </div>
        </div>

        <div className="p-5 border-t border-gray-100">
          <div className="flex items-center justify-center gap-4 mb-4">
            <button
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
              className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200"
            >
              <Minus size={16} />
            </button>
            <span className="text-lg font-bold w-8 text-center">{quantity}</span>
            <button
              onClick={() => setQuantity(quantity + 1)}
              className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200"
            >
              <Plus size={16} />
            </button>
          </div>
          <Button onClick={handleAdd} disabled={!isValid} className="w-full" size="lg">
            {mode === 'edit'
              ? t('pos.saveItemChanges', { total: fmt(itemTotal), defaultValue: 'Save changes — {total}' })
              : t('pos.addToCart', { total: fmt(itemTotal) })}
          </Button>
        </div>
      </div>
    </div>
  );
}
