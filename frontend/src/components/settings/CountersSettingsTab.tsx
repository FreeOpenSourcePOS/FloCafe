'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'use-intl';
import {
  Layers,
  Plus,
  Edit2,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import { Toggle } from '@/components/settings/Toggle';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import api from '@/lib/api';
import toast from 'react-hot-toast';

export interface CounterItem {
  id: string;
  name: string;
  role: 'ordering' | 'payment' | 'combined';
  is_active: number | boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

interface Props {
  isOwner: boolean;
}

export function CountersSettingsTab({ isOwner }: Props) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');

  const [enabled, setEnabled] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const [counters, setCounters] = useState<CounterItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Add / Edit Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCounter, setEditingCounter] = useState<CounterItem | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<'ordering' | 'payment' | 'combined'>('ordering');
  const [isActive, setIsActive] = useState(true);
  const [sortOrder, setSortOrder] = useState(0);
  const [savingCounter, setSavingCounter] = useState(false);

  // Delete confirmation state
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [settingRes, countersRes] = await Promise.all([
        api
          .get('/settings/multi_counter_enabled')
          .catch(() => ({ data: { setting: { value: 'false' } } })),
        api
          .get('/counters', { params: { include_inactive: 'true' } })
          .catch(() => ({ data: { counters: [] } })),
      ]);
      setEnabled(settingRes.data?.setting?.value === 'true');
      setCounters(countersRes.data?.counters || []);
    } catch {
      toast.error(t('counterLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api
        .get('/settings/multi_counter_enabled')
        .catch(() => ({ data: { setting: { value: 'false' } } })),
      api
        .get('/counters', { params: { include_inactive: 'true' } })
        .catch(() => ({ data: { counters: [] } })),
    ])
      .then(([settingRes, countersRes]) => {
        if (cancelled) return;
        setEnabled(settingRes.data?.setting?.value === 'true');
        setCounters(countersRes.data?.counters || []);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        toast.error(t('counterLoadFailed'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleToggleEnabled = async (val: boolean) => {
    if (!isOwner) {
      toast.error(t('ownerPermissionRequired'));
      return;
    }
    setSavingEnabled(true);
    try {
      await api.put('/settings/multi_counter_enabled', { value: String(val) });
      setEnabled(val);
      toast.success(val ? t('multiCounterEnabled') : t('multiCounterDisabled'));
    } catch {
      toast.error(t('allSaveFailed'));
    } finally {
      setSavingEnabled(false);
    }
  };

  const handleOpenAddModal = () => {
    setEditingCounter(null);
    setName('');
    setRole('ordering');
    setIsActive(true);
    setSortOrder(counters.length * 10);
    setModalOpen(true);
  };

  const handleOpenEditModal = (counter: CounterItem) => {
    setEditingCounter(counter);
    setName(counter.name);
    setRole(counter.role);
    setIsActive(Boolean(counter.is_active));
    setSortOrder(counter.sort_order ?? 0);
    setModalOpen(true);
  };

  const handleSaveCounter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error(t('counterNameRequired'));
      return;
    }
    setSavingCounter(true);
    try {
      if (editingCounter) {
        await api.put(`/counters/${editingCounter.id}`, {
          name: name.trim(),
          role,
          is_active: isActive,
          sort_order: Number(sortOrder) || 0,
        });
        toast.success(t('counterUpdated'));
      } else {
        await api.post('/counters', {
          name: name.trim(),
          role,
          is_active: isActive,
          sort_order: Number(sortOrder) || 0,
        });
        toast.success(t('counterCreated'));
      }
      setModalOpen(false);
      void loadData();
    } catch (err: unknown) {
      const errorObj = err as { response?: { data?: { error?: string } } };
      toast.error(errorObj.response?.data?.error || tCommon('failedToSave'));
    } finally {
      setSavingCounter(false);
    }
  };

  const handleDeleteCounter = async (id: string) => {
    try {
      await api.delete(`/counters/${id}`);
      toast.success(t('counterDeleted'));
      setDeletingId(null);
      void loadData();
    } catch (err: unknown) {
      const errorObj = err as { response?: { data?: { error?: string } } };
      toast.error(errorObj.response?.data?.error || tCommon('failedToDelete'));
    }
  };

  const getRoleLabel = (r: 'ordering' | 'payment' | 'combined') => {
    switch (r) {
      case 'ordering':
        return t('counterRoleOrdering');
      case 'payment':
        return t('counterRolePayment');
      case 'combined':
        return t('counterRoleCombined');
    }
  };

  const getRoleBadgeColor = (r: 'ordering' | 'payment' | 'combined') => {
    switch (r) {
      case 'ordering':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800';
      case 'payment':
        return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800';
      case 'combined':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
    }
  };

  return (
    <SettingsTabShell>
      <div className="space-y-6">
        {/* Header card with toggle */}
        <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-brand/10 p-2.5 text-brand shrink-0">
                <Layers size={22} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">{t('multiCounterTitle')}</h2>
                <p className="text-sm text-muted-foreground mt-0.5">{t('multiCounterDesc')}</p>
              </div>
            </div>
            <Toggle
              value={enabled}
              disabled={savingEnabled || !isOwner}
              label={t('multiCounterTitle')}
              onChange={handleToggleEnabled}
            />
          </div>
        </div>

        {/* Counter management section */}
        {enabled && (
          <div className="bg-card rounded-xl border border-border p-6 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-foreground text-base">{t('namedCounters')}</h3>
                <p className="text-sm text-muted-foreground">{t('namedCountersHint')}</p>
              </div>
              <Button
                onClick={handleOpenAddModal}
                disabled={!isOwner}
                size="sm"
                className="gap-1.5"
              >
                <Plus size={16} />
                {t('addCounter')}
              </Button>
            </div>

            {loading ? (
              <div className="flex justify-center items-center py-12 text-muted-foreground gap-2">
                <Loader2 size={18} className="animate-spin" />
                <span>{tCommon('loading')}</span>
              </div>
            ) : counters.length === 0 ? (
              <div className="text-center py-12 border border-dashed border-border rounded-lg text-muted-foreground">
                <p className="font-medium">{t('noCountersConfigured')}</p>
                <p className="text-sm mt-1">{t('addFirstCounter')}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="pb-3 font-medium">{t('name')}</th>
                      <th className="pb-3 font-medium">{t('role')}</th>
                      <th className="pb-3 font-medium">{t('status')}</th>
                      <th className="pb-3 font-medium text-end">{t('actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {counters.map((counter) => (
                      <tr key={counter.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-3 font-medium text-foreground">{counter.name}</td>
                        <td className="py-3">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getRoleBadgeColor(
                              counter.role,
                            )}`}
                          >
                            {getRoleLabel(counter.role)}
                          </span>
                        </td>
                        <td className="py-3">
                          {counter.is_active ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                              <CheckCircle2 size={14} /> {tCommon('active')}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <XCircle size={14} /> {tCommon('inactive')}
                            </span>
                          )}
                        </td>
                        <td className="py-3 text-end">
                          <div className="inline-flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!isOwner}
                              onClick={() => handleOpenEditModal(counter)}
                              className="h-8 w-8 p-0"
                              title={tCommon('edit')}
                            >
                              <Edit2 size={14} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!isOwner}
                              onClick={() => setDeletingId(counter.id)}
                              className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40"
                              title={tCommon('delete')}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCounter ? t('editCounter') : t('addCounter')}</DialogTitle>
            <DialogDescription>{t('counterModalDesc')}</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSaveCounter} className="space-y-4 pt-2">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('counterName')}
              </label>
              <input
                type="text"
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('stationNamePlaceholder')}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('counterRole')}
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'ordering' | 'payment' | 'combined')}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              >
                <option value="ordering">{t('counterRoleOrdering')}</option>
                <option value="payment">{t('counterRolePayment')}</option>
                <option value="combined">{t('counterRoleCombined')}</option>
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {role === 'ordering' && t('counterRoleOrderingHint')}
                {role === 'payment' && t('counterRolePaymentHint')}
                {role === 'combined' && t('counterRoleCombinedHint')}
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="counterActive"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="rounded border-border text-brand focus:ring-brand"
              />
              <label htmlFor="counterActive" className="text-sm font-medium text-foreground">
                {t('counterIsActive')} ({t('counterIsActiveHint')})
              </label>
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setModalOpen(false)}
                disabled={savingCounter}
              >
                {tCommon('cancel')}
              </Button>
              <Button type="submit" disabled={savingCounter || !name.trim()}>
                {savingCounter ? tCommon('saving') : tCommon('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <Dialog open={Boolean(deletingId)} onOpenChange={(open) => !open && setDeletingId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertCircle size={20} />
              {t('confirmDeleteCounter')}
            </DialogTitle>
            <DialogDescription>{t('confirmDeleteCounterDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="pt-2">
            <Button variant="outline" onClick={() => setDeletingId(null)}>
              {tCommon('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deletingId && handleDeleteCounter(deletingId)}
            >
              {tCommon('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsTabShell>
  );
}
