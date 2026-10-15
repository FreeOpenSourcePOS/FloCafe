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

interface PosNetworkInfo {
  ip_url: string;
  mdns_url: string;
  ips_data: { url: string }[];
}

interface PairingAddresses {
  primary: string | null;
  other: string[];
}

type NetworkInfoStatus = 'loading' | 'ready' | 'error';

interface PairedDisplaysProps {
  networkInfoStatus: NetworkInfoStatus;
  primaryOrigin: string | null;
  otherOrigins: string[];
  localPreviewOrigin: string | null;
  selectedOrigin: string;
  onSelectOrigin: (origin: string) => void;
  onRetryNetworkInfo: () => void;
}

function getHttpOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isPosNetworkInfo(value: unknown): value is PosNetworkInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  return (
    getHttpOrigin(info.ip_url) !== null &&
    getHttpOrigin(info.mdns_url) !== null &&
    Array.isArray(info.ips_data) &&
    info.ips_data.every(
      (entry) => !!entry && typeof entry === 'object' && getHttpOrigin(entry.url) !== null,
    )
  );
}

function getNetworkOrigin(value: string): string | null {
  const origin = getHttpOrigin(value);
  if (!origin) return null;
  const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    hostname.startsWith('127.')
  ) {
    return null;
  }
  return origin;
}

function getPairingAddresses(info: PosNetworkInfo): PairingAddresses {
  const localOrigins = info.ips_data
    .map(({ url }) => getNetworkOrigin(url))
    .filter((origin): origin is string => origin !== null);
  const primary = getNetworkOrigin(info.ip_url) ?? localOrigins[0] ?? null;
  if (!primary) return { primary: null, other: [] };

  const other = [
    ...new Set([...localOrigins, getNetworkOrigin(info.mdns_url)].filter(Boolean)),
  ].filter((origin): origin is string => origin !== null && origin !== primary);
  return { primary, other };
}

function PairedDisplays({
  networkInfoStatus,
  primaryOrigin,
  otherOrigins,
  localPreviewOrigin,
  selectedOrigin,
  onSelectOrigin,
  onRetryNetworkInfo,
}: PairedDisplaysProps) {
  const t = useTranslations('customerDisplay');
  const { formatDateTime } = useFormatDate();
  const tSettings = useTranslations('settings');
  const [displays, setDisplays] = useState<PairedDisplay[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [pairingLink, setPairingLink] = useState<{ id: string; token: string; url: string } | null>(
    null,
  );
  const tCommon = useTranslations('common');

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

  function selectPairingAddress(origin: string) {
    onSelectOrigin(origin);
    setPairingLink((current) =>
      current
        ? {
            ...current,
            url: `${origin}${CUSTOMER_DISPLAY_PATH}#token=${encodeURIComponent(current.token)}`,
          }
        : current,
    );
  }

  async function pair() {
    if (!selectedOrigin || networkInfoStatus === 'loading') return;
    setBusy(true);
    try {
      const { data } = await api.post('/settings/customer-display/tokens', { label });
      if (typeof data?.token !== 'string') throw new Error('invalid response');
      setDisplays((prev) => [
        { id: data.id, label: data.label, created_at: data.created_at, last_seen_at: null },
        ...prev,
      ]);
      setPairingLink({
        id: data.id,
        token: data.token,
        url: `${selectedOrigin}${CUSTOMER_DISPLAY_PATH}#token=${encodeURIComponent(data.token)}`,
      });
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
      setPairingLink((prev) => (prev?.id === id ? null : prev));
      toast.success(t('revoked'));
    } catch {
      toast.error(t('revokeFailed'));
    }
  }

  async function copyLink() {
    if (!pairingLink) return;
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(pairingLink.url);
      toast.success(t('urlCopied'));
    } catch {
      toast.error(t('pairFailed'));
    }
  }

  return (
    <div className="mt-6 border-t border-border pt-5">
      <h3 className="font-semibold text-foreground">{t('pairedTitle')}</h3>
      <p className="text-sm text-muted-foreground mb-4">{t('pairedHint')}</p>

      <div className="mb-4">
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
      </div>

      {networkInfoStatus === 'error' && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-2 text-sm text-destructive"
        >
          <span>{t('networkInfoLoadFailed')}</span>
          <button type="button" onClick={onRetryNetworkInfo} className="underline">
            {tSettings('retry')}
          </button>
        </div>
      )}
      {networkInfoStatus === 'ready' && !primaryOrigin && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {t('lanPairingUnavailable')}
        </p>
      )}

      <fieldset className="mb-4 space-y-2">
        <legend className="mb-2 text-sm font-medium text-foreground">{t('urlLabel')}</legend>
        {networkInfoStatus === 'loading' && (
          <p className="text-sm text-muted-foreground">{tCommon('loading')}</p>
        )}
        {primaryOrigin && (
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="customer-display-pairing-address"
              checked={selectedOrigin === primaryOrigin}
              onChange={() => selectPairingAddress(primaryOrigin)}
              disabled={busy}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="block font-medium">{t('primaryLanAddress')}</span>
              <code dir="ltr" className="block break-all text-xs text-muted-foreground">
                {primaryOrigin}
              </code>
            </span>
          </label>
        )}
        {(otherOrigins.length > 0 || localPreviewOrigin) && (
          <details open={!primaryOrigin} className="rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              {t('otherAddresses')}
            </summary>
            <div className="mt-2 space-y-2">
              {otherOrigins.map((origin) => (
                <label key={origin} className="flex items-start gap-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name="customer-display-pairing-address"
                    checked={selectedOrigin === origin}
                    onChange={() => selectPairingAddress(origin)}
                    disabled={busy}
                    className="mt-1"
                  />
                  <code dir="ltr" className="break-all text-xs text-muted-foreground">
                    {origin}
                  </code>
                </label>
              ))}
              {localPreviewOrigin &&
                ![primaryOrigin, ...otherOrigins].includes(localPreviewOrigin) && (
                  <label className="flex items-start gap-2 text-sm text-foreground">
                    <input
                      type="radio"
                      name="customer-display-pairing-address"
                      checked={selectedOrigin === localPreviewOrigin}
                      onChange={() => selectPairingAddress(localPreviewOrigin)}
                      disabled={busy}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{t('localPreviewAddress')}</span>
                      <code dir="ltr" className="block break-all text-xs text-muted-foreground">
                        {localPreviewOrigin}
                      </code>
                    </span>
                  </label>
                )}
            </div>
          </details>
        )}
      </fieldset>

      <button
        type="button"
        onClick={pair}
        disabled={
          busy || networkInfoStatus === 'loading' || !selectedOrigin || label.trim().length === 0
        }
        className="mb-4 px-4 py-2 bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium text-sm"
      >
        {t('pairCreate')}
      </button>

      {pairingLink && (
        <div className="mb-4 rounded-lg border border-border bg-muted p-3">
          <p className="text-sm font-medium text-foreground">{t('pairedLinkTitle')}</p>
          <code dir="ltr" className="block break-all text-xs my-2">
            {pairingLink.url}
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
  const [networkInfoAttempt, setNetworkInfoAttempt] = useState(0);
  const [networkInfoStatus, setNetworkInfoStatus] = useState<NetworkInfoStatus>('loading');
  const [networkAddresses, setNetworkAddresses] = useState<PairingAddresses | null>(null);
  const [selectedOrigin, setSelectedOrigin] = useState('');
  const localPreviewOrigin =
    typeof window === 'undefined' ? null : getHttpOrigin(window.location.origin);
  const primaryOrigin = networkAddresses?.primary ?? null;
  const otherOrigins = networkAddresses?.other ?? [];
  const displayUrl = selectedOrigin ? `${selectedOrigin}${CUSTOMER_DISPLAY_PATH}` : '';

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

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/pos-info', { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        if (!isPosNetworkInfo(data)) throw new Error('invalid response');
        const addresses = getPairingAddresses(data);
        setNetworkAddresses(addresses);
        setNetworkInfoStatus('ready');
        const availableOrigins = [addresses.primary, ...addresses.other, localPreviewOrigin];
        setSelectedOrigin((current) =>
          current && availableOrigins.includes(current) ? current : addresses.primary || '',
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setNetworkAddresses(null);
        setNetworkInfoStatus('error');
        setSelectedOrigin((current) => (current === localPreviewOrigin ? current : ''));
      });
    return () => controller.abort();
  }, [networkInfoAttempt, localPreviewOrigin]);

  const dirty = JSON.stringify(config) !== JSON.stringify(saved);

  function retryNetworkInfo() {
    setNetworkInfoStatus('loading');
    setNetworkInfoAttempt((attempt) => attempt + 1);
  }

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

  async function copyUrl() {
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(displayUrl);
      toast.success(t('urlCopied'));
    } catch {
      toast.error(tCommon('failedToSave'));
    }
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
            {displayUrl || (networkInfoStatus === 'loading' ? tCommon('loading') : '')}
          </code>
          <button
            type="button"
            onClick={copyUrl}
            disabled={!displayUrl}
            className="inline-flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted"
          >
            <Copy size={16} />
            {t('copyUrl')}
          </button>
          <a
            href={displayUrl || undefined}
            aria-disabled={!displayUrl}
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
      <PairedDisplays
        networkInfoStatus={networkInfoStatus}
        primaryOrigin={primaryOrigin}
        otherOrigins={otherOrigins}
        localPreviewOrigin={localPreviewOrigin}
        selectedOrigin={selectedOrigin}
        onSelectOrigin={setSelectedOrigin}
        onRetryNetworkInfo={retryNetworkInfo}
      />
    </div>
  );
}
