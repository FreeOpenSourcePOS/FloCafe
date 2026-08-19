'use client';

/**
 * PrinterStatus — toolbar button that shows printer connection state and
 * exposes connect / disconnect actions.
 *
 * Place it in the POS page header or sidebar header alongside other toolbar
 * icons.  Example:
 *
 *   <PrinterStatus currency={currency} />
 *
 * The `navigator.usb.requestDevice` picker is only opened on an explicit user
 * click, satisfying the browser's "transient user activation" requirement.
 */

import {
  Printer,
  PrinterCheck,
  PrinterX,
  Loader2,
  Unplug,
  ChevronDown,
  Settings,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePrinterStore, usePrinterStatusSync } from '@/hooks/usePrinter';
import type { PrinterStatus } from '@/lib/printer/PrinterService';
import toast from 'react-hot-toast';
import { useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';

type PosKey = keyof AppConfig['Messages']['pos'];

const STATUS_CONFIG: Record<
  PrinterStatus,
  { labelKey: PosKey; color: string; Icon: React.ElementType }
> = {
  disconnected: {
    labelKey: 'printerNoPrinter',
    color: 'text-gray-400',
    Icon: Printer,
  },
  connecting: {
    labelKey: 'printerConnecting',
    color: 'text-amber-500',
    Icon: Loader2,
  },
  connected: {
    labelKey: 'printerReady',
    color: 'text-green-600',
    Icon: PrinterCheck,
  },
  error: {
    labelKey: 'printerError',
    color: 'text-red-500',
    Icon: PrinterX,
  },
};

export default function PrinterStatus() {
  usePrinterStatusSync();

  const {
    status, deviceInfo, lastError,
    connect, disconnect, clearError,
    printMethod, hardwarePrinter,
  } = usePrinterStore();
  const t = useTranslations('pos');
  const router = useRouter();

  const effectiveStatus: PrinterStatus = hardwarePrinter ? 'connected' : status;
  const cfg = STATUS_CONFIG[effectiveStatus];
  const Icon = cfg.Icon;

  const handleConnect = async () => {
    clearError();
    try {
      await connect();
      if (usePrinterStore.getState().status === 'connected') {
        toast.success(t('printerConnected'));
      } else if (usePrinterStore.getState().lastError) {
        toast.error(t('printerError'));
      }
    } catch {
      toast.error(t('printerError'));
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
      toast(t('printerDisconnected'));
    } catch {
      toast.error(t('printerError'));
    }
  };

  const isConnected = !hardwarePrinter && status === 'connected';
  const isConnecting = status === 'connecting';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`h-10 flex items-center gap-1.5 ${cfg.color} border-current/30`}
        >
          <Icon
            size={16}
            className={isConnecting ? 'animate-spin' : undefined}
          />
          <span className="hidden sm:inline text-xs font-medium truncate max-w-[140px]">
            {hardwarePrinter ? hardwarePrinter.name : t(cfg.labelKey)}
          </span>
          <ChevronDown size={12} className="text-gray-400" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs text-gray-500">
          {t('printerSectionLabel')}
        </DropdownMenuLabel>

        {hardwarePrinter && (
          <div className="px-2 py-1.5 text-xs text-gray-500 border-b border-gray-100">
            <p className="font-medium text-gray-700 truncate flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              {hardwarePrinter.name}
            </p>
            <p className="capitalize">
              {hardwarePrinter.connection_type}
              {hardwarePrinter.connection_type === 'network' && hardwarePrinter.ip_address
                ? <> · <Ltr>{hardwarePrinter.ip_address}{hardwarePrinter.port ? ':' + hardwarePrinter.port : ''}</Ltr></>
                : ''}
              {hardwarePrinter.paper_width ? ` · ${hardwarePrinter.paper_width}` : ''}
            </p>
          </div>
        )}

        {isConnected && deviceInfo && (
          <div className="px-2 py-1.5 text-xs text-gray-500 border-b border-gray-100">
            <p className="font-medium text-gray-700 truncate">
              {deviceInfo.productName ?? t('printerUnknownDevice')}
            </p>
            <p><Ltr>{deviceInfo.manufacturerName ?? `VID:${deviceInfo.vendorId.toString(16).toUpperCase()}`}</Ltr></p>
          </div>
        )}

        {lastError && (
          <div className="px-2 py-1.5 text-xs text-red-600 bg-red-50 rounded mx-1 my-1">
            {t('printerError')}
          </div>
        )}

        <DropdownMenuSeparator />

        {printMethod === 'escpos' && !hardwarePrinter && (
          <>
            {!isConnected && !isConnecting && (
              <DropdownMenuItem
                onClick={handleConnect}
                disabled={isConnecting}
                className="text-sm cursor-pointer"
              >
                <Printer size={14} className="me-2" />
                {isConnecting ? t('printerConnecting') : t('printerConnectUsb')}
              </DropdownMenuItem>
            )}

            {isConnected && (
              <DropdownMenuItem
                onClick={handleDisconnect}
                className="text-sm cursor-pointer text-red-600 focus:text-red-600"
              >
                <Unplug size={14} className="me-2" />
{t('printerDisconnect')}
              </DropdownMenuItem>
            )}
          </>
        )}

        {printMethod === 'browser' && (
          <div className="px-2 py-1.5 text-xs text-gray-500">
            {t('printerBrowserMode')}
          </div>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={() => router.push('/settings?tab=receipts-printers')}
          className="text-sm cursor-pointer"
        >
          <Settings size={14} className="me-2" />
          {t('printerSettings')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
