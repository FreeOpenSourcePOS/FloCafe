'use client';

import { LifeBuoy } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { SupportTicketForm } from '@/components/support/SupportTicketForm';

export default function SupportPage() {
  const t = useTranslations('support');

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-brand/10 p-3 text-brand"><LifeBuoy className="size-6" /></div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <SupportTicketForm />
    </div>
  );
}
