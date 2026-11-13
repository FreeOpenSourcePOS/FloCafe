'use client';

/** Prints found on the LAN with one-click add, for the Printers settings tab. */

import { useEffect, useState } from 'react';
import { Wifi, Plus, RefreshCw, CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Ltr } from '@/components/layout/Ltr';

export type LanPrinter = {
  address: string;
  port: number;
  name: string;
  source: 'mdns' | 'port-scan' | 'both';
  model?: string;
  saved: boolean;
};

export function LanPrinterDiscovery({
  onAdd,
}: {
  onAdd: (printer: {
    name: string;
    connectionType: 'network';
    ipAddress: string;
    port: number;
  }) => Promise<boolean>;
}) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  // null while a scan runs, so the loading state needs no second flag.
  const [printers, setPrinters] = useState<LanPrinter[] | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [addingAddress, setAddingAddress] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/printers/discover', { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setPrinters(res.data.printers || []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPrinters([]);
      });
    return () => controller.abort();
  }, [scanCount]);

  const addPrinter = async (printer: LanPrinter) => {
    setAddingAddress(printer.address);
    try {
      const added = await onAdd({
        name: printer.name,
        connectionType: 'network',
        ipAddress: printer.address,
        port: printer.port,
      });
      if (!added) return;
      setPrinters(
        (prev) =>
          prev?.map((entry) =>
            entry.address === printer.address ? { ...entry, saved: true } : entry,
          ) ?? prev,
      );
    } finally {
      setAddingAddress(null);
    }
  };

  return (
    <div
      data-setting-section="printers-found-on-network"
      className="mb-5 rounded-xl border border-border p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Wifi size={14} />
          {t('foundOnNetwork')}
        </h3>
        <button
          type="button"
          onClick={() => {
            setPrinters(null);
            setScanCount((count) => count + 1);
          }}
          disabled={printers === null}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw size={14} className={printers === null ? 'animate-spin' : ''} />
          {t('scanAgain')}
        </button>
      </div>

      {printers === null ? (
        <p className="py-6 text-center text-sm text-muted-foreground" role="status">
          {t('scanningForPrinters')}
        </p>
      ) : printers.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
          {t('noNetworkPrinters')}
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {printers.map((printer) => (
            <li
              key={`${printer.address}:${printer.port}`}
              className="flex items-center gap-3 rounded-xl border border-border p-3"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Wifi size={18} className="text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{printer.name}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  <Ltr>
                    {printer.address}:{printer.port}
                  </Ltr>
                  {printer.model ? ` · ${printer.model}` : ''}
                </p>
              </div>
              {printer.saved ? (
                <span className="flex shrink-0 items-center gap-1 px-3 py-1.5 text-xs text-muted-foreground">
                  <CheckCircle2 size={14} className="text-green-500" /> {t('printerSaved')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => addPrinter(printer)}
                  disabled={addingAddress !== null}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  <Plus size={13} />{' '}
                  {addingAddress === printer.address ? t('printerAdding') : tCommon('add')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
