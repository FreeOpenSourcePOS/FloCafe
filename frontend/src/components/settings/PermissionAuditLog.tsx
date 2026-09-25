'use client';

import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { History } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFormatDate } from '@/hooks/useFormatDate';
import type { Staff } from '@/lib/types';
import type { PermissionEffect, PermissionId } from '@shared/permissions';
import { ROLE_LABEL_KEYS } from '@/lib/i18n-enums';
import { permissionLabel } from '@/components/settings/PermissionMatrix';

type AuditRow = {
  id: number;
  batch_id: string;
  actor_user_id: string;
  actor_name: string | null;
  target_type: 'role' | 'user';
  target_id: string;
  permission_id: PermissionId;
  previous_effect: PermissionEffect | null;
  next_effect: PermissionEffect | null;
  created_at: string;
};

function errorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error) && typeof error.response?.data?.error === 'string') return error.response.data.error;
  return fallback;
}

export function PermissionAuditLog({ staff }: { staff: Staff[] }) {
  const t = useTranslations('permissionAudit');
  const tMatrix = useTranslations('permissionMatrix');
  const tStaff = useTranslations('staff');
  const tCommon = useTranslations('common');
  const { formatDateTime } = useFormatDate();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const fetchPage = useCallback((beforeId?: number) => {
    return api.get('/authorization/audit', { params: beforeId ? { before_id: beforeId } : {} });
  }, []);

  useEffect(() => {
    fetchPage()
      .then(({ data }) => {
        const audit: AuditRow[] = data.audit || [];
        setRows(audit);
        setHasMore(audit.length >= 50);
      })
      .catch((error) => toast.error(errorMessage(error, tCommon('somethingWrong'))))
      .finally(() => setLoading(false));
  }, [fetchPage, tCommon]);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const { data } = await fetchPage(last.id);
      const audit: AuditRow[] = data.audit || [];
      setRows((current) => [...current, ...audit]);
      setHasMore(audit.length >= 50);
    } catch (error) {
      toast.error(errorMessage(error, tCommon('somethingWrong')));
    } finally {
      setLoadingMore(false);
    }
  };

  const effectLabel = (effect: PermissionEffect | null): string => {
    if (effect === 'allow') return tMatrix('allow');
    if (effect === 'deny') return tMatrix('deny');
    return tMatrix('inherit');
  };

  const targetLabel = (row: AuditRow): string => {
    if (row.target_type === 'role') {
      const key = ROLE_LABEL_KEYS[row.target_id];
      return `${t('targetTypeRole')} · ${key ? tStaff(key as never) : row.target_id}`;
    }
    const member = staff.find((s) => s.id === row.target_id);
    return `${t('targetTypeUser')} · ${member?.name || row.target_id}`;
  };

  if (loading) {
    return <section className="mt-8 rounded-xl border border-border bg-card p-6">{tCommon('loading')}</section>;
  }

  return (
    <section className="mt-8 rounded-xl border border-border bg-card p-6" aria-labelledby="permission-audit-title">
      <div className="mb-5 flex items-center gap-2">
        <History size={18} className="text-muted-foreground" />
        <div>
          <h2 id="permission-audit-title" className="font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-[48rem] w-full border-collapse text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-3 text-start">{t('columnTime')}</th>
                <th className="px-4 py-3 text-start">{t('columnActor')}</th>
                <th className="px-4 py-3 text-start">{t('columnTarget')}</th>
                <th className="px-4 py-3 text-start">{t('columnPermission')}</th>
                <th className="px-4 py-3 text-start">{t('columnChange')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDateTime(row.created_at)}</td>
                  <td className="px-4 py-3">{row.actor_name || tCommon('unknown')}</td>
                  <td className="px-4 py-3">{targetLabel(row)}</td>
                  <td className="px-4 py-3"><code className="text-xs">{permissionLabel(row.permission_id)}</code></td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="text-muted-foreground">{effectLabel(row.previous_effect)}</span>
                    {' → '}
                    <span className="font-medium text-foreground">{effectLabel(row.next_effect)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50"
          >
            {loadingMore ? tCommon('loading') : t('loadMore')}
          </button>
        </div>
      )}
    </section>
  );
}
