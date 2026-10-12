'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Copy, ExternalLink, MonitorSmartphone, Trash2 } from 'lucide-react';
import { useFormatDate } from '@/hooks/useFormatDate';
import api from '@/lib/api';
import {
  CUSTOMER_DISPLAY_DEFAULTS,
  CUSTOMER_DISPLAY_PATH,
  CUSTOMER_DISPLAY_STATUSES,
  isCustomerDisplayConfig,
  type CustomerDisplayConfig,
  type CustomerDisplayStatus,
} from '@/lib/customer-display';

const STATUS_LABEL_KEYS = {
  pending: 'statusPending',
  preparing: 'statusPreparing',
  ready: 'statusReady',
} as const;

interface PairedDisplay {
  id: string;
  label: string;
  created_at: string;
  last_seen_at: string | null;
}

function PairedDisplays() {
  const t = useTranslations('customerDisplay');
  const { formatDateTime } = useFormatDate();
  const [displays, setDisplays] = useState<PairedDisplay[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [pairingLink, setPairingLink] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/settings/customer-display/tokens', { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted && Array.isArray(res.data?.tokens))
          setDisplays(res.data.tokens);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  async function pair() {
    setBusy(true);
    try {
      const { data } = await api.post('/settings/customer-display/tokens', { label });
      if (typeof data?.token !== 'string') throw new Error('invalid response');
      setDisplays((prev) => [
        { id: data.id, label: data.label, created_at: data.created_at, last_seen_at: null },
        ...prev,
      ]);
      setPairingLink(`${window.location.origin}${CUSTOMER_DISPLAY_PATH}#token=${data.token}`);
      setLabel('');
    } catch (error) {
      const limit = (error as { response?: { status?: number } })?.response?.status === 409;
      toast.error(limit ? t('tokenLimit') : t('pairFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api.delete(`/settings/customer-display/tokens/${id}`);
      setDisplays((prev) => prev.filter((display) => display.id !== id));
      toast.success(t('revoked'));
    } catch {
      toast.error(t('revokeFailed'));
    }
  }

  function copyLink() {
    if (!pairingLink) return;
    navigator.clipboard.writeText(pairingLink).then(
      () => toast.success(t('urlCopied')),
      () => toast.error(t('pairFailed')),
    );
  }

  return (
    <div className="mt-6 border-t border-border pt-5">
      <h3 className="font-semibold text-foreground">{t('pairedTitle')}</h3>
      <p className="text-sm text-muted-foreground mb-4">{t('pairedHint')}</p>

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div>
          <label
            htmlFor="customer-display-pair-label"
            className="block text-sm font-medium text-foreground mb-1"
          >
            {t('pairLabel')}
          </label>
          <input
            id="customer-display-pair-label"
            type="text"
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('pairLabelPlaceholder')}
            className="w-56 rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={pair}
          disabled={busy || label.trim().length === 0}
          className="px-4 py-2 bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium text-sm"
        >
          {t('pairCreate')}
        </button>
      </div>

      {pairingLink && (
        <div className="mb-4 rounded-lg border border-border bg-muted p-3">
          <p className="text-sm font-medium text-foreground">{t('pairedLinkTitle')}</p>
          <code dir="ltr" className="block break-all text-xs my-2">
            {pairingLink}
          </code>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={copyLink}
              className="inline-flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm hover:bg-background"
            >
              <Copy size={16} />
              {t('copyUrl')}
            </button>
            <span className="text-xs text-muted-foreground">{t('pairedLinkOnce')}</span>
          </div>
        </div>
      )}

      {displays.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pairedEmpty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {displays.map((display) => (
            <li key={display.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{display.label}</p>
                <p className="text-xs text-muted-foreground">
                  {display.last_seen_at
                    ? t('pairedLastSeen', { time: formatDateTime(display.last_seen_at) })
                    : t('pairedNeverSeen')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revoke(display.id)}
                className="inline-flex items-center gap-2 px-3 py-1.5 border border-border rounded-lg text-sm text-destructive hover:bg-muted"
              >
                <Trash2 size={16} />
                {t('revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CustomerDisplayCard() {
  const t = useTranslations('customerDisplay');
  const tCommon = useTranslations('common');
  const [config, setConfig] = useState<CustomerDisplayConfig>(CUSTOMER_DISPLAY_DEFAULTS);
  const [saved, setSaved] = useState<CustomerDisplayConfig>(CUSTOMER_DISPLAY_DEFAULTS);
  const [saving, setSaving] = useState(false);
  const displayUrl =
    typeof window === 'undefined'
      ? CUSTOMER_DISPLAY_PATH
      : `${window.location.origin}${CUSTOMER_DISPLAY_PATH}`;

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/settings/customer-display', { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted || !isCustomerDisplayConfig(res.data)) return;
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
      if (!isCustomerDisplayConfig(data)) throw new Error('invalid response');
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
          <code
            dir="ltr"
            className="flex-1 min-w-0 truncate rounded-lg border border-border bg-muted px-3 py-2 text-sm"
          >
            {displayUrl}
          </code>
          <button
            type="button"
            onClick={copyUrl}
            className="inline-flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted"
          >
            <Copy size={16} />
            {t('copyUrl')}
          </button>
          <a
            href={CUSTOMER_DISPLAY_PATH}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted"
          >
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
              <input
                type="checkbox"
                checked={config.statuses.includes(status)}
                onChange={() => toggleStatus(status)}
                className="text-brand"
              />
              {t(STATUS_LABEL_KEYS[status])}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mb-5">
        <label
          htmlFor="customer-display-refresh"
          className="block text-sm font-medium text-foreground mb-1"
        >
          {t('refreshLabel')}
        </label>
        <input
          id="customer-display-refresh"
          type="number"
          min={2}
          max={60}
          step={1}
          value={config.refresh_seconds}
          onChange={(e) =>
            setConfig((prev) => ({
              ...prev,
              refresh_seconds: Math.min(60, Math.max(2, Math.round(Number(e.target.value)) || 2)),
            }))
          }
          className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={config.show_updated}
          onChange={(e) => setConfig((prev) => ({ ...prev, show_updated: e.target.checked }))}
          className="text-brand"
        />
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
      <PairedDisplays />
    </div>
  );
}
