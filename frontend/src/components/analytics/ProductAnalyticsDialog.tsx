'use client';

/** Asks the owner once whether usage data may be linked to the account email. */

import { useEffect, useState } from 'react';
import { BarChart3, Bug, Check } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';

export type ProductAnalyticsLevel = 'full' | 'anonymous' | 'off';

export interface ProductAnalyticsChoice {
  level: ProductAnalyticsLevel;
  choice_pending: boolean;
  email: string | null;
  diagnostics_enabled: boolean;
}

// Dismissing without an answer asks again on the next launch, not on every navigation.
let dismissedThisLaunch = false;

export default function ProductAnalyticsDialog() {
  const t = useTranslations('productAnalytics');
  const [choice, setChoice] = useState<ProductAnalyticsChoice | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (dismissedThisLaunch) return;
    let cancelled = false;
    api
      .get<ProductAnalyticsChoice>('/settings/product-analytics')
      .then(({ data }) => {
        if (cancelled || !data?.choice_pending) return;
        setChoice(data);
        setOpen(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => {
    dismissedThisLaunch = true;
    setOpen(false);
  };

  const setErrors = async (enabled: boolean) => {
    if (!choice) return;
    const previous = choice.diagnostics_enabled;
    setChoice({ ...choice, diagnostics_enabled: enabled });
    try {
      if (enabled) await api.put('/settings/diagnostics_consent', { value: 'true' });
      await api.put('/settings/diagnostics_transmission_enabled', {
        value: enabled ? 'true' : 'false',
      });
    } catch {
      setChoice((current) => (current ? { ...current, diagnostics_enabled: previous } : current));
      toast.error(t('saveFailed'));
    }
  };

  const answer = async (level: ProductAnalyticsLevel) => {
    setSaving(true);
    try {
      await api.put('/settings/product-analytics', { level });
      close();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!choice) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="sm:max-w-lg max-h-[90vh] overflow-y-auto"
        showCloseButton={false}
        data-testid="product-analytics-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('intro')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex gap-3 rounded-lg border border-border p-3">
            <BarChart3 size={18} className="mt-0.5 shrink-0 text-brand" />
            <div>
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                {t('usageTitle')}
                <span className="inline-flex items-center gap-0.5 text-xs font-normal text-muted-foreground">
                  <Check size={12} /> {t('alreadyOn')}
                </span>
              </p>
              <p className="mt-0.5 text-muted-foreground">{t('usageBody')}</p>
            </div>
          </div>

          <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3">
            <Bug size={18} className="mt-0.5 shrink-0 text-brand" />
            <div className="flex-1">
              <p className="font-medium text-foreground">{t('errorsTitle')}</p>
              <p className="mt-0.5 text-muted-foreground">{t('errorsBody')}</p>
            </div>
            <input
              type="checkbox"
              role="switch"
              aria-checked={choice.diagnostics_enabled}
              checked={choice.diagnostics_enabled}
              disabled={saving}
              onChange={(e) => void setErrors(e.target.checked)}
              data-testid="product-analytics-errors"
              className="mt-1 h-4 w-4 shrink-0 accent-brand"
            />
          </label>

          <div className="border-t border-border pt-3">
            <p className="font-medium text-foreground">{t('stepFurther')}</p>
            <p className="mt-0.5 text-muted-foreground">
              {choice.email ? t('linkBody', { email: choice.email }) : t('fullHint')}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">{t('neverSee')}</p>
          </div>
        </div>

        <DialogFooter className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            onClick={() => void answer('full')}
            disabled={saving}
            data-testid="product-analytics-full"
          >
            {t('linkEmail')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void answer('anonymous')}
            disabled={saving}
            data-testid="product-analytics-anonymous"
          >
            {t('keepAnonymous')}
          </Button>
        </DialogFooter>
        <p className="text-center text-xs text-muted-foreground">{t('changeLater')}</p>
      </DialogContent>
    </Dialog>
  );
}
