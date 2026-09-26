'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AlertTriangle, Copy, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/settings/Toggle';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import { Ltr } from '@/components/layout/Ltr';

type LocalFailure = {
  id: number;
  event_code: string;
  severity: string;
  error_class: string;
  signature: string;
  summary: string;
  occurred_at: string;
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

/** Read-only; the screen's state is applied by the caller so no effect sets state synchronously. */
function readDiagnostics(): Promise<DiagnosticsSnapshot> {
  return Promise.all([
    api.get('/diagnostics/recent'),
    api.get('/diagnostics/support-bundle'),
    api.get('/settings'),
  ]).then(([recent, bundleData, settings]) => ({
    failures: recent.data.failures || [],
    bundle: bundleData.data.bundle || null,
    settings: settings.data.settings || {},
  }));
}

export function DiagnosticsSettingsTab() {
  const t = useTranslations('settings');
  const [failures, setFailures] = useState<LocalFailure[]>([]);
  const [bundle, setBundle] = useState<SupportBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [includeLogTail, setIncludeLogTail] = useState(false);
  const [logTail, setLogTail] = useState('');
  const [transmissionEnabled, setTransmissionEnabled] = useState(false);

  const applySnapshot = useCallback((snapshot: DiagnosticsSnapshot) => {
    setFailures(snapshot.failures);
    setBundle(snapshot.bundle);
    setTransmissionEnabled(snapshot.settings.diagnostics_transmission_enabled === 'true');
  }, []);

  const reportLoadFailure = useCallback(() => toast.error(t('diagnosticsLoadFailed')), [t]);

  const refresh = useCallback(() => {
    setLoading(true);
    return readDiagnostics().then(applySnapshot).catch(reportLoadFailure).finally(() => setLoading(false));
  }, [applySnapshot, reportLoadFailure]);

  useEffect(() => {
    void readDiagnostics()
      .then(applySnapshot)
      .catch(reportLoadFailure)
      .finally(() => setLoading(false));
  }, [applySnapshot, reportLoadFailure]);

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

  async function saveSetting(key: string, value: boolean, apply: (next: boolean) => void) {
    apply(value);
    try {
      await api.put(`/settings/${key}`, { value: value ? 'true' : 'false' });
      toast.success(t('diagnosticsSettingSaved'));
    } catch {
      apply(!value);
      toast.error(t('diagnosticsSaveFailed'));
    }
  }

  async function clearFailures() {
    try {
      await api.delete('/diagnostics/recent');
      await refresh();
      toast.success(t('diagnosticsCleared'));
    } catch {
      toast.error(t('diagnosticsLoadFailed'));
    }
  }

  return (
    <SettingsTabShell>
      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center gap-2">
          <AlertTriangle size={20} className="text-muted-foreground" />
          <h2 className="font-semibold text-foreground">{t('tabDiagnostics')}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{t('diagnosticsLocalOnlyHint')}</p>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-foreground">{t('diagnosticsRecentFailures')}</h3>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={16} className="me-2" />{t('diagnosticsRefresh')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void clearFailures()} disabled={loading || failures.length === 0}>
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
                <p className="text-foreground">{failure.summary}</p>
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
            value={transmissionEnabled}
            onChange={(next) => void saveSetting('diagnostics_transmission_enabled', next, setTransmissionEnabled)}
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
