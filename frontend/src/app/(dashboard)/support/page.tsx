'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Bug, CheckCircle2, LifeBuoy, Loader2, MessageSquareText, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/hooks/useI18n';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useSupportTicketStatus } from '@/hooks/useSupportTicketStatus';
import { useSupportDiagnosticsPreview } from '@/hooks/useSupportDiagnosticsPreview';

type SupportProfile = {
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  restaurant_name: string;
  country: string;
  timezone: string;
  app_version: string;
  platform: string;
};

const EMPTY_PROFILE: SupportProfile = {
  contact_name: '', contact_email: '', contact_phone: '', restaurant_name: '',
  country: '', timezone: '', app_version: '', platform: '',
};

export default function SupportPage() {
  const { t } = useI18n();
  const fmtNum = useFormatNumber();
  const [profile, setProfile] = useState<SupportProfile>(EMPTY_PROFILE);
  const [category, setCategory] = useState('general');
  const [severity, setSeverity] = useState('normal');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submittedId, setSubmittedId] = useState('');
  const delivery = useSupportTicketStatus(submittedId || null);
  const diagnosticsPreview = useSupportDiagnosticsPreview(category);

  useEffect(() => {
    api.get('/support-ticket/profile')
      .then(({ data }) => setProfile({ ...EMPTY_PROFILE, ...data }))
      .catch(() => toast.error(t('support.profileLoadFailed')))
      .finally(() => setLoading(false));
  }, [t]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!subject.trim() || !message.trim()) return;
    setSubmitting(true);
    try {
      const { data } = await api.post('/support-ticket', {
        category,
        severity,
        subject: subject.trim(),
        message: message.trim(),
        contact_name: profile.contact_name.trim(),
        contact_email: profile.contact_email.trim(),
        contact_phone: profile.contact_phone.trim(),
        correlation_id: crypto.randomUUID(),
        client_ticket_id: crypto.randomUUID(),
      });
      setSubmittedId(data.client_ticket_id || '');
      setSubject('');
      setMessage('');
      toast.success(data.message || t('support.queued'));
    } catch (error) {
      const apiError = error as { response?: { data?: { error?: string } } };
      toast.error(apiError.response?.data?.error || t('support.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-brand/10 p-3 text-brand"><LifeBuoy className="size-6" /></div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('support.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('support.subtitle')}</p>
        </div>
      </div>

      {submittedId && (
        <div className="flex gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-green-900">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-medium">{t('support.requestQueued')}</p>
            {delivery.status === 'delivered' && delivery.supportCode ? (
              <>
                <p className="mt-1 text-sm font-semibold">{t('support.supportCode')}: <span className="font-mono">{delivery.supportCode}</span></p>
                <p className="mt-0.5 text-xs opacity-80">{t('support.supportCodeHint')}</p>
              </>
            ) : (
              <>
                <p className="mt-1 text-xs opacity-80">{t('support.requestId')}: {submittedId}</p>
                <p className="mt-0.5 text-xs opacity-80">
                  {delivery.status === 'failed' ? t('support.stillQueuedLocally') : t('support.confirmingDelivery')}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><MessageSquareText className="size-5" />{t('support.describeIssue')}</CardTitle>
            <CardDescription>{t('support.descriptionHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="support-category">{t('support.category')}</Label>
                <select id="support-category" value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
                  <option value="general">{t('support.categoryGeneral')}</option>
                  <option value="bug">{t('support.categoryBug')}</option>
                  <option value="printer">{t('support.categoryPrinter')}</option>
                  <option value="account">{t('support.categoryAccount')}</option>
                  <option value="tax">{t('support.categoryTax')}</option>
                  <option value="feature">{t('support.categoryFeature')}</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="support-severity">{t('support.urgency')}</Label>
                <select id="support-severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
                  <option value="low">{t('support.urgencyLow')}</option>
                  <option value="normal">{t('support.urgencyNormal')}</option>
                  <option value="high">{t('support.urgencyHigh')}</option>
                  <option value="urgent">{t('support.urgencyUrgent')}</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-subject">{t('support.subject')}</Label>
              <Input id="support-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={255} placeholder={t('support.subjectPlaceholder')} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-message">{t('support.description')}</Label>
              <textarea id="support-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={20000} rows={10} className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" placeholder={t('support.descriptionPlaceholder')} required />
              <p className="text-right text-xs text-muted-foreground">{fmtNum(message.length)} / 20,000</p>
            </div>
            <Button type="submit" disabled={loading || submitting || !subject.trim() || !message.trim()} className="w-full sm:w-auto">
              {submitting ? <Loader2 className="animate-spin" /> : <LifeBuoy />}{submitting ? t('support.submitting') : t('support.submit')}
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-base">{t('support.contactDetails')}</CardTitle><CardDescription>{t('support.contactHint')}</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg bg-muted/60 p-3 text-sm"><span className="text-muted-foreground">{t('support.restaurant')}</span><p className="font-medium">{profile.restaurant_name || '—'}</p></div>
              <div className="space-y-2"><Label htmlFor="support-name">{t('support.contactName')}</Label><Input id="support-name" value={profile.contact_name} onChange={(e) => setProfile({ ...profile, contact_name: e.target.value })} maxLength={255} /></div>
              <div className="space-y-2"><Label htmlFor="support-email">{t('support.email')}</Label><Input id="support-email" type="email" value={profile.contact_email} onChange={(e) => setProfile({ ...profile, contact_email: e.target.value })} maxLength={255} /></div>
              <div className="space-y-2"><Label htmlFor="support-phone">{t('support.phone')}</Label><Input id="support-phone" type="tel" value={profile.contact_phone} onChange={(e) => setProfile({ ...profile, contact_phone: e.target.value })} maxLength={50} /></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Bug className="size-4" />{t('support.technicalDetails')}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">{t('support.technicalHint')}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted/60 p-3 text-xs">
                <dt className="text-muted-foreground">{t('support.version')}</dt><dd>{profile.app_version || '—'}</dd>
                <dt className="text-muted-foreground">{t('support.platform')}</dt><dd>{profile.platform || '—'}</dd>
                <dt className="text-muted-foreground">{t('support.location')}</dt><dd>{[profile.country, profile.timezone].filter(Boolean).join(' · ') || '—'}</dd>
              </dl>
              <div className="flex gap-2 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-green-600" /><span>{t('support.privacyHint')}</span></div>
              {diagnosticsPreview && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">{t('support.showPayload')}</summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/60 p-2">{JSON.stringify(diagnosticsPreview, null, 2)}</pre>
                </details>
              )}
            </CardContent>
          </Card>
        </div>
      </form>
    </div>
  );
}
