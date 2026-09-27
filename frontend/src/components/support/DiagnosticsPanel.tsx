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
};

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
function readDiagnostics(canViewSettings: boolean): Promise<DiagnosticsSnapshot> {
  return Promise.all([
    api.get('/diagnostics/recent'),
    api.get('/diagnostics/support-bundle'),
    readSettings(canViewSettings),
  ]).then(([recent, bundleData, settings]) => ({
    failures: recent.data.failures || [],
    bundle: bundleData.data.bundle || null,
    settings,
  }));
}

export function DiagnosticsPanel({ onCreateTicket }: { onCreateTicket?: (failure: LocalFailure) => void }) {
  const t = useTranslations('settings');
  const tSupport = useTranslations('support');
  const { currentTenant } = useAuthStore();
  // Reading local failures only needs support.use, so every staff member may
  // open this panel; the destructive and transmitting controls need
  // settings.manage, which the backend enforces on both endpoints. The role
  // lives on the tenant, which carries the signed-in user's role.
  const isOwner = currentTenant?.role === 'owner';
  const isAdmin = isOwner || tenantCan(currentTenant, 'settings.manage');
  // The transmission switch reads its state from /settings, which needs
  // settings.view; without it the value is unconfirmed and the hint says neither
  // claim rather than guessing that transmission is off.
  const canViewSettings = isOwner || tenantCan(currentTenant, 'settings.view');
  const [failures, setFailures] = useState<LocalFailure[]>([]);
  const [bundle, setBundle] = useState<SupportBundle | null>(null);
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
    if (readStartedAtSaveRef.current === savesRef.current) {
      setTransmissionEnabled(snapshot.settings.diagnostics_transmission_enabled === 'true');
    }
  }, []);

  const runRead = useCallback(() => {
    readStartedAtSaveRef.current = savesRef.current;
    return readDiagnostics(canViewSettings);
  }, [canViewSettings]);

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
          {t(savingTransmission || transmissionEnabled === null
            ? 'diagnosticsLocalOnlyHintPending'
            : transmissionEnabled ? 'diagnosticsLocalOnlyHintTransmitting' : 'diagnosticsLocalOnlyHint')}
        </p>

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
            // PUT /settings/:key requires settings.manage; a support
            // permission without it would show a working switch that 403s.
            disabled={!isAdmin}
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
