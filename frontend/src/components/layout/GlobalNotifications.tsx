import { useEffect, useState } from 'react';
import { AlertCircle, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';

export default function GlobalNotifications() {
  const { t } = useI18n();
  const [invalidPhonesCount, setInvalidPhonesCount] = useState(0);

  useEffect(() => {
    const fetchAlerts = () => {
      api.get('/customers/alerts')
        .then(res => {
          setInvalidPhonesCount(res.data?.invalidPhonesCount || 0);
        })
        .catch(() => {});
    };

    fetchAlerts();
    const interval = setInterval(fetchAlerts, 10000);
    return () => clearInterval(interval);
  }, []);

  if (invalidPhonesCount === 0) return null;

  return (
    <div className="bg-red-50 border-b border-red-100 px-4 py-2 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-3">
        <AlertCircle className="text-red-500 w-5 h-5 shrink-0" />
        <p className="text-sm text-red-800 font-medium">
          {invalidPhonesCount} {invalidPhonesCount === 1 ? t('customers.invalidPhoneSingular', { count: invalidPhonesCount }) : t('customers.invalidPhonePlural', { count: invalidPhonesCount }) || `${invalidPhonesCount === 1 ? 'customer has' : 'customers have'} an invalid or legacy phone number format.`}
        </p>
        <Link 
          href="/customers?filter=invalid_phones" 
          className="text-sm text-red-600 hover:text-red-700 font-bold flex items-center underline underline-offset-2"
        >
          {t('common.reviewFix') || 'Review & Fix'} <ChevronRight className="w-4 h-4 ml-0.5" />
        </Link>
      </div>
    </div>
  );
}
