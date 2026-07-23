'use client';

import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Loader2, AlertTriangle, CheckCircle2, XCircle, QrCode, Ban, Send, Inbox, Copy, KeyRound, Info,
} from 'lucide-react';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth';
import { useI18n } from '@/hooks/useI18n';
import { useConfirm } from '@/hooks/use-confirm';
import { usePosSettingsStore } from '@/store/pos-settings';
import { formatDate, formatTime } from '@/lib/printer/format-date';
import { dialCodeFor } from '@/lib/phone';

interface WhatsAppStatus {
  enabled: boolean;
  state: 'disconnected' | 'connecting' | 'waiting_qr' | 'waiting_pairing' | 'connected' | 'cooldown';
  connectedPhone: string | null;
  lastError: string | null;
  lastErrorReason: string | null;
  cooldownUntil: string | null;
}

/** Show a backend error as a toast. Prefer the i18n reason code over the raw English fallback. */
function toastApiError(err: unknown, fallback: string, t: (k: string, p?: Record<string, string | number>) => string): void {
  const axiosErr = err as { response?: { data?: { error?: string; reason?: string } } };
  const reason = axiosErr?.response?.data?.reason;
  if (reason) {
    const key = `whatsapp.apiError.${reason}`;
    const translated = t(key);
    // t() falls back to the key itself when missing — only use it if we actually have a translation.
    if (translated !== key) {
      toast.error(translated);
      return;
    }
  }
  toast.error(axiosErr?.response?.data?.error ?? fallback);
}

interface SentMessage {
  id: number;
  phone_e164: string;
  bill_id: number | null;
  customer_id: number | null;
  direction: 'inbound' | 'outbound';
  kind: 'bill_receipt' | 'manual_reply' | 'auto_followup';
  status: string;
  body: string;
  error: string | null;
  queued_at: string;
  seen_at: string | null;
  typing_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  created_by_user_id: string | null;
}

interface InboxMessage {
  id: number;
  phone_e164: string;
  body: string;
  status: string;
  queued_at: string;
}

interface BlocklistRow {
  phone_e164: string;
  reason: string | null;
  blocked_at: string;
  blocked_by_user_id: string | null;
}

const STATE_KEYS: Record<string, string> = {
  disconnected: 'whatsapp.state.disconnected',
  connecting: 'whatsapp.state.connecting',
  waiting_qr: 'whatsapp.state.waiting_qr',
  waiting_pairing: 'whatsapp.state.waiting_pairing',
  connected: 'whatsapp.state.connected',
  cooldown: 'whatsapp.state.cooldown',
};

const STATUS_STEPS = ['queued', 'typing', 'sent', 'delivered', 'read'] as const;
type StatusStep = typeof STATUS_STEPS[number];

function stepIndex(status: string): number {
  return STATUS_STEPS.indexOf(status as StatusStep);
}

function StatusStepper({ status, t }: { status: string; t: (k: string) => string }) {
  const failed = status === 'failed';
  const current = failed ? -1 : stepIndex(status);
  return (
    <div className="flex items-center gap-1" title={failed ? t('whatsapp.status.failed') : t(`whatsapp.status.${status}`)}>
      {STATUS_STEPS.map((step, i) => {
        const reached = !failed && i <= current;
        return (
          <span
            key={step}
            className={`h-1.5 w-4 rounded-full ${reached ? 'bg-primary' : 'bg-muted'} ${i === current ? 'ring-2 ring-primary/30' : ''}`}
          />
        );
      })}
      {failed && <span className="ml-1 text-xs text-destructive">{t('whatsapp.status.failed')}</span>}
    </div>
  );
}

/**
 * Translate a backend lastError by its reason code. Falls back to the raw
 * English message when no reason is set (legacy / unknown), then to the
 * localized generic cooldown line if the raw is also empty.
 */
function translateLastError(
  reason: string | null | undefined,
  raw: string | null | undefined,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  if (reason) {
    if (reason === 'reconnecting') {
      // Extract the status code from the raw message if present.
      const m = raw?.match(/\((\d+|unknown)\)/);
      const code = m?.[1] ?? 'unknown';
      const seconds = 5;
      return t('whatsapp.lastError.reconnecting', { code, seconds });
    }
    if (reason === 'rate_limited') {
      const m = raw?.match(/\((\d+)\)/);
      const code = m?.[1] ?? '429';
      return t('whatsapp.lastError.rate_limited', { code });
    }
    const key = `whatsapp.lastError.${reason}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return raw ?? t('whatsapp.lastError.cooldown');
}

export default function WhatsAppPage() {
  const { t, language } = useI18n();
  const { confirm, ConfirmDialog } = useConfirm();
  const setWhatsappEnabled = usePosSettingsStore((s) => s.setWhatsappEnabled);
  const { currentTenant } = useAuthStore();
  const role = currentTenant?.role ?? '';
  const isAdmin = role === 'owner' || role === 'manager';

  const locale = language === 'es' ? 'es-AR' : 'en-US';
  const fmt = (iso: string | null | undefined) => formatDate(iso ?? undefined, locale);
  const fmtClock = (iso: string | null | undefined) => formatTime(iso ?? undefined, locale);

  const tenantCountry = currentTenant?.country || '';
  const dialCode = dialCodeFor(tenantCountry) || '';

  const copyToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('whatsapp.inbox.phoneCopied', { phone: label }));
    } catch {
      toast.error(t('whatsapp.inbox.copyFailed'));
    }
  };

  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingPhone, setPairingPhone] = useState(dialCode);

  const [sentMessages, setSentMessages] = useState<SentMessage[]>([]);
  const [inbox, setInbox] = useState<InboxMessage[]>([]);
  const [blocklist, setBlocklist] = useState<BlocklistRow[]>([]);
  const [blockPhone, setBlockPhone] = useState('');
  const [blockReason, setBlockReason] = useState('');

  // The user's chosen tab, or null if they have never clicked one. Persisted
  // in localStorage so the choice survives remounts — previously this was two
  // parallel useState + two localStorage keys (`tab` + `tabInitialized`) and
  // a remount could reset the flag to false and bounce the user from Inbox
  // back to Sent. Collapsed to one nullable string: null = never picked =
  // fall through to the connection-state default below.
  const [userTab, setUserTab] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('whatsapp.activeTab');
  });
  const [filterGroups, setFilterGroupsState] = useState(true);

  const refreshStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/whatsapp/status');
      setStatus(data);
      if (typeof data?.filterGroups === 'boolean') setFilterGroupsState(data.filterGroups);
    } catch {
      // ignore
    }
  }, []);

  const effectiveTab = userTab ?? (status?.state === 'connected' ? 'sent' : 'connection');
  const onTabChange = (v: string) => {
    setUserTab(v);
    if (typeof window !== 'undefined') window.localStorage.setItem('whatsapp.activeTab', v);
  };

  const refreshQr = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const { data } = await api.get('/whatsapp/qr');
      setQrDataUrl(data.dataUrl);
    } catch {
      setQrDataUrl(null);
    }
  }, [isAdmin]);

  const refreshPairing = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const { data } = await api.get('/whatsapp/pairing-code');
      setPairingCode(data.code);
    } catch {
      setPairingCode(null);
    }
  }, [isAdmin]);

  const refreshSent = useCallback(async () => {
    try {
      const { data } = await api.get('/whatsapp/messages', { params: { direction: 'outbound', limit: 100 } });
      setSentMessages(data.messages ?? []);
    } catch { /* ignore */ }
  }, []);

  const refreshInbox = useCallback(async () => {
    try {
      const { data } = await api.get('/whatsapp/inbox', { params: { limit: 100 } });
      setInbox(data.messages ?? []);
    } catch { /* ignore */ }
  }, []);

  const refreshBlocklist = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const { data } = await api.get('/whatsapp/blocklist');
      setBlocklist(data.blocklist ?? []);
    } catch { /* ignore */ }
  }, [isAdmin]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const id = setInterval(() => { void refreshStatus(); }, 5000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    if (!isAdmin) return;
    if (status?.state === 'waiting_qr') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refreshQr();
      const id = setInterval(refreshQr, 5000);
      return () => clearInterval(id);
    }
    setQrDataUrl(null);
    return undefined;
  }, [status?.state, isAdmin, refreshQr]);

  useEffect(() => {
    if (!isAdmin) return;
    if (status?.state === 'waiting_pairing') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refreshPairing();
      const id = setInterval(refreshPairing, 5000);
      return () => clearInterval(id);
    }
    setPairingCode(null);
    return undefined;
  }, [status?.state, isAdmin, refreshPairing]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshSent();
  }, [refreshSent]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshInbox();
  }, [refreshInbox]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshBlocklist();
  }, [refreshBlocklist]);

  const disableFeature = async () => {
    if (!await confirm(t('whatsapp.active.disableConfirm'), {
      title: t('whatsapp.active.disableTitle'),
      confirmLabel: t('whatsapp.active.disableCta'),
      destructive: true,
    })) return;
    try {
      await api.post('/whatsapp/disable');
      setWhatsappEnabled(false);
      toast.success(t('whatsapp.active.disabledSuccess'));
      void refreshStatus();
} catch (err) { toastApiError(err, t('whatsapp.active.disableFailed'), t);
    }
  };

  const connectQr = async () => {
    try {
      await api.post('/whatsapp/connect', { method: 'qr' });
      void refreshStatus();
} catch (err) { toastApiError(err, t('whatsapp.connect.qrFailed'), t);
    }
  };

  const connectPairing = async () => {
    if (!pairingPhone.trim()) {
      toast.error(t('whatsapp.connect.pairingPhoneRequired'));
      return;
    }
    try {
      const { data } = await api.post('/whatsapp/connect', { method: 'pairing_code', phone: pairingPhone.trim() });
      if (data?.code) setPairingCode(data.code);
      void refreshStatus();
} catch (err) { toastApiError(err, t('whatsapp.connect.pairingFailed'), t);
    }
  };

  const disconnect = async () => {
    if (!await confirm(t('whatsapp.connect.disconnectConfirm'), {
      title: t('whatsapp.connect.disconnectTitle'),
      confirmLabel: t('whatsapp.connect.disconnectCta'),
      destructive: true,
    })) return;
    try {
      await api.post('/whatsapp/disconnect');
      toast.success(t('whatsapp.connect.disconnectedSuccess'));
      void refreshStatus();
} catch (err) { toastApiError(err, t('whatsapp.connect.disconnectFailed'), t);
    }
  };

  const addBlock = async () => {
    if (!blockPhone.trim()) {
      toast.error(t('whatsapp.blocklist.phoneRequired'));
      return;
    }
    try {
      await api.post('/whatsapp/blocklist', { phone_e164: blockPhone.trim(), reason: blockReason });
      setBlockPhone('');
      setBlockReason('');
      void refreshBlocklist();
      toast.success(t('whatsapp.blocklist.addedSuccess'));
} catch (err) { toastApiError(err, t('whatsapp.blocklist.failed'), t);
    }
  };

  const removeBlock = async (phone: string) => {
    try {
      await api.delete(`/whatsapp/blocklist/${encodeURIComponent(phone)}`);
      void refreshBlocklist();
} catch (err) { toastApiError(err, t('whatsapp.blocklist.failed'), t);
    }
  };

  const blockFromInbox = async (phone: string) => {
    if (blocklist.some((b) => b.phone_e164 === phone)) {
      toast.error(t('whatsapp.blocklist.alreadyBlocked'));
      return;
    }
    try {
      await api.post('/whatsapp/blocklist', { phone_e164: phone, reason: t('whatsapp.blocklist.defaultReason') });
      void refreshBlocklist();
      void refreshInbox();
      toast.success(t('whatsapp.blocklist.fromInboxSuccess', { phone }));
    } catch (err) {
      toastApiError(err, t('whatsapp.blocklist.failed'), t);
    }
  };

  const stateLabel = (state: string) => {
    const key = STATE_KEYS[state];
    return key ? t(key) : state;
  };

  return (
    <>
      {ConfirmDialog}
      <div className="space-y-4 p-2">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('nav.whatsapp')}</h1>
        {status && (
          <Badge variant={status.state === 'connected' ? 'default' : status.state === 'cooldown' ? 'destructive' : 'secondary'}>
            {stateLabel(status.state)}
            {status.connectedPhone ? ` · ${status.connectedPhone}` : ''}
          </Badge>
        )}
      </div>

      <Tabs value={effectiveTab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="sent"><Send className="size-4" /> {t('whatsapp.tabs.sent')}</TabsTrigger>
          <TabsTrigger value="inbox"><Inbox className="size-4" /> {t('whatsapp.tabs.inbox')}</TabsTrigger>
          <TabsTrigger value="connection"><QrCode className="size-4" /> {t('whatsapp.tabs.connection')}</TabsTrigger>
        </TabsList>

        <TabsContent value="connection" className="space-y-4">
          {!status?.enabled && (
            <Card>
              <CardContent className="text-sm text-muted-foreground flex items-center justify-between gap-4 py-4">
                <span>
                  {t('whatsapp.connection.notEnabled', {
                    defaultValue: 'WhatsApp is not enabled on this tenant.',
                  })}
                </span>
                <Button asChild variant="outline" size="sm">
                  <Link href="/settings?tab=whatsapp">
                    {t('whatsapp.connection.enableInSettings', {
                      defaultValue: 'Enable in Settings',
                    })}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {status?.enabled && (
            <>
              {isAdmin && (
                <Card>
                  <CardHeader>
                    <CardTitle>{t('whatsapp.connect.title')}</CardTitle>
                    <CardDescription>{t('whatsapp.connect.description')}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {status.state === 'disconnected' && (
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
                          <div className="flex items-center gap-2">
                            <div className="flex items-center justify-center size-9 rounded-md bg-brand-light text-brand">
                              <QrCode className="size-5" />
                            </div>
                            <h3 className="font-semibold text-sm">{t('whatsapp.connect.qrMethodTitle')}</h3>
                          </div>
                          <p className="text-sm text-muted-foreground">{t('whatsapp.connect.qrMethodDescription')}</p>
                          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <div className="flex items-start gap-1.5">
                              <Info className="size-3.5 mt-0.5 shrink-0" />
                              <span>{t('whatsapp.connect.qrMethodWhere')}</span>
                            </div>
                          </div>
                          <Button onClick={connectQr} className="mt-auto w-full">
                            <QrCode className="size-4" /> {t('whatsapp.connect.startQr')}
                          </Button>
                        </div>

                        <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
                          <div className="flex items-center gap-2">
                            <div className="flex items-center justify-center size-9 rounded-md bg-brand-light text-brand">
                              <KeyRound className="size-5" />
                            </div>
                            <h3 className="font-semibold text-sm">{t('whatsapp.connect.pairingMethodTitle')}</h3>
                          </div>
                          <p className="text-sm text-muted-foreground">{t('whatsapp.connect.pairingMethodDescription')}</p>
                          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <div className="flex items-start gap-1.5">
                              <Info className="size-3.5 mt-0.5 shrink-0" />
                              <span>{t('whatsapp.connect.pairingMethodWhere')}</span>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground">{t('whatsapp.connect.pairingPhoneLabel')}</label>
                            <Input
                              value={pairingPhone}
                              onChange={(e) => setPairingPhone(e.target.value)}
                              placeholder={t('whatsapp.connect.pairingPhonePlaceholder', { dialCode: dialCode || '+CC' })}
                              inputMode="tel"
                            />
                          </div>
                          <Button onClick={connectPairing} variant="outline" className="w-full">
                            <KeyRound className="size-4" /> {t('whatsapp.connect.usePairing')}
                          </Button>
                        </div>
                      </div>
                    )}

                    {status.state === 'waiting_qr' && (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">{t('whatsapp.connect.qrInstruction')}</p>
                        {qrDataUrl ? (
                          <div className="rounded-md border p-3 inline-block bg-white">
                            <img src={qrDataUrl} alt={t('whatsapp.tabs.connection')} className="w-64 h-64" />
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t('whatsapp.connect.qrGenerating')}</div>
                        )}
                        <p className="text-xs text-muted-foreground">{t('whatsapp.connect.qrRefreshHint')}</p>
                      </div>
                    )}

                    {status.state === 'waiting_pairing' && (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">{t('whatsapp.connect.pairingInstruction')}</p>
                        {pairingCode ? (
                          <div className="text-3xl font-mono tracking-widest p-4 rounded-md bg-muted inline-block">{pairingCode}</div>
                        ) : (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t('whatsapp.connect.pairingWaiting')}</div>
                        )}
                      </div>
                    )}

                    {status.state === 'connected' && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-green-700">
                          <CheckCircle2 className="size-5" />
                          <span>{t('whatsapp.connect.connectedAs')}</span>
                          <button
                            type="button"
                            onClick={() => status.connectedPhone && copyToClipboard(status.connectedPhone, status.connectedPhone)}
                            className="inline-flex items-center gap-1 font-mono font-semibold hover:underline cursor-pointer"
                            title={t('whatsapp.inbox.copyPhone')}
                          >
                            {status.connectedPhone}
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" onClick={disconnect}>{t('whatsapp.connect.disconnectCta')}</Button>
                        </div>
                        <label className="flex items-start gap-3 text-sm cursor-pointer pt-2 border-t">
                          <input
                            type="checkbox"
                            className="mt-1 size-4 accent-primary"
                            checked={filterGroups}
                            onChange={(e) => {
                              const next = e.target.checked;
                              setFilterGroupsState(next);
                              void api.post('/whatsapp/settings', { filterGroups: next })
                                .catch(() => { setFilterGroupsState(!next); toast.error(t('common.saveFailed')); });
                            }}
                          />
                          <span className="text-muted-foreground">
                            {t('whatsapp.connect.filterGroupsLabel')}
                          </span>
                        </label>
                      </div>
                    )}

                    {status.state === 'cooldown' && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-amber-700"><AlertTriangle className="size-5" /> {translateLastError(status.lastErrorReason, status.lastError, t)}</div>
                        {status.cooldownUntil && <p className="text-xs text-muted-foreground">{t('whatsapp.connect.cooldownResumesAt', { time: fmtClock(status.cooldownUntil) })}</p>}
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" onClick={disconnect}>{t('whatsapp.connect.disconnectCta')}</Button>
                        </div>
                      </div>
                    )}

                    {status.state === 'connecting' && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t('whatsapp.connect.connecting')}</div>
                    )}

                    <div className="pt-2 border-t flex justify-end">
                      <Button variant="destructive" size="sm" onClick={disableFeature}>{t('whatsapp.active.disableCta')}</Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {!isAdmin && status.state === 'connected' && status.connectedPhone && (
                <Card>
                  <CardHeader>
                    <CardTitle>{t('whatsapp.connect.title')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2 text-green-700">
                      <CheckCircle2 className="size-5" />
                      <span>{t('whatsapp.connect.connectedAs')}</span>
                      <strong className="font-mono">{status.connectedPhone}</strong>
                    </div>
                  </CardContent>
                </Card>
              )}

              {isAdmin && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2"><Ban className="size-5" /> {t('whatsapp.blocklist.title')}</CardTitle>
                    <CardDescription>{t('whatsapp.blocklist.description')}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-2 items-end">
                      <div className="flex-1 min-w-[180px]">
                        <label className="text-xs text-gray-500">{t('whatsapp.blocklist.phoneLabel')}</label>
                        <Input
                          value={blockPhone}
                          onChange={(e) => setBlockPhone(e.target.value)}
                          placeholder={t('whatsapp.blocklist.phonePlaceholder', { dialCode: dialCode || '+CC' })}
                          inputMode="tel"
                        />
                      </div>
                      <div className="flex-1 min-w-[180px]">
                        <label className="text-xs text-gray-500">{t('whatsapp.blocklist.reasonLabel')}</label>
                        <Input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder={t('whatsapp.blocklist.reasonPlaceholder')} />
                      </div>
                      <Button onClick={addBlock}>{t('whatsapp.blocklist.addCta')}</Button>
                    </div>
                    {blocklist.length === 0 ? (
                      <p className="text-sm text-gray-500">{t('whatsapp.blocklist.empty')}</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('whatsapp.blocklist.colPhone')}</TableHead>
                            <TableHead>{t('whatsapp.blocklist.colReason')}</TableHead>
                            <TableHead>{t('whatsapp.blocklist.colWhen')}</TableHead>
                            <TableHead></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {blocklist.map((b) => (
                            <TableRow key={b.phone_e164}>
                              <TableCell className="font-mono text-sm">{b.phone_e164}</TableCell>
                              <TableCell className="text-sm text-gray-600">{b.reason ?? '—'}</TableCell>
                              <TableCell className="text-sm text-gray-600">{new Date(b.blocked_at).toLocaleString()}</TableCell>
                              <TableCell><Button size="sm" variant="ghost" onClick={() => removeBlock(b.phone_e164)}>{t('whatsapp.blocklist.removeCta')}</Button></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="sent" className="space-y-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('whatsapp.sent.title')}</CardTitle>
              <CardDescription>{t('whatsapp.sent.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {sentMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center text-sm text-muted-foreground">
                  <Send className="size-8 mb-2 opacity-40" />
                  <p className="font-medium text-foreground">{t('whatsapp.sent.empty')}</p>
                  <p className="mt-1 max-w-sm">{t('whatsapp.sent.emptyHint')}</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('whatsapp.sent.colWhen')}</TableHead>
                      <TableHead>{t('whatsapp.sent.colPhone')}</TableHead>
                      <TableHead>{t('whatsapp.sent.colKind')}</TableHead>
                      <TableHead>{t('whatsapp.sent.colStatus')}</TableHead>
                      <TableHead>{t('whatsapp.sent.colBody')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sentMessages.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmt(m.queued_at)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          <button
                            type="button"
                            onClick={() => copyToClipboard(m.phone_e164, m.phone_e164)}
                            className="hover:text-foreground transition-colors cursor-pointer"
                            title={t('whatsapp.inbox.copyPhone')}
                          >
                            {m.phone_e164}
                          </button>
                        </TableCell>
                        <TableCell className="text-xs">{t(`whatsapp.kind.${m.kind}`)}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <StatusStepper status={m.status} t={t} />
                            {m.error && <div className="text-xs text-destructive">{m.error}</div>}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm max-w-md">
                          <div className="line-clamp-3 whitespace-pre-line break-words">{m.body}</div>
                          <details className="text-xs text-muted-foreground mt-1">
                            <summary>{t('whatsapp.sent.timeline')}</summary>
                            <div>{t('whatsapp.sent.timelineQueued', { time: fmt(m.queued_at) })}</div>
                            {m.typing_at && <div>{t('whatsapp.sent.timelineTyping', { time: fmt(m.typing_at) })}</div>}
                            {m.sent_at && <div>{t('whatsapp.sent.timelineSent', { time: fmt(m.sent_at) })}</div>}
                            {m.delivered_at && <div>{t('whatsapp.sent.timelineDelivered', { time: fmt(m.delivered_at) })}</div>}
                            {m.read_at && <div>{t('whatsapp.sent.timelineRead', { time: fmt(m.read_at) })}</div>}
                            {m.failed_at && <div>{t('whatsapp.sent.timelineFailed', { time: fmt(m.failed_at) })}</div>}
                          </details>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inbox" className="space-y-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('whatsapp.inbox.title')}</CardTitle>
              <CardDescription>{t('whatsapp.inbox.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {inbox.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center text-sm text-muted-foreground">
                  <Inbox className="size-8 mb-2 opacity-40" />
                  <p className="font-medium text-foreground">{t('whatsapp.inbox.empty')}</p>
                  <p className="mt-1 max-w-sm">{t('whatsapp.inbox.emptyHint')}</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('whatsapp.sent.colWhen')}</TableHead>
                      <TableHead>{t('whatsapp.sent.colPhone')}</TableHead>
                      <TableHead>{t('whatsapp.sent.colBody')}</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inbox.map((m) => {
                      const isBlocked = blocklist.some((b) => b.phone_e164 === m.phone_e164);
                      return (
                        <TableRow key={m.id}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmt(m.queued_at)}</TableCell>
                          <TableCell className="font-mono text-xs">
                            <button
                              type="button"
                              onClick={() => copyToClipboard(m.phone_e164, m.phone_e164)}
                              className="inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
                              title={t('whatsapp.inbox.copyPhone')}
                            >
                              <Copy className="size-3 opacity-0 group-hover:opacity-100" />
                              {m.phone_e164}
                            </button>
                          </TableCell>
                          <TableCell className="text-sm whitespace-pre-line break-words max-w-md">{m.body}</TableCell>
                          <TableCell>
                            {isBlocked ? (
                              <Badge variant="secondary">{t('whatsapp.inbox.blocked')}</Badge>
                            ) : (
                              <Button size="sm" variant="outline" onClick={() => blockFromInbox(m.phone_e164)}>
                                <Ban className="size-3" /> {t('whatsapp.inbox.blockCta')}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {status?.lastError && status.state !== 'cooldown' && (
        <div className="text-sm text-red-600 flex items-center gap-1">
          <XCircle className="size-4" /> {translateLastError(status.lastErrorReason, status.lastError, t)}
        </div>
      )}
      </div>
    </>
  );
}
