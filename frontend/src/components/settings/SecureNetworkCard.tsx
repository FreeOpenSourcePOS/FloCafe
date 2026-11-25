'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Lock, ShieldAlert } from 'lucide-react';
import api from '@/lib/api';
import { useConfirm } from '@/hooks/use-confirm';
import { useFormatDate } from '@/hooks/useFormatDate';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/settings/Toggle';
import { MasterPinPrompt } from '@/components/settings/MasterPinPrompt';
import { Ltr } from '@/components/layout/Ltr';
import { SECURE_NETWORK_DIAGNOSTIC_KEYS, type SecureNetworkDiagnostic } from '@/lib/secure-network';

interface SurfaceInfo {
  id: 'main' | 'kds' | 'serverApp';
  listening: boolean;
  primary_url: string | null;
  fallback_urls: string[];
}

interface SecureNetworkStatus {
  enabled: boolean;
  state: 'disabled' | 'starting' | 'running' | 'partial' | 'unavailable';
  error_code: string | null;
  certificate: {
    status: 'valid' | 'expiring' | 'attention' | 'missing';
    leaf_not_after: string | null;
    ca_fingerprint_sha256: string | null;
    ca_fingerprint_sha1: string | null;
  };
  surfaces: SurfaceInfo[];
  ip_change: { previous: string[]; current: string[] } | null;
  ca_regenerated: { reason: string } | null;
  trust_url: string | null;
  trust_qr_data_url: string | null;
  access_qr_data_url: string | null;
}

const SURFACE_LABEL_KEYS = {
  main: 'surfacePos',
  kds: 'surfaceKds',
  serverApp: 'surfaceServerApp',
} as const;

const STATE_LABEL_KEYS = {
  running: 'statusRunning',
  disabled: 'statusDisabled',
  starting: 'statusStarting',
  partial: 'statusPartial',
  unavailable: 'statusUnavailable',
} as const;

export function SecureNetworkCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('secureNetwork');
  const { formatDate } = useFormatDate();
  const { confirm, ConfirmDialog } = useConfirm();
  const [status, setStatus] = useState<SecureNetworkStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SecureNetworkDiagnostic[] | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<SecureNetworkStatus>('/secure-network/status');
      setStatus(data);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SecureNetworkStatus>('/secure-network/status')
      .then(({ data }) => {
        if (cancelled) return;
        setStatus(data);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (action: () => Promise<unknown>, successMessage?: string) => {
    setBusy(true);
    try {
      await action();
      if (successMessage) toast.success(successMessage);
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    if (!enabled && !(await confirm(t('disableConfirm'), { destructive: true }))) return;
    await run(() => api.put('/secure-network/enabled', { enabled }));
  };

  const runDiagnostics = async (summaryOnly: boolean) => {
    setBusy(true);
    try {
      const { data } = await api.post<{ checks: SecureNetworkDiagnostic[] }>(
        '/secure-network/diagnostics',
      );
      const healthy = data.checks.every(
        (check) => check.status !== 'fail' && check.status !== 'warn',
      );
      if (summaryOnly) {
        setDiagnostics(null);
        if (healthy) toast.success(t('testPassed'));
        else {
          toast.error(t('testFailed'));
          setDiagnostics(data.checks);
        }
      } else {
        setDiagnostics(data.checks);
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('addressCopied'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  if (loadFailed) {
    return (
      <div
        data-setting-section="secure-network"
        className="bg-card rounded-xl border border-border p-6"
      >
        <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
      </div>
    );
  }
  if (!status) return null;

  const running = status.state === 'running' || status.state === 'partial';
  const firewallCheck = diagnostics?.find(
    (check) => check.id === 'firewall' && check.status === 'warn',
  );
  const fingerprint = status.certificate.ca_fingerprint_sha256;

  return (
    <div
      data-setting-section="secure-network"
      className="bg-card rounded-xl border border-border p-6 space-y-5"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Lock size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('title')}</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{t('hint')}</p>
        </div>
        <Toggle
          value={status.enabled}
          label={t('title')}
          disabled={!canManage || busy}
          onChange={(value) => void toggle(value)}
        />
      </div>

      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        {status.state === 'running' ? (
          <CheckCircle2 size={16} className="text-green-600" />
        ) : (
          <AlertTriangle size={16} className="text-amber-600" />
        )}
        {t(STATE_LABEL_KEYS[status.state])}
        {status.certificate.status === 'valid' && status.certificate.leaf_not_after && (
          <span className="text-muted-foreground font-normal">
            · {t('certificateValidUntil', { date: formatDate(status.certificate.leaf_not_after) })}
          </span>
        )}
        {status.certificate.status === 'expiring' && (
          <span className="text-muted-foreground font-normal">· {t('certificateExpiring')}</span>
        )}
        {status.certificate.status === 'attention' && (
          <span className="text-amber-700 font-normal">· {t('certificateAttention')}</span>
        )}
      </p>

      {status.error_code === 'secure_storage_unavailable' && (
        <p className="text-sm text-amber-700 flex items-start gap-2">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          {t('noticeStorage')}
        </p>
      )}
      {status.ip_change && (
        <p className="text-sm text-amber-700 flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          {t('noticeIpChanged', {
            previous: status.ip_change.previous.filter((ip) => ip !== '127.0.0.1').join(', '),
            current: status.ip_change.current.filter((ip) => ip !== '127.0.0.1').join(', '),
          })}
        </p>
      )}
      {status.ca_regenerated && (
        <p className="text-sm text-amber-700 flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          {t('noticeCaRegenerated')}
        </p>
      )}

      {running && (
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('addressTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('addressHint')}</p>
          </div>
          {status.surfaces
            .filter((surface) => surface.listening)
            .map((surface) => (
              <div
                key={surface.id}
                className="rounded-lg bg-muted border border-border p-3 space-y-2"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(SURFACE_LABEL_KEYS[surface.id])}
                </p>
                {[surface.primary_url, ...surface.fallback_urls]
                  .filter((url): url is string => Boolean(url))
                  .map((url) => (
                    <div key={url} className="flex items-center justify-between gap-2">
                      <Ltr>
                        <code className="text-sm break-all">{url}</code>
                      </Ltr>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('copyAddress')}
                        onClick={() => void copy(url)}
                      >
                        <Copy size={14} />
                        {t('copyAddress')}
                      </Button>
                    </div>
                  ))}
              </div>
            ))}

          <div>
            <Button variant="outline" size="sm" onClick={() => setShowQr((value) => !value)}>
              {showQr ? t('hideQr') : t('showQr')}
            </Button>
            <p className="text-xs text-muted-foreground mt-1">{t('qrOptional')}</p>
            {showQr && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                {status.access_qr_data_url && (
                  <div className="flex flex-col items-center gap-2 p-3 bg-muted border border-border rounded-lg">
                    <p className="text-sm font-medium">{t('qrOpenTitle')}</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={status.access_qr_data_url}
                      alt={t('qrOpenTitle')}
                      width={160}
                      height={160}
                    />
                  </div>
                )}
                {status.trust_qr_data_url && (
                  <div className="flex flex-col items-center gap-2 p-3 bg-muted border border-border rounded-lg">
                    <p className="text-sm font-medium">{t('qrTrustTitle')}</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={status.trust_qr_data_url}
                      alt={t('qrTrustTitle')}
                      width={160}
                      height={160}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border p-3 space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{t('trustTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('trustHint')}</p>
            {fingerprint && (
              <div className="text-xs space-y-1">
                <p className="text-muted-foreground">{t('fingerprintSha256')}</p>
                <Ltr>
                  <code className="break-all">{fingerprint}</code>
                </Ltr>
                {status.certificate.ca_fingerprint_sha1 && (
                  <>
                    <p className="text-muted-foreground">{t('fingerprintSha1')}</p>
                    <Ltr>
                      <code className="break-all">{status.certificate.ca_fingerprint_sha1}</code>
                    </Ltr>
                  </>
                )}
                <p className="text-muted-foreground">{t('fingerprintHint')}</p>
              </div>
            )}
            {status.trust_url && (
              <Button variant="outline" size="sm" asChild>
                <a href={status.trust_url} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} />
                  {t('openSetupGuide')}
                </a>
              </Button>
            )}
          </div>
        </div>
      )}

      {canManage && status.enabled && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void runDiagnostics(true)}
          >
            {t('testConnection')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void runDiagnostics(false)}
          >
            {t('runDiagnostics')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => api.post('/secure-network/repair', {}), t('repairDone'))}
          >
            {t('repair')}
          </Button>
          {firewallCheck && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.post('/secure-network/repair', { fix_firewall: true }),
                  t('repairDone'),
                )
              }
            >
              {t('fixFirewall')}
            </Button>
          )}
        </div>
      )}

      {diagnostics && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{t('diagnosticsTitle')}</h3>
          <ul className="text-sm space-y-1">
            {diagnostics
              .filter((check) => SECURE_NETWORK_DIAGNOSTIC_KEYS[check.code])
              .map((check, index) => (
                <li
                  key={`${check.id}-${check.surface ?? ''}-${index}`}
                  className="flex items-start gap-2"
                >
                  {check.status === 'ok' ? (
                    <CheckCircle2 size={14} className="mt-1 text-green-600 shrink-0" />
                  ) : (
                    <AlertTriangle size={14} className="mt-1 text-amber-600 shrink-0" />
                  )}
                  <span>
                    {check.surface ? `${t(SURFACE_LABEL_KEYS[check.surface])}: ` : ''}
                    {t(SECURE_NETWORK_DIAGNOSTIC_KEYS[check.code])}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {canManage && status.enabled && (
        <div className="border-t border-border pt-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{t('resetTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('resetHint')}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              if (
                await confirm(t('resetConfirm'), {
                  destructive: true,
                  confirmLabel: t('resetTitle'),
                })
              ) {
                setResetOpen(true);
              }
            }}
          >
            {t('resetTitle')}
          </Button>
        </div>
      )}

      <MasterPinPrompt
        open={resetOpen}
        mode="verify"
        title={t('resetPinTitle')}
        description={t('resetPinDescription')}
        onCancel={() => setResetOpen(false)}
        onSubmit={async (pin) => {
          try {
            await api.post('/secure-network/reset', { master_pin: pin });
            setResetOpen(false);
            toast.success(t('resetDone'));
            await load();
            return { success: true };
          } catch (error) {
            const message = (error as { response?: { data?: { error?: string } } }).response?.data
              ?.error;
            return { success: false, error: message ?? t('saveFailed') };
          }
        }}
      />
      {ConfirmDialog}
    </div>
  );
}
