'use client';

import { useState, useEffect } from 'react';
import { X, ArrowRightLeft, Loader2, Users, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { TABLE_STATUS_LABEL_KEYS } from '@/lib/i18n-enums';
import type { Table, Order } from '@/lib/types';
import { Ltr } from '@/components/layout/Ltr';

interface MoveTableModalProps {
  sourceTable: Table;
  tables?: Table[];
  onClose: () => void;
  onSuccess: (movedData: { sourceTable: Table; targetTable: Table; order: Order }) => void;
}

export default function MoveTableModal({
  sourceTable,
  tables: initialTables,
  onClose,
  onSuccess,
}: MoveTableModalProps) {
  const t = useTranslations('tables');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();

  const [fetchedTables, setFetchedTables] = useState<Table[]>([]);
  const [loadingFetched, setLoadingFetched] = useState<boolean>(
    !initialTables || initialTables.length === 0,
  );
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [selectedFloor, setSelectedFloor] = useState<string>('all');

  useEffect(() => {
    if (initialTables && initialTables.length > 0) return;
    let mounted = true;
    api
      .get('/tables')
      .then(({ data }) => {
        if (mounted) {
          setFetchedTables(data.tables || []);
          setLoadingFetched(false);
        }
      })
      .catch(() => {
        if (mounted) {
          toast.error(t('loadFailed'));
          setLoadingFetched(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [initialTables, t]);

  const tablesList = initialTables && initialTables.length > 0 ? initialTables : fetchedTables;
  const loadingTables = (!initialTables || initialTables.length === 0) && loadingFetched;

  const activeOrder = sourceTable.activeOrder || sourceTable.current_order;
  const sourceName =
    sourceTable.name || (sourceTable as unknown as { number?: string }).number || '';

  // Filter out source table and inactive tables
  const candidateTables = tablesList.filter(
    (tb) => tb.id !== sourceTable.id && tb.is_active !== false && (tb.is_active as unknown) !== 0,
  );

  const floorValues = [
    ...new Set(candidateTables.filter((tb) => tb.floor?.trim()).map((tb) => tb.floor!.trim())),
  ].sort((a, b) => a.localeCompare(b));

  const visibleTables =
    selectedFloor === 'all'
      ? candidateTables
      : candidateTables.filter((tb) => tb.floor?.trim() === selectedFloor);

  const selectedTarget = candidateTables.find((tb) => tb.id === selectedTargetId);

  const handleMove = async () => {
    if (!selectedTargetId || moving) return;
    setMoving(true);
    try {
      const payload: { target_table_id: string; order_id?: string } = {
        target_table_id: selectedTargetId,
      };
      if (activeOrder?.id != null) {
        payload.order_id = String(activeOrder.id);
      }
      const { data } = await api.post(`/tables/${sourceTable.id}/move-order`, payload);
      const targetName = selectedTarget?.name || data.targetTable?.name || selectedTargetId;
      toast.success(t('tableMovedSuccess', { from: sourceName, to: targetName }));
      onSuccess(data);
      onClose();
    } catch (error: unknown) {
      const errorMsg =
        (error as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        t('tableMoveFailed');
      toast.error(errorMsg);
    } finally {
      setMoving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-table-modal-title"
      data-testid="move-table-modal"
    >
      <div className="bg-card rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl border border-border">
        {/* Header */}
        <div className="flex justify-between items-center p-5 border-b border-border">
          <div>
            <h2
              id="move-table-modal-title"
              className="text-lg font-bold text-foreground flex items-center gap-2"
            >
              <ArrowRightLeft size={18} className="text-brand" />
              {t('moveOrder')}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('moveOrderDescription', { from: sourceName })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="touch-target rounded-full text-muted-foreground hover:text-foreground active:bg-muted"
            aria-label={t('cancel')}
          >
            <X size={20} />
          </button>
        </div>

        {/* Source Table Summary Banner */}
        <div className="p-4 bg-muted/60 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-brand/10 text-brand flex items-center justify-center font-bold text-sm">
              {sourceName}
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{sourceName}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Users size={12} />
                  {t('capacitySeats', { count: sourceTable.capacity })}
                </span>
                {(sourceTable.floor || sourceTable.section) && (
                  <span className="flex items-center gap-1">
                    <MapPin size={11} />
                    {[sourceTable.floor, sourceTable.section].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            </div>
          </div>
          {activeOrder && (
            <div className="text-end">
              <span className="text-xs font-semibold text-foreground">
                #<Ltr>{activeOrder.order_number}</Ltr>
              </span>
              <p className="text-sm font-bold text-brand">{fmt(Number(activeOrder.total || 0))}</p>
            </div>
          )}
        </div>

        {/* Floor Filter Tabs */}
        {floorValues.length > 1 && (
          <div className="px-5 pt-3 flex flex-wrap gap-1.5" aria-label={t('floorFilter')}>
            <button
              type="button"
              onClick={() => setSelectedFloor('all')}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                selectedFloor === 'all'
                  ? 'border-brand bg-brand text-white'
                  : 'border-border bg-card text-muted-foreground hover:border-brand hover:text-brand'
              }`}
            >
              {t('allFloors')}
            </button>
            {floorValues.map((floor) => (
              <button
                key={floor}
                type="button"
                onClick={() => setSelectedFloor(floor)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  selectedFloor === floor
                    ? 'border-brand bg-brand text-white'
                    : 'border-border bg-card text-muted-foreground hover:border-brand hover:text-brand'
                }`}
              >
                {floor}
              </button>
            ))}
          </div>
        )}

        {/* Candidate Table Grid */}
        <div className="flex-1 overflow-y-auto p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            {t('selectDestinationTable')}
          </p>

          {loadingTables ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-brand" />
            </div>
          ) : visibleTables.length === 0 ? (
            <div className="text-center py-10 text-xs text-muted-foreground">
              {t('noTablesYet')}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {visibleTables.map((tb) => {
                const isOccupied = tb.status === 'occupied';
                const isSelected = selectedTargetId === tb.id;
                const statusLabelKey = TABLE_STATUS_LABEL_KEYS[tb.status];

                return (
                  <button
                    key={tb.id}
                    type="button"
                    disabled={isOccupied || moving}
                    onClick={() => setSelectedTargetId(tb.id)}
                    className={`p-3 rounded-xl border text-start transition-all flex flex-col justify-between min-h-[82px] ${
                      isOccupied
                        ? 'opacity-40 cursor-not-allowed bg-muted/40 border-border'
                        : isSelected
                          ? 'border-brand bg-brand-light dark:bg-[var(--color-brand-light)] ring-2 ring-brand'
                          : 'border-border bg-card hover:border-brand/60'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-1 w-full">
                      <span className="font-bold text-foreground text-sm truncate">{tb.name}</span>
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${
                          isOccupied
                            ? 'bg-red-500'
                            : tb.status === 'available'
                              ? 'bg-emerald-500'
                              : 'bg-amber-500'
                        }`}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs w-full">
                      <span className="text-muted-foreground">
                        {t('capacitySeats', { count: tb.capacity })}
                      </span>
                      <span
                        className={`text-[11px] font-medium ${
                          isOccupied
                            ? 'text-red-500'
                            : tb.status === 'available'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {statusLabelKey ? t(statusLabelKey) : tb.status}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={moving}
            className="flex-1"
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            onClick={handleMove}
            disabled={!selectedTargetId || moving}
            className="flex-1"
          >
            {moving ? (
              <>
                <Loader2 size={15} className="animate-spin me-1.5" />
                {tCommon('saving')}
              </>
            ) : selectedTarget ? (
              <>
                <ArrowRightLeft size={15} className="me-1.5" />
                {t('confirmMoveOrder', { table: selectedTarget.name })}
              </>
            ) : (
              <>
                <ArrowRightLeft size={15} className="me-1.5" />
                {t('moveOrder')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
