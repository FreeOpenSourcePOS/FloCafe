'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'use-intl';

export default function AddonGroupsRedirectPage() {
  const router = useRouter();
  const t = useTranslations('common');

  useEffect(() => {
    router.replace('/products?tab=addons');
  }, [router]);

  return (
    <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
      {t('loading')}
    </div>
  );
}
