'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, GripVertical, RefreshCw, Save } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import type { Category, Product } from '@/lib/types';
import { useAuthStore } from '@/store/auth';

function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return items;
  const next = [...items];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}

export default function ProductOrderPage() {
  const { currentTenant } = useAuthStore();
  const isOwnerOrManager = currentTenant?.role === 'owner' || currentTenant?.role === 'manager';
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [productsRes, categoriesRes] = await Promise.all([
        api.get('/products'),
        api.get('/categories'),
      ]);
      setProducts((productsRes.data.products as Product[]) || []);
      setCategories((categoriesRes.data.categories as Category[]) || []);
    } catch {
      toast.error('Nepodařilo se načíst pořadí produktů.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveOrder = async (kind: 'products' | 'categories', items: Product[] | Category[]) => {
    setSaving(true);
    try {
      await Promise.all(items.map((item, index) => {
        const id = item.id;
        return kind === 'products'
          ? api.put(`/products/${id}`, { sort_order: index * 10 })
          : api.put(`/categories/${id}`, { sort_order: index * 10 });
      }));
      toast.success(kind === 'products' ? 'Pořadí produktů uloženo.' : 'Pořadí kategorií uloženo.');
    } catch {
      toast.error('Pořadí se nepodařilo uložit.');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const reorderProducts = async (index: number, direction: -1 | 1) => {
    if (saving) return;
    const next = moveItem(products, index, direction);
    if (next === products) return;
    setProducts(next);
    await saveOrder('products', next);
  };

  const reorderCategories = async (index: number, direction: -1 | 1) => {
    if (saving) return;
    const next = moveItem(categories, index, direction);
    if (next === categories) return;
    setCategories(next);
    await saveOrder('categories', next);
  };

  if (!isOwnerOrManager) {
    return (
      <div className="max-w-3xl mx-auto py-12">
        <h1 className="text-2xl font-bold text-gray-900">Pořadí na POS</h1>
        <p className="mt-2 text-gray-600">Tuto stránku může upravovat pouze vlastník nebo manažer.</p>
      </div>
    );
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" /></div>;
  }

  return (
    <div className="max-w-5xl mx-auto pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pořadí na POS</h1>
          <p className="text-sm text-gray-500 mt-1">Pomocí šipek nastav pořadí kategorií a produktů. POS ho použije automaticky.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/products" className="px-4 py-2 rounded-lg border border-gray-200 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50">
            Zpět na Produkty
          </Link>
          <button type="button" onClick={() => void load()} disabled={loading || saving} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw size={16} /> Obnovit
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="p-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Kategorie</h2>
            <p className="text-xs text-gray-500 mt-1">Toto pořadí určuje i pořadí tlačítek kategorií na POS.</p>
          </div>
          <div className="divide-y divide-gray-100">
            {categories.map((category, index) => (
              <div key={category.id} className="flex items-center gap-3 p-3">
                <GripVertical size={16} className="text-gray-300 shrink-0" />
                <span className="text-sm text-gray-400 w-6 text-center">{index + 1}</span>
                <span className="flex-1 font-medium text-gray-900">{category.name}</span>
                <div className="flex gap-1">
                  <button type="button" aria-label={`Posunout ${category.name} nahoru`} onClick={() => void reorderCategories(index, -1)} disabled={index === 0 || saving} className="p-1.5 rounded-md border border-gray-200 hover:bg-gray-50 disabled:opacity-30">
                    <ArrowUp size={15} />
                  </button>
                  <button type="button" aria-label={`Posunout ${category.name} dolů`} onClick={() => void reorderCategories(index, 1)} disabled={index === categories.length - 1 || saving} className="p-1.5 rounded-md border border-gray-200 hover:bg-gray-50 disabled:opacity-30">
                    <ArrowDown size={15} />
                  </button>
                </div>
              </div>
            ))}
            {categories.length === 0 && <p className="p-6 text-sm text-gray-500 text-center">Žádné kategorie.</p>}
          </div>
        </section>

        <section className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="p-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Produkty</h2>
            <p className="text-xs text-gray-500 mt-1">Pořadí produktů se zachová i po restartu aplikace a projeví se na POS.</p>
          </div>
          <div className="divide-y divide-gray-100">
            {products.map((product, index) => (
              <div key={product.id} className="flex items-center gap-3 p-3">
                <GripVertical size={16} className="text-gray-300 shrink-0" />
                <span className="text-sm text-gray-400 w-6 text-center">{index + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">{product.name}</p>
                  <p className="text-xs text-gray-400 truncate">{product.category?.name || 'Bez kategorie'}</p>
                </div>
                <div className="flex gap-1">
                  <button type="button" aria-label={`Posunout ${product.name} nahoru`} onClick={() => void reorderProducts(index, -1)} disabled={index === 0 || saving} className="p-1.5 rounded-md border border-gray-200 hover:bg-gray-50 disabled:opacity-30">
                    <ArrowUp size={15} />
                  </button>
                  <button type="button" aria-label={`Posunout ${product.name} dolů`} onClick={() => void reorderProducts(index, 1)} disabled={index === products.length - 1 || saving} className="p-1.5 rounded-md border border-gray-200 hover:bg-gray-50 disabled:opacity-30">
                    <ArrowDown size={15} />
                  </button>
                </div>
              </div>
            ))}
            {products.length === 0 && <p className="p-6 text-sm text-gray-500 text-center">Žádné produkty.</p>}
          </div>
        </section>
      </div>

      {saving && (
        <div className="fixed bottom-5 right-5 inline-flex items-center gap-2 rounded-lg bg-gray-900 text-white px-4 py-2 text-sm shadow-lg">
          <Save size={15} /> Ukládám pořadí…
        </div>
      )}
    </div>
  );
}
