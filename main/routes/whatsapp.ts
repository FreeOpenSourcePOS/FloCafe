import { Router, Request, Response } from 'express';
import { hasPermission, requirePermission } from '../services/authorization';
import { asyncHandler } from '../middleware/async-handler';
import { getDatabase, getSettingValue, upsertSettings } from '../db';
import { isOfflineMode } from '../services/offline-mode';
import { getHttpRequestSignal, trackHttpRequestWork } from '../shutdown';
import * as whatsapp from '../services/whatsapp';
import * as QRCode from 'qrcode';
import { parsePhoneE164 } from '../lib/phone';

const router = Router();

function parsePaginationParam(value: unknown, fallback: number, max?: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || (max !== undefined && parsed > max)) return null;
  return parsed;
}

router.get('/status', requirePermission('whatsapp.use'), (_req: Request, res: Response) => {
  const s = whatsapp.getStatus();
  // Don't expose the raw QR string via /status; the QR endpoint returns a rendered image.
  res.json({
    ...s,
    qr: undefined,
    pairingCode: undefined,
    // Default ON when the row hasn't been seeded yet (existing installs that
    // were already at v29 before whatsapp_filter_groups was added).
    filterGroups: getSettingValue('whatsapp_filter_groups') !== 'false',
  });
});

router.post('/settings', requirePermission('whatsapp.manage'), (req: Request, res: Response) => {
  const next = (req.body as { filterGroups?: boolean } | undefined)?.filterGroups;
  if (typeof next !== 'boolean') {
    res.status(400).json({ error: 'filterGroups must be a boolean' });
    return;
  }
  upsertSettings({ whatsapp_filter_groups: next ? 'true' : 'false' });
  res.json({ ok: true, filterGroups: next });
});

router.get(
  '/qr',
  requirePermission('whatsapp.manage'),
  asyncHandler(async (_req, res) => {
    const status = whatsapp.getStatus();
    if (!status.qr) {
      res.status(404).json({ error: 'no QR available', reason: 'no_qr' });
      return;
    }
    const dataUrl = await QRCode.toDataURL(status.qr, { margin: 1, width: 320 });
    res.json({ dataUrl });
  }),
);

router.get(
  '/pairing-code',
  requirePermission('whatsapp.manage'),
  (_req: Request, res: Response) => {
    const status = whatsapp.getStatus();
    if (!status.pairingCode) {
      res.status(404).json({ error: 'no pairing code available', reason: 'no_pairing_code' });
      return;
    }
    res.json({ code: status.pairingCode });
  },
);

router.post(
  '/enable',
  requirePermission('whatsapp.manage'),
  asyncHandler(async (req, res) => {
    const userId = (req as any).user?.userId ?? null;
    const result = await whatsapp.enable(userId ?? 'unknown');
    res.json(result);
  }),
);

router.post('/disable', requirePermission('whatsapp.manage'), (_req: Request, res: Response) => {
  whatsapp.disable();
  res.json({ ok: true });
});

router.post(
  '/connect',
  requirePermission('whatsapp.manage'),
  asyncHandler(async (req, res) => {
    const { method, phone } = req.body ?? {};
    if (method === 'qr') {
      res.json(await trackHttpRequestWork(req, whatsapp.connectWithQr(getHttpRequestSignal(req))));
    } else if (method === 'pairing_code') {
      if (!phone) {
        res
          .status(400)
          .json({ error: 'phone required for pairing code', reason: 'phone_required_pairing' });
        return;
      }
      const tenantCountry = getSettingValue('country') || '';
      const parsedPhone = parsePhoneE164(String(phone), tenantCountry);
      if (!parsedPhone) {
        res
          .status(400)
          .json({ error: 'Valid phone number required for pairing code', reason: 'invalid_phone' });
        return;
      }
      res.json(
        await trackHttpRequestWork(
          req,
          whatsapp.connectWithPairingCode(parsedPhone.e164, getHttpRequestSignal(req)),
        ),
      );
    } else {
      res
        .status(400)
        .json({ error: 'method must be "qr" or "pairing_code"', reason: 'bad_connect_method' });
    }
  }),
);

router.post(
  '/cancel-pairing',
  requirePermission('whatsapp.manage'),
  (_req: Request, res: Response) => {
    whatsapp.cancelPairing();
    res.json({ ok: true });
  },
);

router.post('/disconnect', requirePermission('whatsapp.manage'), (_req: Request, res: Response) => {
  whatsapp.disconnect();
  res.json({ ok: true });
});

router.post(
  '/send',
  requirePermission('whatsapp.use'),
  asyncHandler(async (req, res) => {
    const { bill_id, phone_e164, body, kind } = req.body ?? {};
    if (!phone_e164) {
      res.status(400).json({ error: 'phone_e164 required', reason: 'phone_required' });
      return;
    }
    const tenantCountry = getSettingValue('country') || '';
    const parsedPhone = parsePhoneE164(String(phone_e164), tenantCountry);
    if (!parsedPhone) {
      res.status(400).json({ error: 'Valid phone_e164 required', reason: 'invalid_phone' });
      return;
    }
    if (!body || typeof body !== 'string') {
      res.status(400).json({ error: 'body required', reason: 'body_required' });
      return;
    }
    const userId = String((req as Request & { user?: { userId?: string } }).user?.userId ?? '');
    const requestedKind = (kind as string) || 'manual_reply';
    if (whatsapp.isReportMessageKind(requestedKind) && !hasPermission(userId, 'reports.view')) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: 'reports.view',
        code: 'PERMISSION_DENIED',
      });
      return;
    }
    if (
      requestedKind === 'daily_sales_report' &&
      !hasPermission(userId, 'reports.daily-sales.export')
    ) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: 'reports.daily-sales.export',
        code: 'PERMISSION_DENIED',
      });
      return;
    }
    const result = await trackHttpRequestWork(
      req,
      whatsapp.sendMessage({
        phoneE164: parsedPhone.e164,
        body: String(body),
        billId: bill_id != null ? Number(bill_id) : null,
        customerId: null,
        kind: requestedKind as whatsapp.MessageKind,
        userId: userId || null,
        signal: getHttpRequestSignal(req),
      }),
    );
    if (!result.ok) {
      const status =
        result.reason === 'not_connected' ||
        result.reason === 'cooldown' ||
        result.reason === 'offline_mode'
          ? 503
          : 400;
      res.status(status).json({ error: result.error, reason: result.reason });
      return;
    }
    res.json({ ok: true, messageId: result.messageId });
  }),
);

router.post(
  '/messages/:messageId/retry',
  requirePermission('whatsapp.use'),
  asyncHandler(async (req, res) => {
    if (isOfflineMode()) {
      res.status(503).json({
        error: 'Offline mode is on. Turn it off in Settings to use WhatsApp.',
        reason: 'offline_mode',
      });
      return;
    }
    const rawId = Number(req.params.messageId);
    if (!Number.isInteger(rawId) || rawId <= 0) {
      res.status(400).json({ error: 'messageId must be a positive integer', reason: 'not_found' });
      return;
    }
    const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
    const db = getDatabase();
    const row = db
      .prepare('SELECT kind FROM whatsapp_messages WHERE id = ? AND direction = ?')
      .get(rawId, 'outbound') as { kind: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Message not found.', reason: 'not_found' });
      return;
    }
    if (whatsapp.isReportMessageKind(row.kind) && !hasPermission(userId, 'reports.view')) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: 'reports.view',
        code: 'PERMISSION_DENIED',
      });
      return;
    }
    if (row.kind === 'daily_sales_report' && !hasPermission(userId, 'reports.daily-sales.export')) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: 'reports.daily-sales.export',
        code: 'PERMISSION_DENIED',
      });
      return;
    }
    const result = await trackHttpRequestWork(
      req,
      whatsapp.retryMessage(rawId, {
        userId: userId || null,
        signal: getHttpRequestSignal(req),
      }),
    );
    if (!result.ok) {
      const status =
        result.reason === 'not_found'
          ? 404
          : result.reason === 'not_connected' ||
              result.reason === 'cooldown' ||
              result.reason === 'offline_mode'
            ? 503
            : 400;
      res
        .status(status)
        .json({ error: result.error, reason: result.reason, messageId: result.messageId });
      return;
    }
    res.json({ ok: true, messageId: result.messageId });
  }),
);

router.get('/automation', requirePermission('whatsapp.use'), (_req: Request, res: Response) => {
  res.json({
    config: whatsapp.getAutomationConfig(),
    placeholders: whatsapp.WHATSAPP_PLACEHOLDERS,
  });
});

router.put('/automation', requirePermission('whatsapp.manage'), (req: Request, res: Response) => {
  const bodyObj =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? { ...(req.body as Record<string, unknown>) }
      : {};
  const role = (req as Request & { user?: { role?: string } }).user?.role;
  const current = whatsapp.getAutomationConfig();
  const currentZRule = current.rules.find((r) => r.trigger === 'z_report_day_close');
  const prevEnabled = Boolean(currentZRule?.enabled);
  const prevPhone = (currentZRule?.recipientPhone ?? '').trim();

  if (Array.isArray(bodyObj.rules)) {
    const incomingZRules = bodyObj.rules.filter(
      (r): r is Record<string, unknown> =>
        whatsapp.resolveWhatsAppRuleTrigger(r) === 'z_report_day_close',
    );
    let normalizedZRule: Record<string, unknown> | null = null;
    for (const incomingZRule of incomingZRules) {
      const nextEnabled =
        typeof incomingZRule.enabled === 'boolean' ? incomingZRule.enabled : prevEnabled;
      const rawPhone =
        typeof incomingZRule.recipientPhone === 'string'
          ? incomingZRule.recipientPhone.trim()
          : prevPhone;
      let normalizedPhone = '';
      if (rawPhone) {
        const parsed = parsePhoneE164(rawPhone, getSettingValue('country') || '');
        if (!parsed) {
          if (role !== 'owner' && rawPhone !== prevPhone) {
            res.status(403).json({
              error: 'Only the store owner can configure automatic Z-report delivery',
              reason: 'owner_required',
              code: 'PERMISSION_DENIED',
            });
            return;
          }
          res.status(400).json({
            error: 'Valid recipient phone in E.164 format is required',
            reason: 'invalid_phone',
          });
          return;
        }
        normalizedPhone = parsed.e164;
      }
      if ((nextEnabled !== prevEnabled || normalizedPhone !== prevPhone) && role !== 'owner') {
        res.status(403).json({
          error: 'Only the store owner can configure automatic Z-report delivery',
          reason: 'owner_required',
          code: 'PERMISSION_DENIED',
        });
        return;
      }
      if (nextEnabled && !normalizedPhone) {
        res.status(400).json({
          error: 'Recipient phone is required when automatic Z-report delivery is enabled',
          reason: 'phone_required',
        });
        return;
      }
      if (!normalizedZRule) {
        normalizedZRule = {
          ...incomingZRule,
          id: 'z_report_day_close',
          trigger: 'z_report_day_close',
          enabled: nextEnabled,
          recipientPhone: normalizedPhone,
        };
      }
    }
    const otherRules = bodyObj.rules.filter(
      (r) => whatsapp.resolveWhatsAppRuleTrigger(r) !== 'z_report_day_close',
    );
    if (role !== 'owner') {
      bodyObj.rules = currentZRule ? [...otherRules, { ...currentZRule }] : otherRules;
    } else if (normalizedZRule) {
      bodyObj.rules = [...otherRules, normalizedZRule];
    }
  }

  const config = whatsapp.saveAutomationConfig(bodyObj);
  res.json({ ok: true, config });
});

router.post(
  '/automation/broadcast',
  requirePermission('whatsapp.manage'),
  asyncHandler(async (req, res) => {
    const { template_id, min_visits, inactive_days, min_points, limit } = req.body ?? {};
    const result = await trackHttpRequestWork(
      req,
      whatsapp.runBroadcast({
        templateId: typeof template_id === 'string' ? template_id : undefined,
        minVisits: min_visits != null && min_visits !== '' ? Number(min_visits) : undefined,
        inactiveDays:
          inactive_days != null && inactive_days !== '' ? Number(inactive_days) : undefined,
        minPoints: min_points != null && min_points !== '' ? Number(min_points) : undefined,
        limit: limit != null && limit !== '' ? Number(limit) : undefined,
        signal: getHttpRequestSignal(req),
      }),
    );
    if (!result.ok) {
      const status = result.reason === 'not_connected' ? 503 : 400;
      res.status(status).json({ error: result.error, reason: result.reason });
      return;
    }
    res.json(result);
  }),
);

router.post(
  '/automation/run-sweep',
  requirePermission('whatsapp.manage'),
  asyncHandler(async (req, res) => {
    const result = await trackHttpRequestWork(req, whatsapp.runScheduledAutomationSweep());
    res.json({ ok: true, ...result });
  }),
);

router.get('/messages', requirePermission('whatsapp.use'), (req: Request, res: Response) => {
  const limitValue = parsePaginationParam(req.query.limit, 50, 200);
  const offset = parsePaginationParam(req.query.offset, 0);
  if (limitValue === null || limitValue < 1) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
  }
  if (offset === null) {
    return res.status(400).json({ error: 'offset must be a non-negative integer' });
  }
  const limit = limitValue;
  const direction =
    req.query.direction === 'inbound' || req.query.direction === 'outbound'
      ? req.query.direction
      : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const phone = typeof req.query.phone === 'string' ? req.query.phone : undefined;
  const billId = req.query.bill_id != null ? parsePaginationParam(req.query.bill_id, 0) : undefined;
  if (billId === null) {
    return res.status(400).json({ error: 'bill_id must be a non-negative integer' });
  }
  const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
  const canViewReports = hasPermission(userId, 'reports.view');
  const canExportDailySales = hasPermission(userId, 'reports.daily-sales.export');
  res.json({
    messages: whatsapp.listMessages({
      direction,
      status,
      phone,
      billId,
      limit,
      offset,
      canViewReports,
      canExportDailySales,
    }),
  });
});

router.get('/inbox', requirePermission('whatsapp.manage'), (req: Request, res: Response) => {
  const limitValue = parsePaginationParam(req.query.limit, 50, 200);
  const offset = parsePaginationParam(req.query.offset, 0);
  if (limitValue === null || limitValue < 1) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
  }
  if (offset === null) {
    return res.status(400).json({ error: 'offset must be a non-negative integer' });
  }
  const limit = limitValue;
  res.json({ messages: whatsapp.listInbox(limit, offset) });
});

router.post(
  '/inbox/:messageId/reply',
  requirePermission('whatsapp.manage'),
  asyncHandler(async (req, res) => {
    const { body } = req.body ?? {};
    if (!body || typeof body !== 'string') {
      res.status(400).json({ error: 'body required', reason: 'body_required' });
      return;
    }
    const db = getDatabase();
    const msg = db
      .prepare('SELECT phone_e164 FROM whatsapp_messages WHERE id = ? AND direction = ?')
      .get(Number(req.params.messageId), 'inbound') as { phone_e164: string } | undefined;
    if (!msg) {
      res.status(404).json({ error: 'inbound message not found', reason: 'inbound_not_found' });
      return;
    }
    const userId = (req as any).user?.userId ?? null;
    const result = await trackHttpRequestWork(
      req,
      whatsapp.sendMessage({
        phoneE164: msg.phone_e164,
        body: String(body),
        billId: null,
        customerId: null,
        kind: 'manual_reply',
        userId,
        signal: getHttpRequestSignal(req),
      }),
    );
    if (!result.ok) {
      const status =
        result.reason === 'not_connected' ||
        result.reason === 'cooldown' ||
        result.reason === 'offline_mode'
          ? 503
          : 400;
      res.status(status).json({ error: result.error, reason: result.reason });
      return;
    }
    res.json({ ok: true, messageId: result.messageId });
  }),
);

router.get('/blocklist', requirePermission('whatsapp.manage'), (_req: Request, res: Response) => {
  res.json({ blocklist: whatsapp.listBlocklist() });
});

router.post('/blocklist', requirePermission('whatsapp.manage'), (req: Request, res: Response) => {
  const { phone_e164, reason } = req.body ?? {};
  const tenantCountry = getSettingValue('country') || '';
  const parsed = parsePhoneE164(String(phone_e164 || ''), tenantCountry);
  if (!parsed) {
    res.status(400).json({ error: 'Valid phone_e164 required', reason: 'invalid_phone' });
    return;
  }
  const userId = (req as any).user?.userId ?? null;
  whatsapp.addToBlocklist(parsed.e164, String(reason ?? ''), userId ?? 'unknown');
  res.json({ ok: true });
});

router.delete(
  '/blocklist/:phone',
  requirePermission('whatsapp.manage'),
  (req: Request, res: Response) => {
    const removed = whatsapp.removeFromBlocklist(String(req.params.phone));
    if (!removed) {
      res.status(404).json({ error: 'phone not in blocklist', reason: 'phone_not_in_blocklist' });
      return;
    }
    res.json({ ok: true });
  },
);

export const whatsappRoutes = router;
