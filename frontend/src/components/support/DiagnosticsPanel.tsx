'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AlertTriangle, Copy, RefreshCw, ScrollText, Ticket, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/settings/Toggle';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import { Ltr } from '@/components/layout/Ltr';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';

export type LocalFailure = {
  id: number;
  event_code: string;
  severity: string;
  error_class: string;
  signature: string;
  summary: string;
  occurred_at: string;
  metadata?: Record<string, unknown> | null;
};

type SupportBundle = {
  system: Record<string, unknown>;
  recent_failures: Array<{
    occurred_at: string;
    event_code: string;
    severity: string;
    signature: string;
    summary: string;
  }>;
};

type DiagnosticsSnapshot = {
  failures: LocalFailure[];
  bundle: SupportBundle | null;
  settings: Record<string, string>;
  health: DiagnosticsHealth | null;
};

type DiagnosticsHealth = {
  effective_consent: boolean;
  transmission_enabled: boolean;
  consent_sync_pending: boolean;
  delayed: boolean;
  transport: 'signed' | 'anonymous' | 'local' | 'disabled';
  pending_reports: number;
  pending_occurrences: number;
  pending_aggregates: number;
  pending_aggregate_occurrences: number;
  permanently_rejected_reports: number;
  gaps: Array<{ reason_code: 'queue_eviction' | 'permanent_rejection' | 'invalid_ack' | 'report_id_mismatch' | 'local_retention'; count: number }>;
};

const GAP_REASONS = ['queue_eviction', 'permanent_rejection', 'invalid_ack', 'report_id_mismatch', 'local_retention'] as const;
const TRANSPORT_LABEL_KEYS = {
  signed: 'diagnosticsTransportSigned',
  anonymous: 'diagnosticsTransportAnonymous',
  local: 'diagnosticsTransportLocal',
  disabled: 'diagnosticsTransportDisabled',
} as const;
const GAP_LABEL_KEYS = {
  queue_eviction: 'diagnosticsGapQueueEviction',
  permanent_rejection: 'diagnosticsGapPermanentRejection',
  invalid_ack: 'diagnosticsGapInvalidAck',
  report_id_mismatch: 'diagnosticsGapReportMismatch',
  local_retention: 'diagnosticsGapLocalRetention',
} as const;

function parseDiagnosticsHealth(value: unknown): DiagnosticsHealth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const countKeys = ['pending_reports', 'pending_occurrences', 'pending_aggregates', 'pending_aggregate_occurrences', 'permanently_rejected_reports'] as const;
  if (typeof raw.effective_consent !== 'boolean'
    || typeof raw.transmission_enabled !== 'boolean'
    || typeof raw.consent_sync_pending !== 'boolean'
    || typeof raw.delayed !== 'boolean'
    || typeof raw.transport !== 'string'
    || !['signed', 'anonymous', 'local', 'disabled'].includes(raw.transport)
    || countKeys.some((key) => !Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)
    || !Array.isArray(raw.gaps)) return null;
  const gaps = raw.gaps.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const gap = item as Record<string, unknown>;
    if (typeof gap.reason_code !== 'string' || !GAP_REASONS.includes(gap.reason_code as typeof GAP_REASONS[number])
      || !Number.isSafeInteger(gap.count) || Number(gap.count) < 0) return [];
    return [{ reason_code: gap.reason_code as DiagnosticsHealth['gaps'][number]['reason_code'], count: Number(gap.count) }];
  });
  return {
    effective_consent: raw.effective_consent,
    transmission_enabled: raw.transmission_enabled,
    consent_sync_pending: raw.consent_sync_pending,
    delayed: raw.delayed,
    transport: raw.transport as DiagnosticsHealth['transport'],
    pending_reports: Number(raw.pending_reports),
    pending_occurrences: Number(raw.pending_occurrences),
    pending_aggregates: Number(raw.pending_aggregates),
    pending_aggregate_occurrences: Number(raw.pending_aggregate_occurrences),
    permanently_rejected_reports: Number(raw.permanently_rejected_reports),
    gaps,
  };
}

function readSettings(canViewSettings: boolean): Promise<Record<string, string>> {
  if (!canViewSettings) return Promise.resolve({});
  return api.get('/settings')
    .then(({ data }) => data.settings || {})
    // A read the staff member is not allowed to make must not take the failures
    // and the bundle down with it; any other failure is a real one to report.
    .catch((error: { response?: { status?: number } }) => {
      if (error?.response?.status === 401 || error?.response?.status === 403) return {};
      throw error;
    });
}

/** Read-only; the screen's state is applied by the caller so no effect sets state synchronously. */
function readDiagnostics(canViewSettings: boolean, canViewHealth: boolean): Promise<DiagnosticsSnapshot> {
  return Promise.all([
    api.get('/diagnostics/recent'),
    api.get('/diagnostics/support-bundle'),
    readSettings(canViewSettings),
    canViewHealth ? api.get('/diagnostics/health').catch((error: { response?: { status?: number } }) => {
      if (error?.response?.status === 401 || error?.response?.status === 403) return null;
      throw error;
    }) : Promise.resolve(null),
  ]).then(([recent, bundleData, settings, healthData]) => ({
    failures: recent.data.failures || [],
    bundle: bundleData.data.bundle || null,
    settings,
    health: parseDiagnosticsHealth(healthData?.data),
  }));
}

export function DiagnosticsPanel({ onCreateTicket }: { onCreateTicket?: (failure: LocalFailure) => void }) {
  const t = useTranslations('settings');
  const tSupport = useTranslations('support');
  const { currentTenant } = useAuthStore();
  // Clear Failures and the transmission toggle need settings.manage, which the
  // backend re-resolves live, overrides on an owner included, so that is the gate.
  const isAdmin = tenantCan(currentTenant, 'settings.manage');
  // The switch reads its state from /settings, which needs settings.view; without
  // it the value stays unconfirmed rather than guessed to be off.
  const canViewSettings = tenantCan(currentTenant, 'settings.view');
  const canViewHealth = tenantCan(currentTenant, 'support.use');
  const [failures, setFailures] = useState<LocalFailure[]>([]);
  const [bundle, setBundle] = useState<SupportBundle | null>(null);
  const [health, setHealth] = useState<DiagnosticsHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [includeLogTail, setIncludeLogTail] = useState(false);
  const [logTail, setLogTail] = useState('');
  // null until the server has confirmed the value, so the screen never asserts
  // either claim on a state it has not been told.
  const [transmissionEnabled, setTransmissionEnabled] = useState<boolean | null>(null);
  const [savingTransmission, setSavingTransmission] = useState(false);
  // A read that started before a save must not overwrite the saved value, or a
  // late response puts the switch back to off while the backend transmits.
  const savesRef = useRef(0);
  const readStartedAtSaveRef = useRef(0);

  const applySnapshot = useCallback((snapshot: DiagnosticsSnapshot) => {
    setFailures(snapshot.failures);
    setBundle(snapshot.bundle);
    setHealth(snapshot.health);
    if (readStartedAtSaveRef.current === savesRef.current) {
      // Absent means the read was refused or not permitted, and null keeps the
      // hint off both claims; false would claim nothing is sent while it is.
      const raw = snapshot.settings.diagnostics_transmission_enabled;
      setTransmissionEnabled(typeof raw === 'string' ? raw === 'true' : snapshot.health?.transmission_enabled ?? null);
    }
  }, []);

  const runRead = useCallback(() => {
    readStartedAtSaveRef.current = savesRef.current;
    return readDiagnostics(canViewSettings, canViewHealth);
  }, [canViewSettings, canViewHealth]);

  const reportLoadFailure = useCallback(() => toast.error(t('diagnosticsLoadFailed')), [t]);

  const refresh = useCallback(() => {
    setLoading(true);
    return runRead().then(applySnapshot).catch(reportLoadFailure).finally(() => setLoading(false));
  }, [applySnapshot, reportLoadFailure, runRead]);

  useEffect(() => {
    void runRead()
      .then(applySnapshot)
      .catch(reportLoadFailure)
      .finally(() => setLoading(false));
  }, [applySnapshot, reportLoadFailure, runRead]);

  async function toggleLogTail(next: boolean) {
    setIncludeLogTail(next);
    if (!next) {
      setLogTail('');
      return;
    }
    const result = await window.electronAPI?.getLogTail?.().catch(() => null);
    if (result && 'text' in result) setLogTail(result.text);
  }

  /** Exactly what the copy action puts on the clipboard, and exactly what is rendered below. */
  const bundleText = useCallback(() => {
    if (!bundle) return '';
    const base = JSON.stringify(bundle, null, 2);
    if (!includeLogTail || !logTail) return base;
    return `${base}\n\n${t('diagnosticsLogTailLabel')}\n${logTail}`;
  }, [bundle, includeLogTail, logTail, t]);

  async function copyForSupport() {
    const text = bundleText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('diagnosticsCopied'));
    } catch {
      toast.error(t('diagnosticsCopyFailed'));
    }
  }

  async function setTransmission(next: boolean) {
    setSavingTransmission(true);
    try {
      await api.put('/settings/diagnostics_transmission_enabled', { value: next ? 'true' : 'false' });
      // Only now is the state known, so the hint may make a claim again, and any
      // read already in flight loses to the value just confirmed.
      savesRef.current += 1;
      setTransmissionEnabled(next);
      toast.success(t('diagnosticsSettingSaved'));
      void refresh();
    } catch {
      toast.error(t('diagnosticsSaveFailed'));
    } finally {
      setSavingTransmission(false);
    }
  }

  async function clearFailures() {
    try {
      await api.delete('/diagnostics/recent');
      // Drop the snapshot immediately: a failed refresh must not leave deleted
      // failures on screen under a "cleared" message.
      setFailures([]);
      setBundle((current) => (current ? { ...current, recent_failures: [] } : current));
      await refresh();
      toast.success(t('diagnosticsCleared'));
    } catch {
      toast.error(t('diagnosticsLoadFailed'));
    }
  }

  return (
    <SettingsTabShell maxWidth="wide">
      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center gap-2">
          <AlertTriangle size={20} className="text-muted-foreground" />
          <h2 className="font-semibold text-foreground">{tSupport('tabDiagnostics')}</h2>
        </div>
        {/* Either claim is only true once the server has confirmed the setting,
            so an unconfirmed state gets a sentence that asserts neither. */}
        <p className="text-sm text-muted-foreground">
          {t(savingTransmission || health === null || health.consent_sync_pending
            ? 'diagnosticsLocalOnlyHintPending'
            : health.effective_consent && health.transmission_enabled && ['signed', 'anonymous'].includes(health.transport)
              ? 'diagnosticsLocalOnlyHintTransmitting'
              : 'diagnosticsLocalOnlyHint')}
        </p>

        {health && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3 text-xs" data-testid="diagnostics-health">
            {health.consent_sync_pending && <p>{t('diagnosticsConsentSyncPending')}</p>}
            <p>{t('diagnosticsTransportState', { transport: t(TRANSPORT_LABEL_KEYS[health.transport]) })}</p>
            {health.delayed && <p>{t('diagnosticsDeliveryDelayed', {
              reports: health.pending_reports,
              occurrences: health.pending_occurrences,
              aggregates: health.pending_aggregates,
              aggregateOccurrences: health.pending_aggregate_occurrences,
            })}</p>}
            {health.permanently_rejected_reports > 0 && <p>{t('diagnosticsPermanentRejections', { count: health.permanently_rejected_reports })}</p>}
            {health.gaps.filter((gap) => gap.count > 0).map((gap) => (
              <p key={gap.reason_code}>{gap.reason_code === 'local_retention'
                ? t('diagnosticsLocalRetentionGap', { count: gap.count })
                : t('diagnosticsGapCount', { reason: t(GAP_LABEL_KEYS[gap.reason_code]), count: gap.count })}</p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-foreground">{t('diagnosticsRecentFailures')}</h3>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={16} className="me-2" />{t('diagnosticsRefresh')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              // The endpoint requires settings.manage; without it the control
              // would be a button that 403s and looks broken.
              disabled={!isAdmin || loading || failures.length === 0}
              onClick={() => void clearFailures()}
            >
              <Trash2 size={16} className="me-2" />{t('diagnosticsClear')}
            </Button>
          </div>
        </div>

        {failures.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('diagnosticsNoFailures')}</p>
        ) : (
          <ul className="space-y-2">
            {failures.map((failure) => (
              <li key={failure.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-foreground">{failure.summary}</p>
                  {onCreateTicket && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => onCreateTicket(failure)}
                    >
                      <Ticket size={16} className="me-2" />{tSupport('diagnosticsCreateTicket')}
                    </Button>
                  )}
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground ltr-island">{failure.signature}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  <Ltr>{failure.occurred_at}</Ltr> · <Ltr>{failure.event_code}</Ltr>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">{t('diagnosticsSupportBundle')}</h3>
          <Button size="sm" onClick={() => void copyForSupport()} disabled={!bundle}>
            <Copy size={16} className="me-2" />{t('diagnosticsCopyForSupport')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('diagnosticsBundleHint')}</p>

        <div className="flex items-start gap-3">
          <Toggle
            value={includeLogTail}
            onChange={(next) => void toggleLogTail(next)}
            label={t('diagnosticsIncludeLogTail')}
          />
          <p className="text-xs text-muted-foreground">{t('diagnosticsIncludeLogTailHint')}</p>
        </div>

        <pre
          data-testid="diagnostics-bundle-preview"
          className="max-h-80 overflow-auto rounded-lg border border-border bg-muted p-3 text-xs ltr-island"
        >
          {bundleText() || t('diagnosticsBundleEmpty')}
        </pre>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">{t('diagnosticsTransmission')}</h3>

        <div className="flex items-start gap-3">
          <Toggle
            value={transmissionEnabled === true}
            // Do not let an unconfirmed value masquerade as off in the switch.
            disabled={!isAdmin || transmissionEnabled === null}
            onChange={(next) => void setTransmission(next)}
            label={t('diagnosticsSendAutomatically')}
          />
          <p className="text-xs text-muted-foreground">{t('diagnosticsSendAutomaticallyHint')}</p>
        </div>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ScrollText size={14} className="mt-0.5 shrink-0" />
          {t('diagnosticsTicketUnaffected')}
        </p>
      </div>
    </SettingsTabShell>
  );
}
