'use client';

import { useMemo } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import type { Category, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { nameToColor } from '@/lib/image-utils';
import TagBadge from './DietaryBadge';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import { parseDbTimestamp } from '@/lib/utils';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { resolveScannedProduct } from '@/lib/scale-barcode';

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string; activeBg: string; activeText: string }> = {
  red: { bg: 'bg-red-50 dark:bg-red-950/40', text: 'text-red-700 dark:text-red-300', border: 'border-red-200 dark:border-red-800/40', activeBg: 'bg-red-500', activeText: 'text-white' },
  orange: { bg: 'bg-orange-50 dark:bg-orange-950/40', text: 'text-orange-700 dark:text-orange-300', border: 'border-orange-200 dark:border-orange-800/40', activeBg: 'bg-orange-500', activeText: 'text-white' },
  amber: { bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-700 dark:text-amber-300', border: 'border-amber-200 dark:border-amber-800/40', activeBg: 'bg-amber-500', activeText: 'text-white' },
  yellow: { bg: 'bg-yellow-50 dark:bg-yellow-950/40', text: 'text-yellow-700 dark:text-yellow-300', border: 'border-yellow-200 dark:border-yellow-800/40', activeBg: 'bg-yellow-500', activeText: 'text-white' },
  lime: { bg: 'bg-lime-50 dark:bg-lime-950/40', text: 'text-lime-700 dark:text-lime-300', border: 'border-lime-200 dark:border-lime-800/40', activeBg: 'bg-lime-500', activeText: 'text-white' },
  green: { bg: 'bg-green-50 dark:bg-green-950/40', text: 'text-green-700 dark:text-green-300', border: 'border-green-200 dark:border-green-800/40', activeBg: 'bg-green-500', activeText: 'text-white' },
  emerald: { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-700 dark:text-emerald-300', border: 'border-emerald-200 dark:border-emerald-800/40', activeBg: 'bg-emerald-500', activeText: 'text-white' },
  teal: { bg: 'bg-teal-50 dark:bg-teal-950/40', text: 'text-teal-700 dark:text-teal-300', border: 'border-teal-200 dark:border-teal-800/40', activeBg: 'bg-teal-500', activeText: 'text-white' },
  cyan: { bg: 'bg-cyan-50 dark:bg-cyan-950/40', text: 'text-cyan-700 dark:text-cyan-300', border: 'border-cyan-200 dark:border-cyan-800/40', activeBg: 'bg-cyan-500', activeText: 'text-white' },
  sky: { bg: 'bg-sky-50 dark:bg-sky-950/40', text: 'text-sky-700 dark:text-sky-300', border: 'border-sky-200 dark:border-sky-800/40', activeBg: 'bg-sky-500', activeText: 'text-white' },
  blue: { bg: 'bg-blue-50 dark:bg-blue-950/40', text: 'text-blue-700 dark:text-blue-300', border: 'border-blue-200 dark:border-blue-800/40', activeBg: 'bg-blue-500', activeText: 'text-white' },
  indigo: { bg: 'bg-indigo-50 dark:bg-indigo-950/40', text: 'text-indigo-700 dark:text-indigo-300', border: 'border-indigo-200 dark:border-indigo-800/40', activeBg: 'bg-indigo-500', activeText: 'text-white' },
  violet: { bg: 'bg-violet-50 dark:bg-violet-950/40', text: 'text-violet-700 dark:text-violet-300', border: 'border-violet-200 dark:border-violet-800/40', activeBg: 'bg-violet-500', activeText: 'text-white' },
  purple: { bg: 'bg-purple-50 dark:bg-purple-950/40', text: 'text-purple-700 dark:text-purple-300', border: 'border-purple-200 dark:border-purple-800/40', activeBg: 'bg-purple-500', activeText: 'text-white' },
  fuchsia: { bg: 'bg-fuchsia-50 dark:bg-fuchsia-950/40', text: 'text-fuchsia-700 dark:text-fuchsia-300', border: 'border-fuchsia-200 dark:border-fuchsia-800/40', activeBg: 'bg-fuchsia-500', activeText: 'text-white' },
  pink: { bg: 'bg-pink-50 dark:bg-pink-950/40', text: 'text-pink-700 dark:text-pink-300', border: 'border-pink-200 dark:border-pink-800/40', activeBg: 'bg-pink-500', activeText: 'text-white' },
  rose: { bg: 'bg-rose-50 dark:bg-rose-950/40', text: 'text-rose-700 dark:text-rose-300', border: 'border-rose-200 dark:border-rose-800/40', activeBg: 'bg-rose-500', activeText: 'text-white' },
};

function getCategoryColorClasses(color: string | null | undefined) {
  if (!color) return null;
  return CATEGORY_COLORS[color.toLowerCase()] || null;
}

interface Props {
  categories: Category[];
  products: Product[];
  selectedCategory: string | null;
  setSelectedCategory: (id: string | null) => void;
  search: string;
  setSearch: (s: string) => void;
  currency: string;
  onProductClick: (product: Product) => void;
  sidebarOpen?: boolean;
}

export default function ProductGrid({
  categories, products, selectedCategory, setSelectedCategory,
  search, setSearch, onProductClick, sidebarOpen = true,
}: Props) {
  const cart = useCartStore();
  const { showProductImages } = usePosSettingsStore();
  const t = useTranslations('pos');
  const fmt = useFormatCurrency();
  const cartQuantities = useMemo(() => {
    const quantities = new Map<Product['id'], number>();
    for (const item of cart.items) {
      quantities.set(item.product.id, (quantities.get(item.product.id) || 0) + item.quantity);
    }
    return quantities;
  }, [cart.items]);

  const filtered = products.filter((p) => {
    const matchCat = !selectedCategory || p.category_id === selectedCategory;
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  return (
    <div data-testid="pos-product-grid" className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <div className="shrink-0 mb-3">
        <div className="relative mb-2">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // Typed or pasted barcode, not just a scanner — a dedicated
              // action into this field works regardless of typing speed.
              const trimmed = search.trim();
              if (!trimmed) return;
              const match = resolveScannedProduct(trimmed, products);
              if (match) {
                if (match.scaleBarcode) cart.addItem(match.product, match.quantity);
                else onProductClick(match.product);
                setSearch('');
              }
            }}
            placeholder={t('searchProducts')}
            className="w-full ps-9 pe-4 py-2 bg-card border border-border rounded-xl focus:border-brand outline-none transition-colors text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-2 pb-1">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              !selectedCategory ? 'bg-brand text-white' : 'bg-card text-foreground border border-border hover:bg-muted'
            }`}
          >
            {t('allCategories')}
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
                      : 'bg-card text-foreground border border-border hover:bg-muted'
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
            const inCartQty = cartQuantities.get(product.id) || 0;
            

            return (
              <button
                key={product.id}
                data-testid="pos-product-card"
                type="button"
                onClick={() => onProductClick(product)}
                className="min-h-36 bg-card rounded-xl p-2.5 border border-border hover:border-brand/40 active:border-brand active:bg-muted/40 hover:shadow-md transition-all text-start relative cursor-pointer overflow-hidden touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                {!!product.track_inventory && (
                  <>
                    {product.stock_quantity <= 0 ? (
                      <span className="absolute top-2 start-2 bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-[10px] font-bold px-2 py-0.5 rounded-full z-10 shadow-sm border border-red-200 dark:border-red-800/40 pointer-events-none">
                        {t('outOfStock')}
                      </span>
                    ) : product.stock_quantity <= (product.low_stock_threshold || 0) ? (
                      <span className="absolute top-2 start-2 bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 text-[10px] font-bold px-2 py-0.5 rounded-full z-10 shadow-sm border border-orange-200 dark:border-orange-800/40 pointer-events-none">
                        {t('lowStock')}
                      </span>
                    ) : null}
                  </>
                )}
                {inCartQty > 0 && (
                  <span className="absolute top-0 end-0 bg-brand text-white text-xs w-6 h-6 rounded-es-lg flex items-center justify-center font-bold z-10">
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
                        src={`${api.defaults.baseURL}/products/${product.id}/image?t=${product.updated_at ? parseDbTimestamp(product.updated_at).getTime() : 0}`}
                        alt={product.name}
                        className="absolute inset-0 w-full h-full object-cover rounded-lg"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}

                    {product.tags && product.tags.length > 0 && (
                      <span className="absolute bottom-1.5 end-1.5 z-10">
                        <TagBadge tag={product.tags[0]} />
                      </span>
                    )}
                  </div>
                )}

                <h3 className="font-medium text-foreground text-sm line-clamp-2 leading-snug">{product.name}</h3>
                <div className="flex items-center justify-between mt-1">
                  <p className="text-brand font-bold">
                    {fmt(Number(product.price))}
                  </p>
                  <div className="flex items-center gap-1 shrink-0">
                    {!showProductImages && product.tags && product.tags.length > 0 && (
                      <TagBadge tag={product.tags[0]} />
                    )}
                    {product.addon_groups && product.addon_groups.length > 0 && (
                      <span
                        className="touch-target -me-2 -my-2 rounded-lg text-muted-foreground"
                        title={t('customisable')}
                        aria-label={t('customisable')}
                      >
                        <SlidersHorizontal size={16} />
                      </span>
                    )}
                  </div>
                </div>

              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
