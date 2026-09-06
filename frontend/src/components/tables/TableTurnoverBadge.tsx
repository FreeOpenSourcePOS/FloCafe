'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { getElapsedMinutes, getTurnoverTier, splitHoursMinutes, TURNOVER_TIER_CLASSES } from '@/lib/table-timing';

/** Live "seated for Nm" badge with local 60s tick to avoid
 * parent component re-renders. */
export function TableTurnoverBadge({ seatedAt }: { seatedAt: string }) {
  const tCommon = useTranslations('common');
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const minutes = getElapsedMinutes(seatedAt);
  const tier = getTurnoverTier(minutes);
  const { h, m } = splitHoursMinutes(minutes);
  const label = h > 0 ? tCommon('timeHoursMinutes', { h, m }) : tCommon('timeMinutes', { m });

  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${TURNOVER_TIER_CLASSES[tier]}`}>
      {label}
    </span>
  );
}
