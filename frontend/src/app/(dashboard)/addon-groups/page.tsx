'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, X, ChevronDown, ChevronRight } from 'lucide-react';
import type { AddonGroup, Addon } from '@/lib/types';
import { getCurrencySymbol } from '@/lib/countries';
import { useConfirm } from '@/hooks/use-confirm';

export default function AddonGroupsPage() {
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const [groups, setGroups] = useState<AddonGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const { confirm, ConfirmDialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [editingGroup, setEditingGroup] = useState<AddonGroup | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<number | null>(null);

  // Group form
  const [form, setForm] = useState({
    name: '', description: '', is_required: false,
    min_selection: '0', max_selection: '1',
  });

  // Addon form (inline)
  const [addonForm, setAddonForm] = useState({ name: '', price: '0' });
  const [addingAddonTo, setAddingAddonTo] = useState<number | null>(null);
  const [editingAddon, setEditingAddon] = useState<{ groupId: number; addon: Addon } | null>(null);

  const currency = getCurrencySymbol(currentTenant?.currency || 'INR');

  const fetchGroups = async () => {
    try {
      const { data } = await api.get('/addon-groups');
      setGroups(data.addon_groups || []);
    } catch {
      toast.error(t('addonGroups.failedToLoad'));
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchGroups(); }, []);

  const resetForm = () => {
    setForm({ name: '', description: '', is_required: false, min_selection: '0', max_selection: '1' });
    setEditingGroup(null);
    setShowForm(false);
  };

  const openEdit = (group: AddonGroup) => {
    setEditingGroup(group);
    setForm({
      name: group.name,
      description: group.description || '',
      is_required: group.is_required,
      min_selection: String(group.min_selection),
      max_selection: String(group.max_selection),
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        ...form,
        min_selection: Number(form.min_selection),
        max_selection: Number(form.max_selection),
      };
      if (editingGroup) {
        await api.put(`/addon-groups/${editingGroup.id}`, payload);
        toast.success(t('addonGroups.groupUpdated'));
      } else {
        await api.post('/addon-groups', payload);
        toast.success(t('addonGroups.groupCreated'));
      }
      resetForm();
      fetchGroups();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { errors?: Record<string, string[]> } } };
      const msg = error.response?.data?.errors
        ? Object.values(error.response.data.errors)[0]?.[0]
        : t('common.failedToSave');
      toast.error(msg);
    }
  };

  const handleDeleteGroup = async (id: number) => {
    if (!await confirm(t('addonGroups.deleteGroupConfirm'), { destructive: true, confirmLabel: t('common.delete') })) return;
    try {
      await api.delete(`/addon-groups/${id}`);
      toast.success(t('addonGroups.groupDeleted'));
      fetchGroups();
    } catch {
      toast.error(t('common.failedToDelete'));
    }
  };

  // Addon CRUD
  const handleAddAddon = async (groupId: number) => {
    if (!addonForm.name.trim()) return;
    try {
      await api.post(`/addon-groups/${groupId}/addons`, {
        name: addonForm.name,
        price: Number(addonForm.price),
      });
      toast.success(t('addonGroups.addonAdded'));
      setAddonForm({ name: '', price: '0' });
      setAddingAddonTo(null);
      fetchGroups();
    } catch {
      toast.error(t('addonGroups.failedToAddAddon'));
    }
  };

  const handleUpdateAddon = async () => {
    if (!editingAddon || !addonForm.name.trim()) return;
    try {
      await api.put(`/addon-groups/${editingAddon.groupId}/addons/${editingAddon.addon.id}`, {
        name: addonForm.name,
        price: Number(addonForm.price),
      });
      toast.success(t('addonGroups.addonUpdated'));
      setAddonForm({ name: '', price: '0' });
      setEditingAddon(null);
      fetchGroups();
    } catch {
      toast.error(t('addonGroups.failedToUpdateAddon'));
    }
  };

  const handleDeleteAddon = async (groupId: number, addonId: number) => {
    if (!await confirm(t('addonGroups.deleteAddonConfirm'), { destructive: true, confirmLabel: t('common.delete') })) return;
    try {
      await api.delete(`/addon-groups/${groupId}/addons/${addonId}`);
      toast.success(t('addonGroups.addonDeleted'));
      fetchGroups();
    } catch {
      toast.error(t('addonGroups.failedToDeleteAddon'));
    }
  };

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
        <h1 className="text-2xl font-bold text-gray-900">{t('addonGroups.title')}</h1>
        <Button onClick={() => { resetForm(); setShowForm(true); }}>
          <Plus size={16} className="mr-1" /> {t('addonGroups.addGroup')}
        </Button>
      </div>

      <div className="space-y-3">
        {groups.map((group) => {
          const isExpanded = expandedGroup === group.id;
          return (
            <div key={group.id} className="bg-white rounded-xl border border-gray-100">
              {/* Group Header */}
              <div className="flex items-center justify-between p-4">
                <button
                  onClick={() => setExpandedGroup(isExpanded ? null : group.id)}
                  className="flex items-center gap-3 flex-1 text-left"
                >
                  {isExpanded ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronRight size={18} className="text-gray-400" />}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">{group.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${group.is_required ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                        {group.is_required ? t('products.requiredTag') : t('products.optionalTag')}
                      </span>
                      <span className="text-xs text-gray-400">
                        {t('addonGroups.addCount', { count: group.addons?.length || 0 })}
                      </span>
                    </div>
                    {group.description && (
                      <p className="text-xs text-gray-500 mt-0.5">{group.description}</p>
                    )}
                    <p className="text-xs text-gray-400 mt-0.5">
                      {t('addonGroups.selectRange', { min: group.min_selection, max: group.max_selection })}
                    </p>
                  </div>
                </button>
                <div className="flex gap-2">
                  <button onClick={() => openEdit(group)} className="p-1.5 text-gray-400 hover:text-brand">
                    <Pencil size={16} />
                  </button>
                  <button onClick={() => handleDeleteGroup(group.id)} className="p-1.5 text-gray-400 hover:text-red-600">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              {/* Expanded: Addons */}
              {isExpanded && (
                <div className="border-t border-gray-100 p-4 pt-3">
                  <div className="space-y-2">
                    {group.addons?.map((addon) => (
                      <div key={addon.id} className="flex items-center justify-between py-1.5 px-3 bg-gray-50 rounded-lg">
                        {editingAddon?.addon.id === addon.id ? (
                          <div className="flex items-center gap-2 flex-1">
                            <input type="text" value={addonForm.name} onChange={(e) => setAddonForm({ ...addonForm, name: e.target.value })}
                              className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded outline-none focus:ring-1 focus:ring-brand" />
                            <input type="number" step="0.01" value={addonForm.price} onChange={(e) => setAddonForm({ ...addonForm, price: e.target.value })}
                              className="w-24 px-2 py-1 text-sm border border-gray-300 rounded outline-none focus:ring-1 focus:ring-brand" />
                            <button onClick={handleUpdateAddon} className="text-xs text-brand font-medium hover:underline">{t('common.save')}</button>
                            <button onClick={() => { setEditingAddon(null); setAddonForm({ name: '', price: '0' }); }} className="text-xs text-gray-400 hover:underline">{t('tables.cancel')}</button>
                          </div>
                        ) : (
                          <>
                            <span className="text-sm text-gray-700">{addon.name}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-sm font-medium text-gray-900">
                                {Number(addon.price) === 0 ? t('pos.free') : `${currency}${Number(addon.price).toLocaleString()}`}
                              </span>
                              <button onClick={() => { setEditingAddon({ groupId: group.id, addon }); setAddonForm({ name: addon.name, price: String(addon.price) }); }}
                                className="p-1 text-gray-400 hover:text-brand"><Pencil size={14} /></button>
                              <button onClick={() => handleDeleteAddon(group.id, addon.id)}
                                className="p-1 text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Add Addon Form */}
                  {addingAddonTo === group.id ? (
                    <div className="flex items-center gap-2 mt-3">
                      <input type="text" placeholder={t('products.addonNamePlaceholder')} value={addonForm.name}
                        onChange={(e) => setAddonForm({ ...addonForm, name: e.target.value })}
                        className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                      <input type="number" step="0.01" placeholder={t('products.addonPricePlaceholder')} value={addonForm.price}
                        onChange={(e) => setAddonForm({ ...addonForm, price: e.target.value })}
                        className="w-24 px-3 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                      <button onClick={() => handleAddAddon(group.id)}
                        className="px-3 py-1.5 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover">{t('products.addButton')}</button>
                      <button onClick={() => { setAddingAddonTo(null); setAddonForm({ name: '', price: '0' }); }}
                        className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setAddingAddonTo(group.id); setAddonForm({ name: '', price: '0' }); }}
                      className="mt-3 text-sm text-brand font-medium flex items-center gap-1 hover:underline"
                    >
                      <Plus size={14} /> {t('products.addAddon')}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <p className="text-center text-gray-500 py-12">{t('addonGroups.noAddonGroups')}</p>
        )}
      </div>

      {/* Group Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{editingGroup ? t('addonGroups.editGroup') : t('products.addAddonGroupForm')}</h2>
              <button onClick={resetForm} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.nameLabel')}</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.categoryDescription')}</label>
                <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={form.is_required} onChange={(e) => setForm({ ...form, is_required: e.target.checked })}
                  className="rounded border-gray-300 text-brand focus:ring-brand" />
                <span className="text-sm text-gray-700">{t('products.requiredSelection')}</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.minSelection')}</label>
                  <input type="number" min="0" value={form.min_selection} onChange={(e) => setForm({ ...form, min_selection: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('products.maxSelection')}</label>
                  <input type="number" min="1" value={form.max_selection} onChange={(e) => setForm({ ...form, max_selection: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
              </div>
              <Button type="submit" className="w-full">
                {editingGroup ? t('products.update') : t('products.create')}
              </Button>
            </form>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}
