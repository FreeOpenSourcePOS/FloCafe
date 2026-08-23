'use client';

import { Fragment } from 'react';
import { Check, Minus } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  PERMISSION_CAPABILITIES,
  ROLE_DEFINITIONS,
  capabilityAllows,
} from '@shared/role-permissions';

export function PermissionMatrix() {
  const t = useTranslations('permissionMatrix');
  const tStaff = useTranslations('staff');
  const translate = (key: string) => t(key as never);
  const translateStaff = (key: string) => tStaff(key as never);
  const areas = [...new Set(PERMISSION_CAPABILITIES.map(({ area }) => area))];
  const capabilitiesByArea = areas.map((area) => ({
    area,
    capabilities: PERMISSION_CAPABILITIES.filter((capability) => capability.area === area),
  }));

  return (
    <section className="mt-8 rounded-xl border border-gray-100 bg-white p-6" aria-labelledby="permission-matrix-title">
      <div className="mb-4">
        <h2 id="permission-matrix-title" className="font-semibold text-gray-900">
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-gray-500">{t('description')}</p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-[50rem] w-full border-collapse text-sm">
          <caption className="sr-only">{t('caption')}</caption>
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="sticky start-0 z-10 min-w-64 border-b border-gray-200 bg-gray-50 px-4 py-3 text-start font-semibold text-gray-700">
                {t('capabilityHeader')}
              </th>
              {ROLE_DEFINITIONS.map((role) => (
                <th key={role.id} scope="col" className="min-w-28 border-b border-gray-200 px-3 py-3 text-center font-semibold text-gray-700">
                  <span className="block">{translateStaff(role.labelKey)}</span>
                  <span className="mt-1 block text-xs font-normal text-gray-500">{translate(role.descriptionKey)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {capabilitiesByArea.map(({ area, capabilities }) => (
              <Fragment key={area}>
                <tr>
                  <th scope="rowgroup" colSpan={ROLE_DEFINITIONS.length + 1} className="border-y border-gray-200 bg-gray-50 px-4 py-2 text-start text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {translate(`areas.${area}`)}
                  </th>
                </tr>
                {capabilities.map((capability) => (
                  <tr key={capability.id} className="border-b border-gray-100 last:border-b-0">
                    <th scope="row" className="sticky start-0 z-[1] bg-white px-4 py-3 text-start font-medium text-gray-900">
                      {translate(`capabilities.${capability.labelKey}`)}
                    </th>
                    {ROLE_DEFINITIONS.map((role) => {
                      const allowed = capabilityAllows(capability, role.id);
                      return (
                        <td key={role.id} className="px-3 py-3 text-center text-gray-700" aria-label={`${translateStaff(role.labelKey)}: ${allowed ? t('allowed') : t('notAllowed')}`}>
                          <span className="inline-flex items-center justify-center gap-1">
                            {allowed ? <Check size={16} aria-hidden="true" className="text-emerald-600" /> : <Minus size={16} aria-hidden="true" className="text-gray-400" />}
                            <span className="hidden sm:inline">{allowed ? t('allowed') : t('notAllowed')}</span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        {t('fixedNote')}
      </p>
    </section>
  );
}
