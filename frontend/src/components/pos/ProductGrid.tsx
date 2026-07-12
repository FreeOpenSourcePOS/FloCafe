'use client';

import { Search, SlidersHorizontal } from 'lucide-react';
import type { Category, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { nameToColor } from '@/lib/image-utils';
import TagBadge, { firstTagBg } from './DietaryBadge';
import api from '@/lib/api';

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string; activeBg: string; activeText: string }> = {
  red: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', activeBg: 'bg-red-500', activeText: 'text-white' },
  orange: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', activeBg: 'bg-orange-500', activeText: 'text-white' },
  amber: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', activeBg: 'bg-amber-500', activeText: 'text-white' },
  yellow: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', activeBg: 'bg-yellow-500', activeText: 'text-white' },
  lime: { bg: 'bg-lime-50', text: 'text-lime-700', border: 'border-lime-200', activeBg: 'bg-lime-500', activeText: 'text-white' },
  green: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', activeBg: 'bg-green-500', activeText: 'text-white' },
  emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', activeBg: 'bg-emerald-500', activeText: 'text-white' },
  teal: { bg: 'bg-teal-50', text: 'text-teal-700', border: 'border-teal-200', activeBg: 'bg-teal-500', activeText: 'text-white' },
  cyan: { bg: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200', activeBg: 'bg-cyan-500', activeText: 'text-white' },
  sky: { bg: 'bg-sky-50', text: 'text-sky-700', border: 'border-sky-200', activeBg: 'bg-sky-500', activeText: 'text-white' },
  blue: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', activeBg: 'bg-blue-500', activeText: 'text-white' },
  indigo: { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', activeBg: 'bg-indigo-500', activeText: 'text-white' },
  violet: { bg: 'bg-violet-50', text: 'text-violet-700', border: 'border-violet-200', activeBg: 'bg-violet-500', activeText: 'text-white' },
  purple: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', activeBg: 'bg-purple-500', activeText: 'text-white' },
  fuchsia: { bg: 'bg-fuchsia-50', text: 'text-fuchsia-700', border: 'border-fuchsia-200', activeBg: 'bg-fuchsia-500', activeText: 'text-white' },
  pink: { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200', activeBg: 'bg-pink-500', activeText: 'text-white' },
  rose: { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', activeBg: 'bg-rose-500', activeText: 'text-white' },
};

function getCategoryColorClasses(color: string | null | undefined) {
  if (!color) return null;
  return CATEGORY_COLORS[color.toLowerCase()] || null;
}

interface Props {
  categories: Category[];
  products: Product[];
  selectedCategory: number | null;
  setSelectedCategory: (id: number | null) => void;
  search: string;
  setSearch: (s: string) => void;
  currency: string;
  onProductClick: (product: Product) => void;
  sidebarOpen?: boolean;
}

export default function ProductGrid({
  categories, products, selectedCategory, setSelectedCategory,
  search, setSearch, currency, onProductClick, sidebarOpen = true,
}: Props) {
  const cart = useCartStore();
  const { showProductImages } = usePosSettingsStore();

  const filtered = products.filter((p) => {
    const matchCat = !selectedCategory || p.category_id === selectedCategory;
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <div className="shrink-0 mb-3">
        <div className="relative mb-2">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products..."
            className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl focus:border-brand outline-none transition-colors text-sm"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              !selectedCategory ? 'bg-brand text-white' : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            All
          </button>
          {categories.filter((cat) => cat.id != null).map((cat) => {
            const colorClasses = getCategoryColorClasses(cat.color);
            const isSelected = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  isSelected
                    ? colorClasses
                      ? `${colorClasses.activeBg} ${colorClasses.activeText}`
                      : 'bg-brand text-white'
                    : colorClasses
                      ? `${colorClasses.bg} ${colorClasses.text} border ${colorClasses.border} hover:opacity-80`
                      : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
                }`}
              >
                {cat.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
        <div className={`grid gap-3 ${
          sidebarOpen 
            ? 'grid-cols-4' 
            : 'grid-cols-5'
        }`}>
          {filtered.map((product) => {
            const inCartQty = cart.items
              .filter((i) => i.product.id === product.id)
              .reduce((sum, i) => sum + i.quantity, 0);
            const bgColor = firstTagBg(product.tags);

            return (
              <div
                key={product.id}
                onClick={() => onProductClick(product)}
                className="bg-white rounded-xl p-2.5 border border-gray-100 hover:border-brand/40 hover:shadow-md transition-all text-left relative group cursor-pointer overflow-hidden"
              >
                {inCartQty > 0 && (
                  <span className="absolute top-0 right-0 bg-brand text-white text-xs w-6 h-6 rounded-bl-lg flex items-center justify-center font-bold z-10">
                    {inCartQty}
                  </span>
                )}

                {showProductImages && (
                  <div className="w-full aspect-square rounded-lg mb-3 relative overflow-hidden">
                    {/* Always-visible background tile — no flash when image loads */}
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ backgroundColor: nameToColor(product.name) }}
                    >
                      <span className="text-2xl font-bold text-white/80">
                        {product.name.substring(0, 2).toUpperCase()}
                      </span>
                    </div>

                    {/* Image overlays the tile when available */}
                    {product.has_image && (
                      <img
                        src={`${api.defaults.baseURL}/products/${product.id}/image?t=${product.updated_at ? new Date(product.updated_at).getTime() : 0}`}
                        alt={product.name}
                        className="absolute inset-0 w-full h-full object-cover rounded-lg"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}

                    {product.tags && product.tags.length > 0 && (
                      <span className="absolute bottom-1.5 right-1.5 z-10">
                        <TagBadge tag={product.tags[0]} />
                      </span>
                    )}
                  </div>
                )}

                <h3 className="font-medium text-gray-900 text-sm line-clamp-2 leading-snug">{product.name}</h3>
                <div className="flex items-center justify-between mt-1">
                  <p className="text-brand font-bold">
                    {currency}{Number(product.price).toLocaleString()}
                  </p>
                  <div className="flex items-center gap-1 shrink-0">
                    {!showProductImages && product.tags && product.tags.length > 0 && (
                      <TagBadge tag={product.tags[0]} />
                    )}
                    {product.addon_groups && product.addon_groups.length > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onProductClick(product);
                        }}
                        className="text-gray-400 hover:text-gray-600 transition-colors"
                        title="Customisable"
                      >
                        <SlidersHorizontal size={12} />
                      </button>
                    )}
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
