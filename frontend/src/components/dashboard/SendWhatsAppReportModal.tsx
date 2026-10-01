'use client';

import { useEffect, useState } from 'react';
import { MessageCircle, Loader2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { dialCodeFor, parsePhone } from '@/lib/phone';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface SendWhatsAppReportModalProps {
  open: boolean;
  country: string;
  canViewSettings: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (phoneE164: string) => Promise<boolean>;
}

export function SendWhatsAppReportModal({ open, country, canViewSettings, onOpenChange, onSend }: SendWhatsAppReportModalProps) {
  const t = useTranslations('dashboard');
  const tPos = useTranslations('pos');
  const tCommon = useTranslations('common');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open || !canViewSettings) return;
    let active = true;
    api.get('/settings').then(({ data }) => {
      if (!active) return;
      const savedPhone = data?.settings?.business_phone;
      if (typeof savedPhone !== 'string') return;
      const parsed = parsePhone(savedPhone, country);
      setPhone(parsed?.countryCode === dialCodeFor(country) ? parsed.digits : savedPhone);
    }).catch(() => {
      // Settings may be unavailable to a report-only role; the recipient can still be entered.
    });
    return () => { active = false; };
  }, [open, country, canViewSettings]);

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      setPhone('');
      setPhoneError(false);
    }
    onOpenChange(nextOpen);
  };

  const showCountryPrefix = !!country && !phone.trim().startsWith('+');

  const send = async () => {
    const parsed = parsePhone(phone, country);
    if (!parsed) {
      setPhoneError(true);
      return;
    }
    setPhoneError(false);
    setSending(true);
    try {
      if (await onSend(parsed.e164)) changeOpen(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle size={18} className="text-emerald-600" />
            {t('sendWhatsAppTitle')}
          </DialogTitle>
          <DialogDescription>{t('sendViaWhatsApp')}</DialogDescription>
        </DialogHeader>
        <div>
          <label htmlFor="whatsapp-report-recipient" className="mb-1 block text-sm font-medium">
            {t('recipientPhone')}
          </label>
          <div className="flex overflow-hidden rounded-md border border-input focus-within:ring-2 focus-within:ring-ring">
            {showCountryPrefix && <span className="border-e border-input bg-muted px-3 py-2 text-sm text-muted-foreground" dir="ltr">{dialCodeFor(country)}</span>}
            <input
              id="whatsapp-report-recipient"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              dir="ltr"
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                setPhoneError(false);
              }}
              aria-invalid={phoneError}
              aria-describedby={phoneError ? 'whatsapp-report-recipient-error' : undefined}
              className="min-w-0 flex-1 bg-background px-3 py-2 text-sm outline-none"
            />
          </div>
          {phoneError && (
            <p id="whatsapp-report-recipient-error" className="mt-1 text-sm text-destructive">
              {tPos('invalidPhone', { country })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={sending}>
            {tCommon('cancel')}
          </Button>
          <Button type="button" onClick={() => { void send(); }} disabled={sending}>
            {sending ? <Loader2 size={14} className="animate-spin" /> : <MessageCircle size={14} />}
            {t('sendViaWhatsApp')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
