'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, X, Package, Folder, Puzzle, FileSpreadsheet, Download, Upload, CheckCircle, AlertCircle } from 'lucide-react';
import type { Product, Category, AddonGroup } from '@/lib/types';
import TagBadge, { tagLabel } from '@/components/pos/DietaryBadge';
import ImageUploader from '@/components/products/ImageUploader';
import { getCurrencySymbol } from '@/lib/countries';
import { useConfirm } from '@/hooks/use-confirm';
import { nameToColor } from '@/lib/image-utils';

const PRESET_TAGS = [
  { key: 'veg', label: 'Veg' },
  { key: 'non_veg', label: 'Non-Veg' },
  { key: 'vegan', label: 'Vegan' },
  { key: 'egg', label: 'Egg' },
  { key: 'spicy', label: 'Spicy' },
  { key: 'contains_nuts', label: 'Contains Nuts' },
  { key: 'gluten_free', label: 'Gluten-Free' },
  { key: 'dairy_free', label: 'Dairy-Free' },
  { key: 'new_arrival', label: 'New Arrival' },
  { key: 'bestseller', label: 'Bestseller' },
  { key: 'organic', label: 'Organic' },
  { key: 'fragrance_free', label: 'Fragrance-Free' },
  { key: 'limited', label: 'Limited' },
];

const CATEGORY_COLORS = [
  { key: '', label: 'None', bg: 'bg-gray-100', text: 'text-gray-600' },
  { key: 'red', label: 'Red', bg: 'bg-red-100', text: 'text-red-700' },
  { key: 'orange', label: 'Orange', bg: 'bg-orange-100', text: 'text-orange-700' },
  { key: 'amber', label: 'Amber', bg: 'bg-amber-100', text: 'text-amber-700' },
  { key: 'yellow', label: 'Yellow', bg: 'bg-yellow-100', text: 'text-yellow-700' },
  { key: 'lime', label: 'Lime', bg: 'bg-lime-100', text: 'text-lime-700' },
  { key: 'green', label: 'Green', bg: 'bg-green-100', text: 'text-green-700' },
  { key: 'emerald', label: 'Emerald', bg: 'bg-emerald-100', text: 'text-emerald-700' },
  { key: 'teal', label: 'Teal', bg: 'bg-teal-100', text: 'text-teal-700' },
  { key: 'cyan', label: 'Cyan', bg: 'bg-cyan-100', text: 'text-cyan-700' },
  { key: 'sky', label: 'Sky', bg: 'bg-sky-100', text: 'text-sky-700' },
  { key: 'blue', label: 'Blue', bg: 'bg-blue-100', text: 'text-blue-700' },
  { key: 'indigo', label: 'Indigo', bg: 'bg-indigo-100', text: 'text-indigo-700' },
  { key: 'violet', label: 'Violet', bg: 'bg-violet-100', text: 'text-violet-700' },
  { key: 'purple', label: 'Purple', bg: 'bg-purple-100', text: 'text-purple-700' },
  { key: 'fuchsia', label: 'Fuchsia', bg: 'bg-fuchsia-100', text: 'text-fuchsia-700' },
  { key: 'pink', label: 'Pink', bg: 'bg-pink-100', text: 'text-pink-700' },
  { key: 'rose', label: 'Rose', bg: 'bg-rose-100', text: 'text-rose-700' },
];

type TabType = 'products' | 'categories' | 'addons';

export default function ProductsPage() {
  const { currentTenant } = useAuthStore();
  const [activeTab, setActiveTab] = useState<TabType>('products');
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [addonGroups, setAddonGroups] = useState<AddonGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const { confirm, ConfirmDialog } = useConfirm();
  const [editingAddonGroup, setEditingAddonGroup] = useState<AddonGroup | null>(null);
  const [categoryForm, setCategoryForm] = useState({ name: '', description: '', color: '', is_active: true });
  const [addonForm, setAddonForm] = useState({ name: '', description: '', is_required: false, min_selection: 0, max_selection: 10 });
  const [showAddonModal, setShowAddonModal] = useState(false);
  const [editingAddon, setEditingAddon] = useState<{ id?: number; name: string; price: string } | null>(null);
  const [addonList, setAddonList] = useState<{ id?: number; name: string; price: number }[]>([]);
  const [form, setForm] = useState({
    name: '', category_id: '', price: '', cost_price: '', cb_percent: '0', sku: '',
    tax_type: 'inclusive', tax_rate: '5', description: '',
    track_inventory: false, stock_quantity: '0', is_active: true,
    tags: [] as string[],
    customTag: '',
    addon_group_ids: [] as number[],
    image_url: null as string | null,
  });
  const [imageTouched, setImageTouched] = useState(false);

  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvType, setCsvType] = useState<'categories' | 'products' | 'addons'>('categories');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvResult, setCsvResult] = useState<Record<string, unknown> | null>(null);
  const [csvUploading, setCsvUploading] = useState(false);
  const [catDeleteModal, setCatDeleteModal] = useState<{ open: boolean; id: number | null; name: string; productCount: number }>({ open: false, id: null, name: '', productCount: 0 });
  const [catReassignTo, setCatReassignTo] = useState<string>('');

  const currency = getCurrencySymbol(currentTenant?.currency || 'INR');
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const isOwnerOrManager = currentTenant?.role === 'owner' || currentTenant?.role === 'manager';

  const fetchData = async () => {
    try {
      const requests: Promise<{ data: Record<string, unknown> }>[] = [
        api.get('/products'),
        api.get('/categories'),
      ];
      if (isRestaurant) requests.push(api.get('/addon-groups'));
      const [prodRes, catRes, agRes] = await Promise.all(requests);
      setProducts((prodRes.data.products as Product[]) || []);
      setCategories((catRes.data.categories as Category[]) || []);
      if (agRes) setAddonGroups((agRes.data.addon_groups as AddonGroup[]) || []);
    } catch {
      toast.error('Failed to load products');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const openCsvModal = (type: 'categories' | 'products' | 'addons') => {
    setCsvType(type);
    setCsvFile(null);
    setCsvResult(null);
    setShowCsvModal(true);
  };

  const downloadCsv = async (path: string, filename: string) => {
    try {
      const res = await api.get(path, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Download failed');
    }
  };

  const handleCsvUpload = async () => {
    if (!csvFile) return;
    setCsvUploading(true);
    setCsvResult(null);
    try {
      const text = await csvFile.text();
      const res = await api.post(`/menu-csv/import/${csvType}`, { csv: text });
      setCsvResult(res.data);
      fetchData();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Import failed';
      toast.error(msg);
    } finally {
      setCsvUploading(false);
    }
  };

  const resetForm = () => {
    setForm({
      name: '', category_id: '', price: '', cost_price: '', cb_percent: '0', sku: '',
      tax_type: 'inclusive', tax_rate: '5', description: '',
      track_inventory: false, stock_quantity: '0', is_active: true,
      tags: [], customTag: '', addon_group_ids: [], image_url: null,
    });
    setImageTouched(false);
    setEditingProduct(null);
    setShowForm(false);
  };

  const openEdit = (product: Product) => {
    setEditingProduct(product);
    setForm({
      name: product.name,
      category_id: product.category_id != null ? String(product.category_id) : '',
      price: String(product.price),
      cost_price: String(product.cost_price || ''),
      cb_percent: String(product.cb_percent ?? 0),
      sku: product.sku || '',
      tax_type: product.tax_type || 'inclusive',
      tax_rate: String(product.tax_rate || '5'),
      description: product.description || '',
      track_inventory: product.track_inventory,
      stock_quantity: String(product.stock_quantity || '0'),
      is_active: product.is_active,
      tags: product.tags || [],
      customTag: '',
      addon_group_ids: product.addon_groups?.map((g) => g.id) || [],
      image_url: product.has_image ? 'EXISTING' : null,
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        category_id: form.category_id || null,
        price: Number(form.price),
        cost_price: form.cost_price ? Number(form.cost_price) : null,
        cb_percent: Number(form.cb_percent) || 0,
        sku: form.sku || null,
        tax_type: form.tax_type,
        tax_rate: Number(form.tax_rate),
        description: form.description || null,
        track_inventory: form.track_inventory,
        stock_quantity: Number(form.stock_quantity),
        is_active: form.is_active,
        tags: form.tags.length > 0 ? form.tags : null,
        addon_group_ids: form.addon_group_ids,
      };

      // Only include image_url when the user actually touched the image field
      // (avoids sending 50KB payloads when the image wasn't changed)
      if (imageTouched) {
        payload.image_url = form.image_url; // Can be a data URI or null (to clear)
      }

      if (editingProduct) {
        await api.put(`/products/${editingProduct.id}`, payload);
        toast.success('Product updated');
      } else {
        await api.post('/products', payload);
        toast.success('Product created');
      }
      resetForm();
      fetchData();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { errors?: Record<string, string[]> } } };
      const firstError = error.response?.data?.errors
        ? Object.values(error.response.data.errors)[0]?.[0]
        : 'Failed to save product';
      toast.error(firstError);
    }
  };

  const handleDelete = async (id: number) => {
    if (!await confirm('Delete this product?', { destructive: true, confirmLabel: 'Delete' })) return;
    try {
      await api.delete(`/products/${id}`);
      toast.success('Product deleted');
      fetchData();
    } catch {
      toast.error('Failed to delete');
    }
  };

  const resetCategoryForm = () => {
    setCategoryForm({ name: '', description: '', color: '', is_active: true });
    setEditingCategory(null);
    setShowForm(false);
  };

  const openEditCategory = (cat: Category) => {
    setEditingCategory(cat);
    setCategoryForm({ name: cat.name, description: cat.description || '', color: cat.color || '', is_active: cat.is_active });
    setShowForm(true);
  };

  const handleCategorySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = { name: categoryForm.name, description: categoryForm.description || null, color: categoryForm.color || null, is_active: categoryForm.is_active };
      if (editingCategory) {
        await api.put(`/categories/${editingCategory.id}`, payload);
        toast.success('Category updated');
      } else {
        await api.post('/categories', payload);
        toast.success('Category created');
      }
      resetCategoryForm();
      fetchData();
    } catch { toast.error('Failed to save category'); }
  };

  const handleCategoryDelete = async (id: number, name: string) => {
    try {
      await api.delete(`/categories/${id}`);
      toast.success('Category deleted');
      fetchData();
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string; productCount?: number } } };
      if (e?.response?.status === 400 && e?.response?.data?.productCount) {
        setCatReassignTo('');
        setCatDeleteModal({ open: true, id, name, productCount: e.response.data.productCount });
      } else {
        toast.error(e?.response?.data?.error || 'Failed to delete');
      }
    }
  };

  const handleCategoryReassignDelete = async () => {
    if (!catDeleteModal.id || !catReassignTo) return;
    try {
      await api.delete(`/categories/${catDeleteModal.id}?action=reassign&reassign_to=${catReassignTo}`);
      toast.success('Products reassigned and category deleted');
      setCatDeleteModal({ open: false, id: null, name: '', productCount: 0 });
      fetchData();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error || 'Failed to delete');
    }
  };

  const handleCategoryForceDelete = async () => {
    if (!catDeleteModal.id) return;
    try {
      await api.delete(`/categories/${catDeleteModal.id}?action=delete_all`);
      toast.success('Category and all products deleted');
      setCatDeleteModal({ open: false, id: null, name: '', productCount: 0 });
      fetchData();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error || 'Failed to delete');
    }
  };

  const resetAddonForm = () => {
    setAddonForm({ name: '', description: '', is_required: false, min_selection: 0, max_selection: 10 });
    setEditingAddonGroup(null);
    setShowAddonModal(false);
    setAddonList([]);
  };

  const openEditAddonGroup = (group: AddonGroup) => {
    setEditingAddonGroup(group);
    setAddonForm({ name: group.name, description: group.description || '', is_required: group.is_required, min_selection: group.min_selection, max_selection: group.max_selection });
    setAddonList(group.addons?.map((a) => ({ id: a.id, name: a.name, price: a.price })) || []);
    setShowAddonModal(true);
  };

  const handleAddonGroupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = { name: addonForm.name, description: addonForm.description || null, is_required: addonForm.is_required, min_selection: addonForm.min_selection, max_selection: addonForm.max_selection, addons: addonList };
      if (editingAddonGroup) {
        await api.put(`/addon-groups/${editingAddonGroup.id}`, payload);
        toast.success('Addon group updated');
      } else {
        await api.post('/addon-groups', payload);
        toast.success('Addon group created');
      }
      resetAddonForm();
      fetchData();
    } catch { toast.error('Failed to save addon group'); }
  };

  const handleAddonGroupDelete = async (id: number) => {
    if (!await confirm('Delete this addon group?', { destructive: true, confirmLabel: 'Delete' })) return;
    try {
      await api.delete(`/addon-groups/${id}`);
      toast.success('Addon group deleted');
      fetchData();
    } catch { toast.error('Failed to delete'); }
  };

  const addAddonItem = () => setAddonList((prev) => [...prev, { name: '', price: 0 }]);
  const updateAddonItem = (idx: number, field: string, value: string | number) => setAddonList((prev) => prev.map((a, i) => i === idx ? { ...a, [field]: value } : a));
  const removeAddonItem = (idx: number) => setAddonList((prev) => prev.filter((_, i) => i !== idx));

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Products</h1>
      </div>

      <div className="flex gap-1 mb-6 border-b">
        <button onClick={() => setActiveTab('products')} className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === 'products' ? 'border-brand text-brand' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          <Package size={16} /> Products
        </button>
        <button onClick={() => setActiveTab('categories')} className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === 'categories' ? 'border-brand text-brand' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          <Folder size={16} /> Categories
        </button>
        {isRestaurant && (
          <button onClick={() => setActiveTab('addons')} className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === 'addons' ? 'border-brand text-brand' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <Puzzle size={16} /> Addon Groups
          </button>
        )}
      </div>

      {activeTab === 'products' && (
        <>
          <div className="flex justify-end gap-2 mb-4">
            <Button variant="outline" onClick={() => openCsvModal('products')}>
              <FileSpreadsheet size={16} className="mr-1" /> CSV
            </Button>
            <Button onClick={() => { resetForm(); setShowForm(true); }}>
              <Plus size={16} className="mr-1" /> Add Product
            </Button>
          </div>

      {/* Product Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">Product</th>
              <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">Category</th>
              <th className="text-right p-4 text-xs font-medium text-gray-500 uppercase">Price</th>
              <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">Tax</th>
              <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">Stock</th>
              <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="text-right p-4 text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {products.map((product) => {
              const taxLabel = product.tax_type === 'none' || !product.tax_type
                ? '—'
                : `${product.tax_type === 'inclusive' ? 'Incl.' : 'Excl.'} ${product.tax_rate}%`;
              return (
              <tr key={product.id} className="hover:bg-gray-50">
                <td className="p-4 max-w-[220px]">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 relative flex items-center justify-center">
                      <div
                        className="absolute inset-0 flex items-center justify-center"
                        style={{ backgroundColor: nameToColor(product.name) }}
                      >
                        <span className="text-sm font-bold text-white/80">
                          {product.name.substring(0, 2).toUpperCase()}
                        </span>
                      </div>
                      {product.has_image && (
                        <img 
                          src={`${api.defaults.baseURL}/products/${product.id}/image?t=${product.updated_at ? new Date(product.updated_at).getTime() : 0}`}
                          alt="" 
                          className="absolute inset-0 w-full h-full object-cover"
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        />
                      )}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{product.name}</p>
                      {product.sku && <p className="text-xs text-gray-400 mt-0.5">SKU: {product.sku}</p>}
                      {product.tags && product.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {product.tags.map((tag: string) => <TagBadge key={tag} tag={tag} />)}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="p-4 text-sm text-gray-600">{product.category?.name || '—'}</td>
                <td className="p-4 text-right">
                  <p className="font-medium">{currency}{Number(product.price).toLocaleString()}</p>
                  {product.cost_price != null && product.cost_price > 0 && <p className="text-xs text-gray-400">Cost: {currency}{Number(product.cost_price).toLocaleString()}</p>}
                </td>
                <td className="p-4 text-sm text-gray-600">{taxLabel}</td>
                <td className="p-4 text-center">
                  {product.track_inventory ? (
                    <span className={`text-sm font-medium ${product.stock_quantity <= (product.low_stock_threshold || 0) ? 'text-red-600' : 'text-gray-900'}`}>
                      {product.stock_quantity}
                    </span>
                  ) : (
                    <span className="text-gray-400 text-sm">—</span>
                  )}
                </td>
                <td className="p-4 text-center">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                    product.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {product.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="p-4 text-right">
                  <div className="flex gap-2 justify-end">
                    {isOwnerOrManager && (
                      <>
                        <button onClick={() => openEdit(product)} className="p-1.5 text-gray-400 hover:text-brand">
                          <Pencil size={16} />
                        </button>
                        <button onClick={() => handleDelete(product.id)} className="p-1.5 text-gray-400 hover:text-red-600">
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {products.length === 0 && (
          <p className="text-center text-gray-500 py-12">No products yet. Add your first product!</p>
        )}
      </div>

      {/* Product Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{editingProduct ? 'Edit Product' : 'Add Product'}</h2>
              <button onClick={resetForm} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Product Image</label>
                <ImageUploader
                  value={form.image_url}
                  onChange={(val) => {
                    setForm({ ...form, image_url: val });
                    setImageTouched(true);
                  }}
                  productId={editingProduct?.id ? String(editingProduct.id) : undefined}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required>
                    <option value="">Select</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">SKU</label>
                  <input type="text" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Price ({currency})</label>
                  <input type="number" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Cost Price</label>
                  <input type="number" step="0.01" value={form.cost_price} onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cashback %</label>
                <input type="number" step="0.1" min="0" max="100" value={form.cb_percent} onChange={(e) => setForm({ ...form, cb_percent: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                <p className="text-xs text-gray-400 mt-1">% of item price added to customer&apos;s loyalty wallet</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tax Type</label>
                  <select value={form.tax_type} onChange={(e) => setForm({ ...form, tax_type: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none">
                    <option value="none">No Tax</option>
                    <option value="inclusive">Inclusive</option>
                    <option value="exclusive">Exclusive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tax Rate (%)</label>
                  <input type="number" step="0.01" value={form.tax_rate} onChange={(e) => setForm({ ...form, tax_rate: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Tags</label>
                {/* Selected tags */}
                {form.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {form.tags.map((tag) => (
                      <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 bg-brand/10 text-brand rounded-lg text-xs font-medium">
                        {tagLabel(tag)}
                        <button type="button" onClick={() => setForm((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }))} className="hover:text-red-500">
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {/* Preset tag chips */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {PRESET_TAGS.filter((pt) => !form.tags.includes(pt.key)).map((pt) => (
                    <button
                      key={pt.key}
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, tags: [...prev.tags, pt.key] }))}
                      className="px-2 py-1 text-xs border border-gray-200 rounded-lg text-gray-600 hover:border-brand hover:text-brand transition-colors"
                    >
                      + {pt.label}
                    </button>
                  ))}
                </div>
                {/* Custom tag input */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={form.customTag}
                    onChange={(e) => setForm((prev) => ({ ...prev, customTag: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        const val = form.customTag.trim().toLowerCase().replace(/\s+/g, '_');
                        if (val && !form.tags.includes(val)) {
                          setForm((prev) => ({ ...prev, tags: [...prev.tags, val], customTag: '' }));
                        }
                      }
                    }}
                    placeholder="Type custom tag + Enter"
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const val = form.customTag.trim().toLowerCase().replace(/\s+/g, '_');
                      if (val && !form.tags.includes(val)) {
                        setForm((prev) => ({ ...prev, tags: [...prev.tags, val], customTag: '' }));
                      }
                    }}
                    className="px-3 py-1.5 text-sm bg-gray-100 rounded-lg hover:bg-gray-200 text-gray-600"
                  >
                    Add
                  </button>
                </div>
              </div>
              {isRestaurant && addonGroups.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Addon Groups</label>
                  <div className="space-y-2 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-3">
                    {addonGroups.map((group) => {
                      const isChecked = form.addon_group_ids.includes(group.id);
                      return (
                        <div key={group.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            id={`addon-group-${group.id}`}
                            checked={isChecked}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setForm((prev) => ({
                                ...prev,
                                addon_group_ids: checked
                                  ? [...prev.addon_group_ids, group.id]
                                  : prev.addon_group_ids.filter((id) => id !== group.id),
                              }));
                            }}
                            className="rounded border-gray-300 text-brand focus:ring-brand"
                          />
                          <label htmlFor={`addon-group-${group.id}`} className="flex items-center gap-2 cursor-pointer select-none">
                            <span className="text-sm text-gray-700">{group.name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${group.is_required ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                              {group.is_required ? 'Required' : 'Optional'}
                            </span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.track_inventory} onChange={(e) => setForm({ ...form, track_inventory: e.target.checked })}
                    className="rounded border-gray-300 text-brand focus:ring-brand" />
                  <span className="text-sm text-gray-700">Track inventory</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                    className="rounded border-gray-300 text-brand focus:ring-brand" />
                  <span className="text-sm text-gray-700">Active</span>
                </label>
              </div>
              <Button type="submit" className="w-full">
                {editingProduct ? 'Update Product' : 'Create Product'}
              </Button>
            </form>
          </div>
        </div>
      )}
        </>
      )}

      {activeTab === 'categories' && (
        <>
          <div className="flex justify-end gap-2 mb-4">
            <Button variant="outline" onClick={() => openCsvModal('categories')}>
              <FileSpreadsheet size={16} className="mr-1" /> CSV
            </Button>
            <Button onClick={() => { resetCategoryForm(); setShowForm(true); }}>
              <Plus size={16} className="mr-1" /> Add Category
            </Button>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">Name</th>
                  <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">Color</th>
                  <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="text-right p-4 text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {categories.map((cat) => {
                  const colorObj = CATEGORY_COLORS.find((c) => c.key === cat.color);
                  return (
                    <tr key={cat.id} className="hover:bg-gray-50">
                      <td className="p-4 font-medium text-gray-900">{cat.name}</td>
                      <td className="p-4">
                        {colorObj ? (
                          <span className={`inline-flex px-2 py-1 rounded-lg text-xs font-medium ${colorObj.bg} ${colorObj.text}`}>{colorObj.label}</span>
                        ) : <span className="text-gray-400 text-sm">—</span>}
                      </td>
                      <td className="p-4 text-center">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${cat.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                          {cat.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <div className="flex gap-2 justify-end">
                          {isOwnerOrManager && (
                            <>
                              <button onClick={() => openEditCategory(cat)} className="p-1.5 text-gray-400 hover:text-brand"><Pencil size={16} /></button>
                              <button onClick={() => handleCategoryDelete(cat.id, cat.name)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={16} /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {categories.length === 0 && <p className="text-center text-gray-500 py-12">No categories yet. Add your first category!</p>}
          </div>

          {showForm && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="bg-white rounded-2xl p-6 w-full max-w-md">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-lg font-bold">{editingCategory ? 'Edit Category' : 'Add Category'}</h2>
                  <button onClick={resetCategoryForm} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
                </div>
                <form onSubmit={handleCategorySubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                    <input type="text" value={categoryForm.name} onChange={(e) => setCategoryForm({ ...categoryForm, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                    <textarea value={categoryForm.description} onChange={(e) => setCategoryForm({ ...categoryForm, description: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" rows={2} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Color</label>
                    <div className="flex flex-wrap gap-2">
                      {CATEGORY_COLORS.map((c) => (
                        <button type="button" key={c.key} onClick={() => setCategoryForm({ ...categoryForm, color: c.key })} className={`px-3 py-1.5 rounded-lg text-xs font-medium border-2 ${c.key === categoryForm.color ? 'border-brand' : 'border-transparent'} ${c.bg} ${c.text}`}>{c.label}</button>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={categoryForm.is_active} onChange={(e) => setCategoryForm({ ...categoryForm, is_active: e.target.checked })} className="rounded border-gray-300 text-brand focus:ring-brand" />
                    <span className="text-sm text-gray-700">Active</span>
                  </label>
                  <Button type="submit" className="w-full">{editingCategory ? 'Update' : 'Create'}</Button>
                </form>
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'addons' && isRestaurant && (
        <>
          <div className="flex justify-end gap-2 mb-4">
            <Button variant="outline" onClick={() => openCsvModal('addons')}>
              <FileSpreadsheet size={16} className="mr-1" /> CSV
            </Button>
            <Button onClick={() => { resetAddonForm(); setShowAddonModal(true); }}>
              <Plus size={16} className="mr-1" /> Add Addon Group
            </Button>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">Name</th>
                  <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">Required</th>
                  <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">Selection</th>
                  <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">Addons</th>
                  <th className="text-right p-4 text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {addonGroups.map((group) => (
                  <tr key={group.id} className="hover:bg-gray-50">
                    <td className="p-4 font-medium text-gray-900">{group.name}</td>
                    <td className="p-4 text-center">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${group.is_required ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{group.is_required ? 'Yes' : 'No'}</span>
                    </td>
                    <td className="p-4 text-center text-sm text-gray-600">{group.min_selection} - {group.max_selection}</td>
                    <td className="p-4 text-center text-sm text-gray-600">{group.addons?.length || 0}</td>
                    <td className="p-4 text-right">
                      <div className="flex gap-2 justify-end">
                        {isOwnerOrManager && (
                          <>
                            <button onClick={() => openEditAddonGroup(group)} className="p-1.5 text-gray-400 hover:text-brand"><Pencil size={16} /></button>
                            <button onClick={() => handleAddonGroupDelete(group.id)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={16} /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {addonGroups.length === 0 && <p className="text-center text-gray-500 py-12">No addon groups yet.</p>}
          </div>

          {showAddonModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-lg font-bold">{editingAddonGroup ? 'Edit Addon Group' : 'Add Addon Group'}</h2>
                  <button onClick={resetAddonForm} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
                </div>
                <form onSubmit={handleAddonGroupSubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                    <input type="text" value={addonForm.name} onChange={(e) => setAddonForm({ ...addonForm, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                    <input type="text" value={addonForm.description} onChange={(e) => setAddonForm({ ...addonForm, description: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Min Selection</label>
                      <input type="number" min="0" value={addonForm.min_selection} onChange={(e) => setAddonForm({ ...addonForm, min_selection: Number(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Max Selection</label>
                      <input type="number" min="0" value={addonForm.max_selection} onChange={(e) => setAddonForm({ ...addonForm, max_selection: Number(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={addonForm.is_required} onChange={(e) => setAddonForm({ ...addonForm, is_required: e.target.checked })} className="rounded border-gray-300 text-brand focus:ring-brand" />
                    <span className="text-sm text-gray-700">Required</span>
                  </label>
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <label className="block text-sm font-medium text-gray-700">Addons</label>
                      <button type="button" onClick={addAddonItem} className="text-xs text-brand hover:underline">+ Add Addon</button>
                    </div>
                    <div className="space-y-2">
                      {addonList.map((addon, idx) => (
                        <div key={idx} className="flex gap-2">
                          <input type="text" value={addon.name} onChange={(e) => updateAddonItem(idx, 'name', e.target.value)} placeholder="Name" className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                          <input type="number" step="0.01" value={addon.price} onChange={(e) => updateAddonItem(idx, 'price', Number(e.target.value))} placeholder="Price" className="w-24 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                          <button type="button" onClick={() => removeAddonItem(idx)} className="text-gray-400 hover:text-red-500"><X size={16} /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <Button type="submit" className="w-full">{editingAddonGroup ? 'Update' : 'Create'}</Button>
                </form>
              </div>
            </div>
          )}
        </>
      )}

      {showCsvModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg">
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-lg font-bold">
                CSV Import / Export —{' '}
                {csvType === 'categories' ? 'Categories' : csvType === 'products' ? 'Products' : 'Addon Groups'}
              </h2>
              <button onClick={() => setShowCsvModal(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-5">
              {/* Download section */}
              <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                <p className="text-sm font-medium text-gray-700">Download</p>
                <div className="flex gap-3">
                  <button
                    onClick={() => downloadCsv(`/menu-csv/template/${csvType}`, `${csvType}-template.csv`)}
                    className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 font-medium"
                  >
                    <Download size={14} /> Blank template
                  </button>
                  <button
                    onClick={() => downloadCsv(`/menu-csv/export/${csvType}`, `${csvType}-export.csv`)}
                    className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 font-medium"
                  >
                    <Download size={14} /> Current data
                  </button>
                </div>
                {csvType === 'products' && (
                  <p className="text-xs text-gray-500">Columns: id (leave blank for new items), sku, name, category, price, description, cost, tax_type (none/inclusive/exclusive), tax_rate, cashback_percent, tags (veg/non_veg/...), is_active (yes/no) — download &quot;Current data&quot; to get item IDs, edit, then re-upload to update existing items</p>
                )}
                {csvType === 'categories' && (
                  <p className="text-xs text-gray-500">Columns: name, description, color (red/green/blue/...), icon (emoji), sort_order</p>
                )}
                {csvType === 'addons' && (
                  <p className="text-xs text-gray-500">Columns: group_name, addon_name, price, group_required (yes/no), group_min_select, group_max_select — group settings are read from the first row with that group name</p>
                )}
              </div>

              {/* Upload section */}
              <div className="space-y-3">
                <p className="text-sm font-medium text-gray-700">Upload CSV</p>
                <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-gray-200 rounded-xl cursor-pointer hover:bg-gray-50 transition-colors">
                  <Upload size={20} className="text-gray-400 mb-1" />
                  <span className="text-sm text-gray-500">
                    {csvFile ? csvFile.name : 'Click to choose a CSV file'}
                  </span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => { setCsvFile(e.target.files?.[0] ?? null); setCsvResult(null); }}
                  />
                </label>
                {csvFile && (
                  <Button onClick={handleCsvUpload} disabled={csvUploading} className="w-full">
                    {csvUploading ? 'Importing…' : 'Import'}
                  </Button>
                )}
              </div>

              {/* Result */}
              {csvResult && (
                <div className="rounded-xl border border-gray-100 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border-b border-gray-100">
                    <CheckCircle size={15} className="text-green-600" />
                    <span className="text-sm font-medium text-green-800">Import complete</span>
                  </div>
                  <div className="px-4 py-3 text-sm text-gray-700 space-y-1">
                    {csvType === 'addons' ? (
                      <>
                        <p>Groups created: <span className="font-medium">{String(csvResult.groups_created ?? 0)}</span></p>
                        <p>Addons created: <span className="font-medium">{String(csvResult.addons_created ?? 0)}</span></p>
                      </>
                    ) : (
                      <p>Created: <span className="font-medium">{String(csvResult.created ?? 0)}</span></p>
                    )}
                    <p>Skipped (already exists): <span className="font-medium">{String(csvResult.skipped ?? 0)}</span></p>
                  </div>
                  {Array.isArray(csvResult.warnings) && (csvResult.warnings as string[]).length > 0 && (
                    <div className="px-4 py-3 border-t border-gray-100 bg-amber-50">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertCircle size={14} className="text-amber-500" />
                        <span className="text-xs font-medium text-amber-700">Some rows had missing fields — imported with defaults</span>
                      </div>
                      <ul className="space-y-1">
                        {(csvResult.warnings as string[]).map((w, i) => (
                          <li key={i} className="text-xs text-amber-800">{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Array.isArray(csvResult.errors) && (csvResult.errors as string[]).length > 0 && (
                    <div className="px-4 py-3 border-t border-gray-100">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertCircle size={14} className="text-red-500" />
                        <span className="text-xs font-medium text-red-700">Rows skipped due to errors</span>
                      </div>
                      <ul className="space-y-1">
                        {(csvResult.errors as string[]).map((e, i) => (
                          <li key={i} className="text-xs text-gray-600">{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {catDeleteModal.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">Delete Category</h2>
              <button onClick={() => setCatDeleteModal({ open: false, id: null, name: '', productCount: 0 })} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <p className="text-sm text-gray-700 mb-5">
              <span className="font-semibold">&ldquo;{catDeleteModal.name}&rdquo;</span> has{' '}
              <span className="font-semibold text-amber-600">{catDeleteModal.productCount} active product(s)</span>.{' '}
              What would you like to do with them?
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Move products to</label>
                <select
                  value={catReassignTo}
                  onChange={(e) => setCatReassignTo(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none"
                >
                  <option value="">Select a category…</option>
                  {categories
                    .filter((c) => c.name.toLowerCase() === 'uncategorized' && c.id !== catDeleteModal.id)
                    .map((c) => <option key={c.id} value={String(c.id)}>{c.name} (default)</option>)}
                  {categories
                    .filter((c) => c.name.toLowerCase() !== 'uncategorized' && c.id !== catDeleteModal.id)
                    .map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                </select>
              </div>
              <Button onClick={handleCategoryReassignDelete} disabled={!catReassignTo} className="w-full">
                Move &amp; Delete Category
              </Button>
              <div className="relative flex items-center">
                <div className="flex-grow border-t border-gray-200" />
                <span className="mx-3 text-xs text-gray-400">or</span>
                <div className="flex-grow border-t border-gray-200" />
              </div>
              <button
                onClick={handleCategoryForceDelete}
                className="w-full px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
              >
                Delete Category &amp; All Products
              </button>
            </div>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}
