'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Copy, ExternalLink, MonitorSmartphone } from 'lucide-react';
import api from '@/lib/api';
import {
  CUSTOMER_DISPLAY_DEFAULTS,
  CUSTOMER_DISPLAY_PATH,
  CUSTOMER_DISPLAY_STATUSES,
  type CustomerDisplayConfig,
  type CustomerDisplayStatus,
} from '@/lib/customer-display';

const STATUS_LABEL_KEYS = {
  pending: 'statusPending',
  preparing: 'statusPreparing',
  ready: 'statusReady',
} as const;

export function CustomerDisplayCard() {
  const t = useTranslations('customerDisplay');
  const tCommon = useTranslations('common');
  const [config, setConfig] = useState<CustomerDisplayConfig>(CUSTOMER_DISPLAY_DEFAULTS);
  const [saved, setSaved] = useState<CustomerDisplayConfig>(CUSTOMER_DISPLAY_DEFAULTS);
  const [saving, setSaving] = useState(false);
  const displayUrl = typeof window === 'undefined' ? CUSTOMER_DISPLAY_PATH : `${window.location.origin}${CUSTOMER_DISPLAY_PATH}`;

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/settings/customer-display', { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setConfig(res.data);
        setSaved(res.data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const dirty = JSON.stringify(config) !== JSON.stringify(saved);

  function toggleStatus(status: CustomerDisplayStatus) {
    setConfig((prev) => {
      const next = prev.statuses.includes(status)
        ? prev.statuses.filter((s) => s !== status)
        : CUSTOMER_DISPLAY_STATUSES.filter((s) => s === status || prev.statuses.includes(s));
      if (next.length === 0) {
        toast.error(t('atLeastOneStatus'));
        return prev;
      }
      return { ...prev, statuses: next };
    });
  }

  async function save() {
    setSaving(true);
    try {
      const { data } = await api.put('/settings/customer-display', config);
      setConfig(data);
      setSaved(data);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  function copyUrl() {
    navigator.clipboard.writeText(displayUrl).then(
      () => toast.success(t('urlCopied')),
      () => toast.error(tCommon('failedToSave')),
    );
  }

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center gap-2 mb-4">
        <MonitorSmartphone size={20} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">{t('settingsTitle')}</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-5">{t('settingsHint')}</p>

      <div className="mb-5">
        <label className="block text-sm font-medium text-foreground mb-1">{t('urlLabel')}</label>
        <div className="flex flex-wrap items-center gap-2">
          <code dir="ltr" className="flex-1 min-w-0 truncate rounded-lg border border-border bg-muted px-3 py-2 text-sm">{displayUrl}</code>
          <button type="button" onClick={copyUrl} className="inline-flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted">
            <Copy size={16} />
            {t('copyUrl')}
          </button>
          <a href={CUSTOMER_DISPLAY_PATH} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted">
            <ExternalLink size={16} />
            {t('openDisplay')}
          </a>
        </div>
      </div>

      <fieldset className="mb-5">
        <legend className="text-sm font-medium text-foreground mb-2">{t('statusesLabel')}</legend>
        <div className="flex flex-wrap gap-4">
          {CUSTOMER_DISPLAY_STATUSES.map((status) => (
            <label key={status} className="inline-flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={config.statuses.includes(status)} onChange={() => toggleStatus(status)} className="text-brand" />
              {t(STATUS_LABEL_KEYS[status])}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mb-5">
        <label htmlFor="customer-display-refresh" className="block text-sm font-medium text-foreground mb-1">{t('refreshLabel')}</label>
        <input
          id="customer-display-refresh"
          type="number"
          min={2}
          max={60}
          step={1}
          value={config.refresh_seconds}
          onChange={(e) => setConfig((prev) => ({ ...prev, refresh_seconds: Math.min(60, Math.max(2, Math.round(Number(e.target.value)) || 2)) }))}
          className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={config.show_updated} onChange={(e) => setConfig((prev) => ({ ...prev, show_updated: e.target.checked }))} className="text-brand" />
        {t('showUpdatedLabel')}
      </label>

      <div className="flex justify-end mt-5 pt-4 border-t border-border">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium text-sm"
        >
          {saving ? tCommon('saving') : tCommon('save')}
        </button>
      </div>
    </div>
  );
}
