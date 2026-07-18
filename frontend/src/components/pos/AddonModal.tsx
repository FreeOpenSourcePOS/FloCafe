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
}

export default function AddonModal({ product, onAdd, onClose }: Props) {
  const { t } = useI18n();
  const fmt = useFormatCurrency();
  const [selected, setSelected] = useState<Record<number, Addon[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [instructions, setInstructions] = useState('');

  const groups = product.addon_groups || [];

  const toggleAddon = (group: AddonGroup, addon: Addon) => {
    const current = selected[group.id] || [];
    const exists = current.find((a) => a.id === addon.id);

    if (exists) {
      setSelected({ ...selected, [group.id]: current.filter((a) => a.id !== addon.id) });
    } else {
      const max = group.max_selection || 999;
      if (current.length >= max) {
        toast.error(t('pos.maxSelectionReached', { count: max }));
        return;
      }
      setSelected({ ...selected, [group.id]: [...current, addon] });
    }
  };

  const isSelected = (groupId: number, addonId: number) =>
    (selected[groupId] || []).some((a) => a.id === addonId);

  const allAddons = Object.values(selected).flat();
  const addonTotal = allAddons.reduce((sum, a) => sum + Number(a.price), 0);
  const itemTotal = (Number(product.price) + addonTotal) * quantity;

  const isValid = groups.every((g) => {
    if (!g.is_required) return true;
    const count = (selected[g.id] || []).length;
    return count >= g.min_selection;
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
            const count = (selected[group.id] || []).length;
            const activeAddons = (group.addons || []).filter((a) => a.is_active);

            return (
              <div key={group.id}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-sm text-gray-900">{group.name}</h3>
                  <span className="flex items-center gap-2">
                    {group.is_required && (
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
                  {activeAddons.map((addon) => (
                    <button
                      key={addon.id}
                      onClick={() => toggleAddon(group, addon)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                        isSelected(group.id, addon.id)
                          ? 'border-brand bg-brand-light text-brand'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <span className="font-medium">{addon.name}</span>
                      <span className={isSelected(group.id, addon.id) ? 'text-brand font-semibold' : 'text-gray-500'}>
                        {Number(addon.price) === 0 ? t('pos.freeAddon') : `+${fmt(Number(addon.price))}`}
                      </span>
                    </button>
                  ))}
                </div>
                {group.is_required && count < group.min_selection && (
                  <p className="text-xs text-red-500 mt-1">{t('pos.selectAtLeast', { count: group.min_selection })}</p>
                )}
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
            {t('pos.addToCart', { total: fmt(itemTotal) })}
          </Button>
        </div>
      </div>
    </div>
  );
}
