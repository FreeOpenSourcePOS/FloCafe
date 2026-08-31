'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, X, ChevronDown, ChevronRight } from 'lucide-react';
import type { AddonGroup, Addon } from '@/lib/types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useConfirm } from '@/hooks/use-confirm';

export default function AddonGroupsPage() {
  const t = useTranslations('addonGroups');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const tProducts = useTranslations('products');
  const tTables = useTranslations('tables');
  const [groups, setGroups] = useState<AddonGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const { confirm, ConfirmDialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [editingGroup, setEditingGroup] = useState<AddonGroup | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<number | string | null>(null);
  const [mutating, setMutating] = useState(false);

  // Group form
  const [form, setForm] = useState({
    name: '', description: '', is_required: false, allow_multiple_quantities: false,
    min_selection: '0', max_selection: '1',
  });

  // Addon form (inline)
  const [addonForm, setAddonForm] = useState({ name: '', price: '0' });
  const [addingAddonTo, setAddingAddonTo] = useState<number | string | null>(null);
  const [editingAddon, setEditingAddon] = useState<{ groupId: number | string; addon: Addon } | null>(null);

  const fmt = useFormatCurrency();

  const extractErrorMessage = (_err: unknown, fallback: string) => fallback;

  const fetchGroups = async () => {
    try {
      const { data } = await api.get('/addon-groups');
      setGroups(data.addon_groups || []);
    } catch {
      toast.error(t('failedToLoad'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.get('/addon-groups')
      .then(({ data }) => setGroups(data.addon_groups || []))
      .catch(() => toast.error(t('failedToLoad')))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetForm = () => {
    setForm({ name: '', description: '', is_required: false, allow_multiple_quantities: false, min_selection: '0', max_selection: '1' });
    setEditingGroup(null);
    setShowForm(false);
  };

  const openEdit = (group: AddonGroup) => {
    setEditingGroup(group);
    setForm({
      name: group.name,
      description: group.description || '',
      is_required: Boolean(group.is_required),
      allow_multiple_quantities: Boolean(group.allow_multiple_quantities),
      min_selection: String(group.min_selection),
      max_selection: String(group.max_selection),
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mutating) return;
    const minVal = Number(form.min_selection);
    const maxVal = Number(form.max_selection);
    if (minVal > maxVal) {
      toast.error(t('minExceedsMax'));
      return;
    }
    const activeAddonCount = editingGroup ? (editingGroup.addons?.filter((a) => a.is_active).length ?? 0) : 0;
    if (minVal > activeAddonCount) {
      toast.error(t('minExceedsAvailable', { count: activeAddonCount }));
      return;
    }
    try {
      setMutating(true);
      const payload = {
        ...form,
        min_selection: minVal,
        max_selection: maxVal,
      };
      if (editingGroup) {
        await api.put(`/addon-groups/${editingGroup.id}`, payload);
        toast.success(t('groupUpdated'));
      } else {
        await api.post('/addon-groups', payload);
        toast.success(t('groupCreated'));
      }
      resetForm();
      fetchGroups();
    } catch (err: unknown) {
      toast.error(extractErrorMessage(err, tCommon('failedToSave')));
    } finally {
      setMutating(false);
    }
  };

  const handleDeleteGroup = async (id: number | string) => {
    if (mutating) return;
    if (!await confirm(t('deleteGroupConfirm'), { destructive: true, confirmLabel: tCommon('delete') })) return;
    try {
      setMutating(true);
      await api.delete(`/addon-groups/${id}`);
      toast.success(t('groupDeleted'));
      fetchGroups();
    } catch {
      toast.error(tCommon('failedToDelete'));
    } finally {
      setMutating(false);
    }
  };

  // Addon CRUD
  const handleAddAddon = async (groupId: number | string) => {
    if (mutating) return;
    if (!addonForm.name.trim()) return;
    try {
      setMutating(true);
      await api.post(`/addon-groups/${groupId}/addons`, {
        name: addonForm.name,
        price: Number(addonForm.price),
      });
      toast.success(t('addonAdded'));
      setAddonForm({ name: '', price: '0' });
      setAddingAddonTo(null);
      fetchGroups();
    } catch {
      toast.error(t('failedToAddAddon'));
    } finally {
      setMutating(false);
    }
  };

  const handleUpdateAddon = async () => {
    if (mutating) return;
    if (!editingAddon || !addonForm.name.trim()) return;
    try {
      setMutating(true);
      await api.put(`/addon-groups/${editingAddon.groupId}/addons/${editingAddon.addon.id}`, {
        name: addonForm.name,
        price: Number(addonForm.price),
      });
      toast.success(t('addonUpdated'));
      setAddonForm({ name: '', price: '0' });
      setEditingAddon(null);
      fetchGroups();
    } catch {
      toast.error(t('failedToUpdateAddon'));
    } finally {
      setMutating(false);
    }
  };

  const handleDeleteAddon = async (groupId: number | string, addonId: number | string) => {
    if (mutating) return;
    if (!await confirm(t('deleteAddonConfirm'), { destructive: true, confirmLabel: tCommon('delete') })) return;
    try {
      setMutating(true);
      await api.delete(`/addon-groups/${groupId}/addons/${addonId}`);
      toast.success(t('addonDeleted'));
      fetchGroups();
    } catch (err: unknown) {
      toast.error(extractErrorMessage(err, t('failedToDeleteAddon')));
    } finally {
      setMutating(false);
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
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <Button onClick={() => { resetForm(); setShowForm(true); }}>
          <Plus size={16} className="me-1" /> {t('addGroup')}
        </Button>
      </div>

      <div className="space-y-3">
        {groups.map((group) => {
          const isExpanded = expandedGroup === group.id;
          return (
            <div key={group.id} className="bg-card rounded-xl border border-border">
              {/* Group Header */}
              <div className="flex items-center justify-between p-4">
                <button
                  onClick={() => setExpandedGroup(isExpanded ? null : group.id)}
                  className="flex items-center gap-3 flex-1 text-start"
                >
                  {isExpanded ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronRight size={18} className="text-gray-400" />}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{group.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${group.is_required ? 'bg-red-100 text-red-700' : 'bg-muted text-muted-foreground'}`}>
                        {group.is_required ? tProducts('requiredTag') : tProducts('optionalTag')}
                      </span>
                      <span className="text-xs text-gray-400">
                        {t('addCount', { count: group.addons?.length || 0 })}
                      </span>
                    </div>
                    {group.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">{group.description}</p>
                    )}
                    <p className="text-xs text-gray-400 mt-0.5">
                      {t('selectRange', { min: group.min_selection, max: group.max_selection })}
                    </p>
                  </div>
                </button>
                <div className="flex gap-2">
                  <button onClick={() => openEdit(group)} disabled={mutating} className="p-1.5 text-gray-400 hover:text-brand disabled:opacity-50">
                    <Pencil size={16} />
                  </button>
                  <button onClick={() => handleDeleteGroup(group.id)} disabled={mutating} className="p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              {/* Expanded: Addons */}
              {isExpanded && (
                <div className="border-t border-border p-4 pt-3">
                  <div className="space-y-2">
                    {group.addons?.map((addon) => (
                      <div key={addon.id} className="flex items-center justify-between py-1.5 px-3 bg-muted rounded-lg">
                        {editingAddon?.addon.id === addon.id ? (
                          <div className="flex items-end gap-2 flex-1">
                            <label className="flex-1">
                              <span className="block text-[11px] font-medium text-muted-foreground mb-0.5">{tProducts('nameLabel')}</span>
                              <input type="text" value={addonForm.name} onChange={(e) => setAddonForm({ ...addonForm, name: e.target.value })}
                                className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-border rounded outline-none focus:ring-1 focus:ring-brand" />
                            </label>
                            <label className="w-24">
                              <span className="block text-[11px] font-medium text-muted-foreground mb-0.5">{tProducts('columnPrice')}</span>
                              <input type="number" step="0.01" value={addonForm.price} onChange={(e) => setAddonForm({ ...addonForm, price: e.target.value })} onWheel={(e) => e.currentTarget.blur()}
                                className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-border rounded outline-none focus:ring-1 focus:ring-brand" />
                            </label>
                            <button onClick={handleUpdateAddon} disabled={mutating} className="text-xs text-brand font-medium hover:underline disabled:opacity-50">{tCommon('save')}</button>
                            <button onClick={() => { setEditingAddon(null); setAddonForm({ name: '', price: '0' }); }} className="text-xs text-gray-400 hover:underline">{tTables('cancel')}</button>
                          </div>
                        ) : (
                          <>
                            <span className="text-sm text-foreground">{addon.name}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-sm font-medium text-foreground">
                                {Number(addon.price) === 0 ? tPos('free') : fmt(Number(addon.price))}
                              </span>
                              <button onClick={() => { setEditingAddon({ groupId: group.id, addon }); setAddonForm({ name: addon.name, price: String(addon.price) }); }}
                                disabled={mutating} className="p-1 text-gray-400 hover:text-brand disabled:opacity-50"><Pencil size={14} /></button>
                              <button onClick={() => handleDeleteAddon(group.id, addon.id)}
                                disabled={mutating} className="p-1 text-gray-400 hover:text-red-600 disabled:opacity-50"><Trash2 size={14} /></button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Add Addon Form */}
                  {addingAddonTo === group.id ? (
                    <div className="flex items-end gap-2 mt-3">
                      <label className="flex-1">
                        <span className="block text-[11px] font-medium text-muted-foreground mb-0.5">{tProducts('nameLabel')}</span>
                        <input type="text" placeholder={tProducts('addonNamePlaceholder')} value={addonForm.name}
                          onChange={(e) => setAddonForm({ ...addonForm, name: e.target.value })}
                          className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-border rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                      </label>
                      <label className="w-24">
                        <span className="block text-[11px] font-medium text-muted-foreground mb-0.5">{tProducts('columnPrice')}</span>
                        <input type="number" step="0.01" placeholder={tProducts('addonPricePlaceholder')} value={addonForm.price}
                          onChange={(e) => setAddonForm({ ...addonForm, price: e.target.value })}
                          onWheel={(e) => e.currentTarget.blur()}
                          className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-border rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                      </label>
                      <button onClick={() => handleAddAddon(group.id)} disabled={mutating}
                        className="px-3 py-1.5 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover disabled:opacity-50">{tProducts('addButton')}</button>
                      <button onClick={() => { setAddingAddonTo(null); setAddonForm({ name: '', price: '0' }); }}
                        className="text-gray-400 hover:text-muted-foreground"><X size={16} /></button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setAddingAddonTo(group.id); setAddonForm({ name: '', price: '0' }); }}
                      className="mt-3 text-sm text-brand font-medium flex items-center gap-1 hover:underline"
                    >
                      <Plus size={14} /> {tProducts('addAddon')}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <p className="text-center text-muted-foreground py-12">{t('noAddonGroups')}</p>
        )}
      </div>

      {/* Group Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{editingGroup ? t('editGroup') : tProducts('addAddonGroupForm')}</h2>
              <button onClick={resetForm} className="text-gray-400 hover:text-muted-foreground"><X size={20} /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">{tProducts('nameLabel')}</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg focus:ring-2 focus:ring-brand outline-none" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">{tProducts('categoryDescription')}</label>
                <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg focus:ring-2 focus:ring-brand outline-none" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={form.is_required} onChange={(e) => setForm({ ...form, is_required: e.target.checked })}
                  className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand" />
                <span className="text-sm text-foreground">{tProducts('requiredSelection')}</span>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="allow_multiple_quantities" checked={form.allow_multiple_quantities} onChange={(e) => setForm({ ...form, allow_multiple_quantities: e.target.checked })}
                  className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand" />
                <label htmlFor="allow_multiple_quantities" className="text-sm text-foreground">Allow multiple quantities per add-on</label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">{tProducts('minSelection')}</label>
                  <input type="number" min="0" value={form.min_selection} onChange={(e) => setForm({ ...form, min_selection: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">{tProducts('maxSelection')}</label>
                  <input type="number" min="1" value={form.max_selection} onChange={(e) => setForm({ ...form, max_selection: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg focus:ring-2 focus:ring-brand outline-none" />
                </div>
              </div>
              <Button type="submit" disabled={mutating} className="w-full">
                {editingGroup ? tProducts('update') : tProducts('create')}
              </Button>
            </form>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}
