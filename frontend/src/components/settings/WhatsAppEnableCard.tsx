'use client';

import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useI18n } from '@/hooks/useI18n';
import { usePosSettingsStore } from '@/store/pos-settings';

/**
 * Opt-in card for the WhatsApp e-billing integration. Rendered on the
 * Settings → Integrations tab when `whatsappEnabled === false` and also on
 * the WhatsApp → Connection tab as a thin link to here. The card owns its
 * own ack checkbox and enable-submit state; the parent only decides
 * whether to show it.
 */
export function WhatsAppEnableCard() {
  const { t } = useI18n();
  const setWhatsappEnabled = usePosSettingsStore((s) => s.setWhatsappEnabled);
  const [ack, setAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleEnable = async () => {
    if (!ack) {
      toast.error(t('whatsapp.enable.ackError'));
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/whatsapp/enable');
      setWhatsappEnabled(true);
      setAck(false);
      toast.success(t('whatsapp.enable.success'));
    } catch {
      toast.error(t('whatsapp.enable.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-5 py-6">
        <div className="flex items-center gap-2">
          <MessageCircle size={20} className="text-brand" />
          <div>
            <h2 className="font-semibold text-gray-900">{t('whatsapp.enable.title')}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{t('whatsapp.enable.description')}</p>
          </div>
        </div>
        <div className="rounded-md border bg-muted/40 p-4 text-sm space-y-3">
          <p>{t('whatsapp.enable.riskNote')}</p>
          <p className="text-muted-foreground">{t('whatsapp.enable.floHelps')}</p>
        </div>
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-primary"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>{t('whatsapp.enable.acknowledge')}</span>
        </label>
        <div className="flex">
          <Button onClick={handleEnable} disabled={!ack || submitting}>
            {submitting ? t('whatsapp.connect.connecting') : t('whatsapp.enable.cta')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
