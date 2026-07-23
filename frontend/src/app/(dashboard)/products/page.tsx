'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, X, Package, Folder, Puzzle, FileSpreadsheet, Download, Upload, CheckCircle, AlertCircle, AlertTriangle } from 'lucide-react';
import type { Product, Category, AddonGroup } from '@/lib/types';
import TagBadge, { tagLabel } from '@/components/pos/DietaryBadge';
import ImageUploader from '@/components/products/ImageUploader';
import { getCurrencySymbol, getCountryByCode } from '@/lib/countries';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useConfirm } from '@/hooks/use-confirm';
import { nameToColor } from '@/lib/image-utils';
import { useI18n } from '@/hooks/useI18n';

const PRESET_TAGS = [
  { key: 'veg', labelKey: 'pos.tagVeg' },
  { key: 'non_veg', labelKey: 'pos.tagNonVeg' },
  { key: 'vegan', labelKey: 'pos.tagVegan' },
  { key: 'egg', labelKey: 'pos.tagEgg' },
  { key: 'spicy', labelKey: 'pos.tagSpicy' },
  { key: 'contains_nuts', labelKey: 'pos.tagContainsNuts' },
  { key: 'gluten_free', labelKey: 'pos.tagGlutenFree' },
  { key: 'dairy_free', labelKey: 'pos.tagDairyFree' },
  { key: 'new_arrival', labelKey: 'pos.tagNewArrival' },
  { key: 'bestseller', labelKey: 'pos.tagBestseller' },
  { key: 'organic', labelKey: 'pos.tagOrganic' },
  { key: 'fragrance_free', labelKey: 'pos.tagFragranceFree' },
  { key: 'limited', labelKey: 'pos.tagLimited' },
];

const CATEGORY_COLORS = [
  { key: '', labelKey: 'products.colorNone', bg: 'bg-gray-100', text: 'text-gray-600' },
  { key: 'red', labelKey: 'products.colorRed', bg: 'bg-red-100', text: 'text-red-700' },
  { key: 'orange', labelKey: 'products.colorOrange', bg: 'bg-orange-100', text: 'text-orange-700' },
  { key: 'amber', labelKey: 'products.colorAmber', bg: 'bg-amber-100', text: 'text-amber-700' },
  { key: 'yellow', labelKey: 'products.colorYellow', bg: 'bg-yellow-100', text: 'text-yellow-700' },
  { key: 'lime', labelKey: 'products.colorLime', bg: 'bg-lime-100', text: 'text-lime-700' },
  { key: 'green', labelKey: 'products.colorGreen', bg: 'bg-green-100', text: 'text-green-700' },
  { key: 'emerald', labelKey: 'products.colorEmerald', bg: 'bg-emerald-100', text: 'text-emerald-700' },
  { key: 'teal', labelKey: 'products.colorTeal', bg: 'bg-teal-100', text: 'text-teal-700' },
  { key: 'cyan', labelKey: 'products.colorCyan', bg: 'bg-cyan-100', text: 'text-cyan-700' },
  { key: 'sky', labelKey: 'products.colorSky', bg: 'bg-sky-100', text: 'text-sky-700' },
  { key: 'blue', labelKey: 'products.colorBlue', bg: 'bg-blue-100', text: 'text-blue-700' },
  { key: 'indigo', labelKey: 'products.colorIndigo', bg: 'bg-indigo-100', text: 'text-indigo-700' },
  { key: 'violet', labelKey: 'products.colorViolet', bg: 'bg-violet-100', text: 'text-violet-700' },
  { key: 'purple', labelKey: 'products.colorPurple', bg: 'bg-purple-100', text: 'text-purple-700' },
  { key: 'fuchsia', labelKey: 'products.colorFuchsia', bg: 'bg-fuchsia-100', text: 'text-fuchsia-700' },
  { key: 'pink', labelKey: 'products.colorPink', bg: 'bg-pink-100', text: 'text-pink-700' },
  { key: 'rose', labelKey: 'products.colorRose', bg: 'bg-rose-100', text: 'text-rose-700' },
];

type TabType = 'products' | 'categories' | 'addons';

export default function ProductsPage() {
  const { t } = useI18n();
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
  const [addonForm, setAddonForm] = useState({ name: '', description: '', is_required: false, allow_multiple_quantities: false, min_selection: 0, max_selection: 10 });
  const [showAddonModal, setShowAddonModal] = useState(false);

  const [addonList, setAddonList] = useState<{ id?: number | string; name: string; price: number; is_active?: boolean }[]>([]);
  const [form, setForm] = useState({
    name: '', category_id: '', price: '', cost_price: '', cb_percent: '0', sku: '', barcode: '',
    tax_type: 'inclusive', tax_rate: '5', description: '',
    track_inventory: false, stock_quantity: '0', low_stock_threshold: '5', is_active: true,
    tags: [] as string[],
    customTag: '',
    addon_group_ids: [] as (number | string)[],
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

  const currency = getCurrencySymbol(currentTenant?.currency || 'INR', getCountryByCode(currentTenant?.country ?? 'IN')?.locale);
  const fmt = useFormatCurrency();
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
      toast.error(t('products.failedToLoad'));
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      toast.error(t('common.downloadFailed'));
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
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('common.importFailed');
      toast.error(msg);
    } finally {
      setCsvUploading(false);
    }
  };

  const resetForm = () => {
    setForm({
      name: '', category_id: '', price: '', cost_price: '', cb_percent: '0', sku: '', barcode: '',
      tax_type: 'inclusive', tax_rate: '5', description: '',
      track_inventory: false, stock_quantity: '0', low_stock_threshold: '5', is_active: true,
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
      barcode: product.barcode || '',
      tax_type: product.tax_type || 'inclusive',
      tax_rate: String(product.tax_rate || '5'),
      description: product.description || '',
      track_inventory: product.track_inventory,
      stock_quantity: String(product.stock_quantity || '0'),
      low_stock_threshold: String(product.low_stock_threshold ?? '5'),
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
        barcode: form.barcode || null,
        tax_type: form.tax_type,
        tax_rate: Number(form.tax_rate),
        description: form.description || null,
        track_inventory: form.track_inventory,
        stock_quantity: Number(form.stock_quantity),
        low_stock_threshold: Number(form.low_stock_threshold),
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
        toast.success(t('products.updated'));
      } else {
        await api.post('/products', payload);
        toast.success(t('products.created'));
      }
      resetForm();
      fetchData();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { errors?: Record<string, string[]>; error?: string } } };
      const firstError = error.response?.data?.errors
        ? Object.values(error.response.data.errors)[0]?.[0]
        : error.response?.data?.error || t('products.failedToSave');
      toast.error(firstError);
    }
  };

  const handleDelete = async (id: number) => {
    if (!await confirm(t('products.deleteConfirm'), { destructive: true, confirmLabel: t('common.delete') })) return;
    try {
      await api.delete(`/products/${id}`);
      toast.success(t('products.deleted'));
      fetchData();
    } catch {
      toast.error(t('common.failedToDelete'));
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
        toast.success(t('products.categoryUpdated'));
      } else {
        await api.post('/categories', payload);
        toast.success(t('products.categoryCreated'));
      }
      resetCategoryForm();
      fetchData();
    } catch (err) {
      console.error('[Category] Save error:', err);
      toast.error(t('products.failedToSaveCategory'));
    }
  };

  const handleCategoryDelete = async (id: number, name: string) => {
    const productCount = products.filter(p => p.category_id === id).length;
    if (productCount > 0) {
      setCatReassignTo('');
      setCatDeleteModal({ open: true, id, name, productCount });
      return;
    }

    try {
      await api.delete(`/categories/${id}`);
      toast.success(t('products.categoryDeleted'));
      fetchData();
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string; productCount?: number } } };
      if (e?.response?.status === 400 && e?.response?.data?.productCount) {
        setCatReassignTo('');
        setCatDeleteModal({ open: true, id, name, productCount: e.response.data.productCount });
      } else {
        toast.error(e?.response?.data?.error || t('common.failedToDelete'));
      }
    }
  };

  const handleCategoryReassignDelete = async () => {
    if (!catDeleteModal.id || !catReassignTo) return;
    try {
      await api.delete(`/categories/${catDeleteModal.id}?action=reassign&reassign_to=${catReassignTo}`);
      toast.success(t('products.reassignAndDelete'));
      setCatDeleteModal({ open: false, id: null, name: '', productCount: 0 });
      fetchData();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error || t('common.failedToDelete'));
    }
  };

  const handleCategoryForceDelete = async () => {
    if (!catDeleteModal.id) return;
    try {
      await api.delete(`/categories/${catDeleteModal.id}?action=delete_all`);
      toast.success(t('products.categoryAndProductsDeleted'));
      setCatDeleteModal({ open: false, id: null, name: '', productCount: 0 });
      fetchData();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error || t('common.failedToDelete'));
    }
  };

  const resetAddonForm = () => {
    setAddonForm({ name: '', description: '', is_required: false, allow_multiple_quantities: false, min_selection: 0, max_selection: 10 });
    setEditingAddonGroup(null);
    setShowAddonModal(false);
    setAddonList([]);
  };

  const openEditAddonGroup = (group: AddonGroup) => {
    setEditingAddonGroup(group);
    setAddonForm({ name: group.name, description: group.description || '', is_required: Boolean(group.is_required), allow_multiple_quantities: Boolean(group.allow_multiple_quantities), min_selection: group.min_selection, max_selection: group.max_selection });
    setAddonList(group.addons?.map((a) => ({ id: a.id, name: a.name, price: a.price, is_active: Boolean(a.is_active) })) || []);
    setShowAddonModal(true);
  };

  const handleAddonGroupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = { name: addonForm.name, description: addonForm.description || null, is_required: addonForm.is_required, allow_multiple_quantities: addonForm.allow_multiple_quantities, min_selection: addonForm.min_selection, max_selection: addonForm.max_selection, addons: addonList };
      if (editingAddonGroup) {
        await api.put(`/addon-groups/${editingAddonGroup.id}`, payload);
        toast.success(t('products.addonGroupUpdated'));
      } else {
        await api.post('/addon-groups', payload);
        toast.success(t('products.addonGroupCreated'));
      }
      resetAddonForm();
      fetchData();
    } catch { toast.error(t('products.failedToSaveAddonGroup')); }
  };

  const handleAddonGroupDelete = async (id: number | string) => {
    if (!await confirm(t('products.deleteAddonGroupConfirm'), { destructive: true, confirmLabel: t('common.delete') })) return;
    try {
      await api.delete(`/addon-groups/${id}`);
      toast.success(t('products.addonGroupDeleted'));
      fetchData();
    } catch { toast.error(t('common.failedToDelete')); }
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
        <h1 className="text-2xl font-bold text-gray-900">{t('products.title')}</h1>
      </div>

      <div className="flex gap-1 mb-6 border-b">
        <button onClick={() => setActiveTab('products')} className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === 'products' ? 'border-brand text-brand' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          <Package size={16} /> {t('products.tabProducts')}
        </button>
        <button onClick={() => setActiveTab('categories')} className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === 'categories' ? 'border-brand text-brand' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          <Folder size={16} /> {t('products.tabCategories')}
        </button>
        {isRestaurant && (
          <button onClick={() => setActiveTab('addons')} className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === 'addons' ? 'border-brand text-brand' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <Puzzle size={16} /> {t('products.tabAddonGroups')}
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
              <Plus size={16} className="mr-1" /> {t('products.addProduct')}
            </Button>
          </div>

      {/* Product Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnProduct')}</th>
              <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnCategory')}</th>
              <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">Add-ons</th>
              <th className="text-right p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnPrice')}</th>
              <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnTax')}</th>
              <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnStock')}</th>
              <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnStatus')}</th>
              <th className="text-right p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {products.map((product) => {
              const parentCat = categories.find((c) => String(c.id) === String(product.category_id || product.category?.id));
              const isCategoryInactive = Boolean(parentCat && !parentCat.is_active);
              const taxLabel = product.tax_type === 'none' || !product.tax_type
                ? '—'
                : `${product.tax_type === 'inclusive' ? t('products.taxInclusiveShort') : t('products.taxExclusiveShort')} ${product.tax_rate}%`;
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
                      {product.sku && <p className="text-xs text-gray-400 mt-0.5">{t('products.skuLabel', { sku: product.sku })}</p>}
                      {product.barcode && <p className="text-xs text-gray-400 mt-0.5 font-mono">{t('products.barcodeLabel', { barcode: product.barcode })}</p>}
                      {product.tags && product.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {product.tags.map((tag: string) => <TagBadge key={tag} tag={tag} />)}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="p-4 text-sm text-gray-600">
                  <div className="flex flex-col gap-0.5">
                    <span>{product.category?.name || '—'}</span>
                    {isCategoryInactive && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 w-fit" title="Parent category is inactive; product is hidden on POS">
                        <AlertTriangle size={11} className="shrink-0" /> Category Inactive
                      </span>
                    )}
                  </div>
                </td>
                <td className="p-4 text-center">
                  {product.addon_groups && product.addon_groups.length > 0 ? (
                    <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
                      {product.addon_groups.length} {product.addon_groups.length === 1 ? 'group' : 'groups'}
                    </span>
                  ) : (
                    <span className="text-gray-400 text-sm">—</span>
                  )}
                </td>
                <td className="p-4 text-right">
                  <p className="font-medium">{fmt(Number(product.price))}</p>
                  {product.cost_price != null && product.cost_price > 0 && <p className="text-xs text-gray-400">Cost: {fmt(Number(product.cost_price))}</p>}
                </td>
                <td className="p-4 text-sm text-gray-600">{taxLabel}</td>
                <td className="p-4 text-center">
                  {product.track_inventory ? (
                    <span className={`text-sm font-medium ${product.stock_quantity <= (product.low_stock_threshold || 0) ? 'text-red-600' : 'text-gray-900'}`}>
                      {product.stock_quantity <= 0 ? t('pos.outOfStock') : product.stock_quantity}
                    </span>
                  ) : (
                    <span className="text-gray-400 text-sm">—</span>
                  )}
                </td>
                <td className="p-4 text-center">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                    product.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {product.is_active ? t('common.active') : t('common.inactive')}
                  </span>
                  {product.is_active && isCategoryInactive && (
                    <span className="text-[10px] text-amber-600 font-medium block mt-1">(Hidden on POS)</span>
                  )}
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
          <p className="text-center text-gray-500 py-12">{t('products.empty')}</p>
        )}
      </div>

      {/* Product Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex justify-between items-center p-6 border-b border-gray-100 shrink-0">
              <h2 className="text-lg font-bold">{editingProduct ? t('products.editProductTitle') : t('products.addProductTitle')}</h2>
              <button onClick={resetForm} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldName')}<span className="text-red-500 ml-1">*</span></label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldImage')}</label>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldCategory')}<span className="text-red-500 ml-1">*</span></label>
                  <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required>
                    <option value="">{t('products.selectPlaceholder')}</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldSku')}</label>
                  <input type="text" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldBarcode')}</label>
                <input type="text" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                  placeholder={t('products.fieldBarcodePlaceholder')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none font-mono" />
                <p className="text-xs text-gray-400 mt-1">{t('products.fieldBarcodeHint')}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.priceLabel', { currency })}<span className="text-red-500 ml-1">*</span></label>
                  <input type="number" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldCostPrice')}</label>
                  <input type="number" step="0.01" value={form.cost_price} onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.cashbackLabel')}</label>
                <input type="number" step="0.1" min="0" max="100" value={form.cb_percent} onChange={(e) => setForm({ ...form, cb_percent: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                <p className="text-xs text-gray-400 mt-1">{t('products.cashbackHint')}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldTaxType')}</label>
                  <select value={form.tax_type} onChange={(e) => setForm({ ...form, tax_type: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none">
                    <option value="none">{t('products.taxNone')}</option>
                    <option value="inclusive">{t('products.taxInclusive')}</option>
                    <option value="exclusive">{t('products.taxExclusive')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.taxRateLabel')}</label>
                  <input type="number" step="0.01" value={form.tax_rate} onChange={(e) => setForm({ ...form, tax_rate: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.fieldTags')}</label>
                {/* Selected tags */}
                {form.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {form.tags.map((tag) => (
                      <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 bg-brand/10 text-brand rounded-lg text-xs font-medium">
                        {t(tagLabel(tag))}
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
                      + {t(pt.labelKey)}
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
                    placeholder={t('products.tagPlaceholder')}
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
                    {t('common.add')}
                  </button>
                </div>
              </div>
              {isRestaurant && addonGroups.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.fieldAddonGroups')}</label>
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
                              {group.is_required ? t('products.required') : t('products.optional')}
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
                  <span className="text-sm text-gray-700">{t('products.fieldTrackInventory')}</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                    className="rounded border-gray-300 text-brand focus:ring-brand" />
                  <span className="text-sm text-gray-700">{t('products.fieldActive')}</span>
                </label>
              </div>
              {!!form.track_inventory && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldStock')}<span className="text-red-500 ml-1">*</span></label>
                    <input type="number" min="0" value={form.stock_quantity} onChange={(e) => setForm({ ...form, stock_quantity: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldLowStockThreshold')}</label>
                    <input type="number" min="0" value={form.low_stock_threshold} onChange={(e) => setForm({ ...form, low_stock_threshold: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
                  </div>
                </div>
              )}
              <Button type="submit" className="w-full">
                {editingProduct ? t('products.updateProduct') : t('products.createProduct')}
              </Button>
            </form>
            </div>
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
              <Plus size={16} className="mr-1" /> {t('products.addCategory')}
            </Button>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">{t('products.categoryName')}</th>
                  <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">{t('products.categoryColor')}</th>
                  <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnStatus')}</th>
                  <th className="text-right p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnActions')}</th>
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
                          <span className={`inline-flex px-2 py-1 rounded-lg text-xs font-medium ${colorObj.bg} ${colorObj.text}`}>{t(colorObj.labelKey)}</span>
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
            {categories.length === 0 && <p className="text-center text-gray-500 py-12">{t('products.categoryEmpty')}</p>}
          </div>

          {showForm && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="bg-white rounded-2xl p-6 w-full max-w-md">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-lg font-bold">{editingCategory ? t('products.editCategoryTitle') : t('products.addCategoryTitle')}</h2>
                  <button onClick={resetCategoryForm} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
                </div>
                <form onSubmit={handleCategorySubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldName')}<span className="text-red-500 ml-1">*</span></label>
                    <input type="text" value={categoryForm.name} onChange={(e) => setCategoryForm({ ...categoryForm, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.categoryDescription')}</label>
                    <textarea value={categoryForm.description} onChange={(e) => setCategoryForm({ ...categoryForm, description: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" rows={2} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.colorLabel')}</label>
                    <div className="flex flex-wrap gap-2">
                      {CATEGORY_COLORS.map((c) => (
                        <button type="button" key={c.key} onClick={() => setCategoryForm({ ...categoryForm, color: c.key })} className={`px-3 py-1.5 rounded-lg text-xs font-medium border-2 ${c.key === categoryForm.color ? 'border-brand' : 'border-transparent'} ${c.bg} ${c.text}`}>{t(c.labelKey)}</button>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={categoryForm.is_active} onChange={(e) => setCategoryForm({ ...categoryForm, is_active: e.target.checked })} className="rounded border-gray-300 text-brand focus:ring-brand" />
                    <span className="text-sm text-gray-700">{t('products.fieldActive')}</span>
                  </label>
                  <Button type="submit" className="w-full">{editingCategory ? t('common.update') : t('common.create')}</Button>
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
              <Plus size={16} className="mr-1" /> {t('products.addAddonGroup')}
            </Button>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-4 text-xs font-medium text-gray-500 uppercase">{t('products.categoryName')}</th>
                  <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnRequired')}</th>
                  <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnSelection')}</th>
                  <th className="text-center p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnAddons')}</th>
                  <th className="text-right p-4 text-xs font-medium text-gray-500 uppercase">{t('products.columnActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {addonGroups.map((group) => (
                  <tr key={group.id} className="hover:bg-gray-50">
                    <td className="p-4 font-medium text-gray-900">{group.name}</td>
                    <td className="p-4 text-center">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${group.is_required ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{group.is_required ? t('common.yes') : t('common.no')}</span>
                    </td>
                    <td className="p-4 text-center text-sm text-gray-600">{t('products.addonSelectionRange', { min: group.min_selection, max: group.max_selection })}</td>
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
            {addonGroups.length === 0 && <p className="text-center text-gray-500 py-12">{t('products.addonEmpty')}</p>}
          </div>

          {showAddonModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
                <div className="flex justify-between items-center p-6 border-b border-gray-100 shrink-0">
                  <h2 className="text-lg font-bold">{editingAddonGroup ? t('products.editAddonGroupTitle') : t('products.addAddonGroupTitle')}</h2>
                  <button onClick={resetAddonForm} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
                </div>
                <div className="p-6 overflow-y-auto flex-1">
                  <form onSubmit={handleAddonGroupSubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.fieldName')}<span className="text-red-500 ml-1">*</span></label>
                    <input type="text" value={addonForm.name} onChange={(e) => setAddonForm({ ...addonForm, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.categoryDescription')}</label>
                    <input type="text" value={addonForm.description} onChange={(e) => setAddonForm({ ...addonForm, description: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.addonMin')}</label>
                      <input type="number" min="0" value={addonForm.min_selection} onChange={(e) => setAddonForm({ ...addonForm, min_selection: Number(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.addonMax')}</label>
                      <input type="number" min="0" value={addonForm.max_selection} onChange={(e) => setAddonForm({ ...addonForm, max_selection: Number(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={addonForm.is_required} onChange={(e) => setAddonForm({ ...addonForm, is_required: e.target.checked })} className="rounded border-gray-300 text-brand focus:ring-brand" />
                    <span className="text-sm text-gray-700">{t('products.addonRequired')}</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={addonForm.allow_multiple_quantities} onChange={(e) => setAddonForm({ ...addonForm, allow_multiple_quantities: e.target.checked })} className="rounded border-gray-300 text-brand focus:ring-brand" />
                    <span className="text-sm text-gray-700">Allow multiple quantities per add-on</span>
                  </label>
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <label className="block text-sm font-medium text-gray-700">{t('products.addonAddons')}</label>
                      <button type="button" onClick={addAddonItem} className="text-xs text-brand hover:underline">{t('products.addAddonInline')}</button>
                    </div>
                    <div className="space-y-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_6rem_1.5rem] gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                        <span>{t('products.nameLabel')}</span>
                        <span>{t('products.columnPrice')}</span>
                        <span aria-hidden="true" />
                      </div>
                      {addonList.map((addon, idx) => (
                        <div key={idx} className="grid grid-cols-[minmax(0,1fr)_6rem_1.5rem] gap-2 items-center">
                          <input type="text" value={addon.name} onChange={(e) => updateAddonItem(idx, 'name', e.target.value)} placeholder={t('common.namePlaceholder')} className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                          <input type="number" step="0.01" value={addon.price} onChange={(e) => updateAddonItem(idx, 'price', Number(e.target.value))} placeholder={t('common.pricePlaceholder')} aria-label={t('products.columnPrice')} className="w-24 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                          <button type="button" onClick={() => removeAddonItem(idx)} className="text-gray-400 hover:text-red-500"><X size={16} /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <Button type="submit" className="w-full">{editingAddonGroup ? t('common.update') : t('common.create')}</Button>
                </form>
                </div>
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
                {t('products.csvModalTitle', { type: csvType === 'categories' ? t('products.tabCategories') : csvType === 'products' ? t('products.tabProducts') : t('products.tabAddonGroups') })}
              </h2>
              <button onClick={() => setShowCsvModal(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-5">
              {/* Download section */}
              <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                <p className="text-sm font-medium text-gray-700">{t('products.download')}</p>
                <div className="flex gap-3">
                  <button
                    onClick={() => downloadCsv(`/menu-csv/template/${csvType}`, `${csvType}-template.csv`)}
                    className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 font-medium"
                  >
                    <Download size={14} /> {t('products.csvBlankTemplate')}
                  </button>
                  <button
                    onClick={() => downloadCsv(`/menu-csv/export/${csvType}`, `${csvType}-export.csv`)}
                    className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 font-medium"
                  >
                    <Download size={14} /> {t('products.csvCurrentData')}
                  </button>
                </div>
                {csvType === 'products' && (
                  <p className="text-xs text-gray-500">{t('products.csvProductsHelp')}</p>
                )}
                {csvType === 'categories' && (
                  <p className="text-xs text-gray-500">{t('products.csvCategoriesHelp')}</p>
                )}
                {csvType === 'addons' && (
                  <p className="text-xs text-gray-500">{t('products.csvAddonsHelp')}</p>
                )}
              </div>

              {/* Upload section */}
              <div className="space-y-3">
                <p className="text-sm font-medium text-gray-700">{t('products.uploadCsv')}</p>
                <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-gray-200 rounded-xl cursor-pointer hover:bg-gray-50 transition-colors">
                  <Upload size={20} className="text-gray-400 mb-1" />
                  <span className="text-sm text-gray-500">
                    {csvFile ? csvFile.name : t('products.csvChooseFile')}
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
                    {csvUploading ? t('products.csvImporting') : t('common.import')}
                  </Button>
                )}
              </div>

              {/* Result */}
              {csvResult && (
                <div className="rounded-xl border border-gray-100 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border-b border-gray-100">
                    <CheckCircle size={15} className="text-green-600" />
                    <span className="text-sm font-medium text-green-800">{t('products.importComplete')}</span>
                  </div>
                  <div className="px-4 py-3 text-sm text-gray-700 space-y-1">
                    {csvType === 'addons' ? (
                      <>
                        <p>{t('products.csvGroupsCreated')} <span className="font-medium">{String(csvResult.groups_created ?? 0)}</span></p>
                        <p>{t('products.csvAddonsCreated')} <span className="font-medium">{String(csvResult.addons_created ?? 0)}</span></p>
                      </>
                    ) : (
                      <p>{t('common.created')} <span className="font-medium">{String(csvResult.created ?? 0)}</span></p>
                    )}
                    <p>{t('common.skipped')} <span className="font-medium">{String(csvResult.skipped ?? 0)}</span></p>
                  </div>
                  {Array.isArray(csvResult.warnings) && (csvResult.warnings as string[]).length > 0 && (
                    <div className="px-4 py-3 border-t border-gray-100 bg-amber-50">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertCircle size={14} className="text-amber-500" />
                        <span className="text-xs font-medium text-amber-700">{t('products.csvMissingFields')}</span>
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
                        <span className="text-xs font-medium text-red-700">{t('products.csvSkippedErrors')}</span>
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
              <h2 className="text-lg font-bold text-gray-900">{t('products.deleteCategoryTitle')}</h2>
              <button onClick={() => setCatDeleteModal({ open: false, id: null, name: '', productCount: 0 })} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <p className="text-sm text-gray-700 mb-5">
              {t('products.deleteCategoryBody', { name: catDeleteModal.name, count: catDeleteModal.productCount })}
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.moveProductsTo')}</label>
                <select
                  value={catReassignTo}
                  onChange={(e) => setCatReassignTo(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none"
                >
                  <option value="">{t('products.selectCategoryPlaceholder')}</option>
                  {categories
                    .filter((c) => c.name.toLowerCase() === 'uncategorized' && c.id !== catDeleteModal.id)
                    .map((c) => <option key={c.id} value={String(c.id)}>{t('products.defaultCategoryTag', { name: c.name })}</option>)}
                  {categories
                    .filter((c) => c.name.toLowerCase() !== 'uncategorized' && c.id !== catDeleteModal.id)
                    .map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                </select>
              </div>
              <Button onClick={handleCategoryReassignDelete} disabled={!catReassignTo} className="w-full">
                {t('products.moveAndDelete')}
              </Button>
              <div className="relative flex items-center">
                <div className="flex-grow border-t border-gray-200" />
                <span className="mx-3 text-xs text-gray-400">{t('common.or')}</span>
                <div className="flex-grow border-t border-gray-200" />
              </div>
              <button
                onClick={handleCategoryForceDelete}
                className="w-full px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
              >
                {t('products.deleteCategoryAndProducts')}
              </button>
            </div>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}
