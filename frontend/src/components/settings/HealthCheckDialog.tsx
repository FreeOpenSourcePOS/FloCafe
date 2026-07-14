'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { HealthCheckReport, HealthFinding } from '@/types/electron';
import { AlertTriangle, CheckCircle2, Wrench } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';

interface HealthCheckDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: HealthCheckReport | null;
  applying: boolean;
  onApplySafeFixes: () => void;
}

function FindingRow({ finding }: { finding: HealthFinding }) {
  return (
    <div className="rounded-lg border border-gray-100 p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-mono text-gray-900">
            {finding.table}{finding.column ? `.${finding.column}` : ''}{finding.index ? ` (index: ${finding.index})` : ''}
          </span>
          <p className="text-gray-500 mt-0.5">{finding.description}</p>
          {(finding.currentState || finding.idealState) && (
            <p className="text-xs text-gray-400 mt-1">
              {finding.currentState && <>Current: <span className="font-mono">{finding.currentState}</span>&nbsp;&nbsp;</>}
              {finding.idealState && <>Expected: <span className="font-mono">{finding.idealState}</span></>}
            </p>
          )}
          {finding.suggestedDdl && (
            <code className="block mt-2 rounded bg-gray-50 px-2 py-1 text-xs text-gray-600 overflow-x-auto">
              {finding.suggestedDdl}
            </code>
          )}
        </div>
      </div>
    </div>
  );
}

export function HealthCheckDialog({ open, onOpenChange, report, applying, onApplySafeFixes }: HealthCheckDialogProps) {
  const { t } = useI18n();
  const safeFindings = (report?.findings ?? []).filter((f) => f.risk === 'safe');
  const reviewFindings = (report?.findings ?? []).filter((f) => f.risk === 'manual_review');
  const isClean = report && report.findings.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('settings.databaseHealthCheck')}</DialogTitle>
          <DialogDescription>
            {t('settings.healthCheckDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 py-2">
          {!report && (
            <p className="text-sm text-gray-500 text-center py-10">{t('common.loading')}</p>
          )}

          {isClean && (
            <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg p-4">
              <CheckCircle2 size={18} />
              <span className="text-sm font-medium">{t('settings.healthCheckClean')}</span>
            </div>
          )}

          {safeFindings.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Wrench size={16} className="text-brand" />
                <h3 className="font-medium text-gray-900">{t('settings.healthCheckSafeHeader', { count: safeFindings.length })}</h3>
              </div>
              <div className="space-y-2">
                {safeFindings.map((f) => <FindingRow key={f.id} finding={f} />)}
              </div>
            </div>
          )}

          {reviewFindings.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={16} className="text-amber-600" />
                <h3 className="font-medium text-gray-900">{t('settings.healthCheckReviewHeader', { count: reviewFindings.length })}</h3>
              </div>
              <p className="text-xs text-gray-500 mb-2">
                {t('settings.healthCheckReviewHint')}
              </p>
              <div className="space-y-2">
                {reviewFindings.map((f) => <FindingRow key={f.id} finding={f} />)}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('settings.close')}</Button>
          {safeFindings.length > 0 && (
            <Button onClick={onApplySafeFixes} disabled={applying}>
              {applying ? t('settings.applyingFixes') : t('settings.applySafeFixes', { count: safeFindings.length })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
