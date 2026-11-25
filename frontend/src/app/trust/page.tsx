'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { Download, Lock } from 'lucide-react';

type Platform = 'windows' | 'android' | 'ios' | 'mac';

interface TrustInfo {
  https_port: number | null;
}

// Product names, not translated text.
const PLATFORM_LABELS: Record<Platform, string> = {
  windows: 'Windows',
  android: 'Android',
  ios: 'iPhone / iPad',
  mac: 'Mac',
};

const subscribeNothing = () => () => {};

function detectPlatform(): Platform {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(agent)) return 'ios';
  if (/Android/i.test(agent)) return 'android';
  if (/Macintosh|Mac OS X/i.test(agent)) return 'mac';
  return 'windows';
}

/** Public guide: serves only the public CA certificate and static instructions, never a key. */
export default function TrustPage() {
  const t = useTranslations('secureNetwork');
  const detectedPlatform = useSyncExternalStore(
    subscribeNothing,
    detectPlatform,
    () => 'windows' as Platform,
  );
  const [selectedPlatform, setSelectedPlatform] = useState<Platform | null>(null);
  const platform = selectedPlatform ?? detectedPlatform;
  const [info, setInfo] = useState<TrustInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/api/secure-network/trust-info', { cache: 'no-store' })
      .then((response) =>
        response.ok ? (response.json() as Promise<TrustInfo>) : Promise.reject(),
      )
      .then(setInfo)
      .catch(() => setFailed(true));
  }, []);

  const steps: Record<
    Platform,
    Array<
      | 'windows1'
      | 'windows2'
      | 'windows3'
      | 'android1'
      | 'android2'
      | 'ios1'
      | 'ios2'
      | 'mac1'
      | 'mac2'
    >
  > = {
    windows: ['windows1', 'windows2', 'windows3'],
    android: ['android1', 'android2'],
    ios: ['ios1', 'ios2'],
    mac: ['mac1', 'mac2'],
  };

  const secureUrl =
    info?.https_port && typeof window !== 'undefined'
      ? `https://${window.location.hostname}${info.https_port === 443 ? '' : `:${info.https_port}`}`
      : null;

  return (
    <main className="min-h-screen bg-background text-foreground flex justify-center p-6">
      <div className="w-full max-w-xl space-y-5">
        <div className="flex items-center gap-2">
          <Lock size={22} />
          <h1 className="text-xl font-semibold">{t('trustPageTitle')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('trustPageIntro')}</p>

        {failed && <p className="text-sm text-amber-700">{t('trustLoadFailed')}</p>}

        {info && (
          <>
            <p className="rounded-lg border border-amber-600 p-3 text-sm">{t('fingerprintHint')}</p>

            <button
              type="button"
              onClick={() => window.location.assign('/api/secure-network/ca.cer')}
              className="inline-flex items-center gap-2 rounded-lg bg-brand text-white px-4 py-2 text-sm font-medium"
            >
              <Download size={16} />
              {t('downloadCertificate')}
            </button>

            <div className="flex flex-wrap gap-2" role="tablist">
              {(Object.keys(PLATFORM_LABELS) as Platform[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={platform === key}
                  onClick={() => setSelectedPlatform(key)}
                  className={`rounded-full border px-3 py-1 text-sm ${platform === key ? 'bg-brand text-white border-brand' : 'border-border'}`}
                >
                  {PLATFORM_LABELS[key]}
                </button>
              ))}
            </div>

            <ol className="list-decimal ps-5 space-y-2 text-sm">
              {steps[platform].map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ol>

            {secureUrl && (
              <a href={secureUrl} className="inline-block text-sm font-medium text-brand underline">
                {t('trustContinue')}
              </a>
            )}
          </>
        )}
      </div>
    </main>
  );
}
