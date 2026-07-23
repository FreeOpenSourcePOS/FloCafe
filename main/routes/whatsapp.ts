import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { asyncHandler } from '../middleware/async-handler';
import { getDatabase, getSettingValue, upsertSettings } from '../db';
import * as whatsapp from '../services/whatsapp';
import * as QRCode from 'qrcode';

const router = Router();

router.get('/status', requireRole('owner', 'manager', 'cashier'), (_req: Request, res: Response) => {
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

router.post('/settings', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const next = (req.body as { filterGroups?: boolean } | undefined)?.filterGroups;
  if (typeof next !== 'boolean') {
    res.status(400).json({ error: 'filterGroups must be a boolean' });
    return;
  }
  upsertSettings({ whatsapp_filter_groups: next ? 'true' : 'false' });
  res.json({ ok: true, filterGroups: next });
});

router.get('/qr', requireRole('owner', 'manager'), asyncHandler(async (_req, res) => {
  const status = whatsapp.getStatus();
  if (!status.qr) {
    res.status(404).json({ error: 'no QR available', reason: 'no_qr' });
    return;
  }
  const dataUrl = await QRCode.toDataURL(status.qr, { margin: 1, width: 320 });
  res.json({ dataUrl });
}));

router.get('/pairing-code', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  const status = whatsapp.getStatus();
  if (!status.pairingCode) {
    res.status(404).json({ error: 'no pairing code available', reason: 'no_pairing_code' });
    return;
  }
  res.json({ code: status.pairingCode });
});

router.post('/enable', requireRole('owner', 'manager'), asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId ?? null;
  const result = await whatsapp.enable(userId ?? 'unknown');
  res.json(result);
}));

router.post('/disable', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  whatsapp.disable();
  res.json({ ok: true });
});

router.post('/connect', requireRole('owner', 'manager'), asyncHandler(async (req, res) => {
  const { method, phone } = req.body ?? {};
  if (method === 'qr') {
    res.json(await whatsapp.connectWithQr());
  } else if (method === 'pairing_code') {
    if (!phone) {
      res.status(400).json({ error: 'phone required for pairing code', reason: 'phone_required_pairing' });
      return;
    }
    res.json(await whatsapp.connectWithPairingCode(String(phone)));
  } else {
    res.status(400).json({ error: 'method must be "qr" or "pairing_code"', reason: 'bad_connect_method' });
  }
}));

router.post('/disconnect', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  whatsapp.disconnect();
  res.json({ ok: true });
});

router.post('/send', requireRole('owner', 'manager', 'cashier'), asyncHandler(async (req, res) => {
  const { bill_id, phone_e164, body, kind } = req.body ?? {};
  if (!phone_e164) {
    res.status(400).json({ error: 'phone_e164 required', reason: 'phone_required' });
    return;
  }
  if (!body || typeof body !== 'string') {
    res.status(400).json({ error: 'body required', reason: 'body_required' });
    return;
  }
  const userId = (req as any).user?.userId ?? null;
  const result = await whatsapp.sendMessage({
    phoneE164: String(phone_e164),
    body: String(body),
    billId: bill_id != null ? Number(bill_id) : null,
    customerId: null,
    kind: (kind as any) || 'manual_reply',
    userId,
  });
  if (!result.ok) {
    const status = result.reason === 'not_connected' || result.reason === 'cooldown' ? 503 : 400;
    res.status(status).json({ error: result.error, reason: result.reason });
    return;
  }
  res.json({ ok: true, messageId: result.messageId });
}));

router.get('/messages', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const direction = req.query.direction === 'inbound' || req.query.direction === 'outbound' ? req.query.direction : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const phone = typeof req.query.phone === 'string' ? req.query.phone : undefined;
  const billId = req.query.bill_id != null ? Number(req.query.bill_id) : undefined;
  res.json({ messages: whatsapp.listMessages({ direction, status, phone, billId, limit, offset }) });
});

router.get('/inbox', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  res.json({ messages: whatsapp.listInbox(limit, offset) });
});

router.post('/inbox/:messageId/reply', requireRole('owner', 'manager', 'cashier'), asyncHandler(async (req, res) => {
  const { body } = req.body ?? {};
  if (!body || typeof body !== 'string') {
    res.status(400).json({ error: 'body required', reason: 'body_required' });
    return;
  }
  const db = getDatabase();
  const msg = db.prepare('SELECT phone_e164 FROM whatsapp_messages WHERE id = ? AND direction = ?')
    .get(Number(req.params.messageId), 'inbound') as { phone_e164: string } | undefined;
  if (!msg) {
    res.status(404).json({ error: 'inbound message not found', reason: 'inbound_not_found' });
    return;
  }
  const userId = (req as any).user?.userId ?? null;
  const result = await whatsapp.sendMessage({
    phoneE164: msg.phone_e164,
    body: String(body),
    billId: null,
    customerId: null,
    kind: 'manual_reply',
    userId,
  });
  if (!result.ok) {
    const status = result.reason === 'not_connected' || result.reason === 'cooldown' ? 503 : 400;
    res.status(status).json({ error: result.error, reason: result.reason });
    return;
  }
  res.json({ ok: true, messageId: result.messageId });
}));

router.get('/blocklist', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ blocklist: whatsapp.listBlocklist() });
});

router.post('/blocklist', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const { phone_e164, reason } = req.body ?? {};
  if (!phone_e164) {
    res.status(400).json({ error: 'phone_e164 required', reason: 'phone_required' });
    return;
  }
  const userId = (req as any).user?.userId ?? null;
  whatsapp.addToBlocklist(String(phone_e164), String(reason ?? ''), userId ?? 'unknown');
  res.json({ ok: true });
});

router.delete('/blocklist/:phone', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const removed = whatsapp.removeFromBlocklist(String(req.params.phone));
  if (!removed) {
    res.status(404).json({ error: 'phone not in blocklist', reason: 'phone_not_in_blocklist' });
    return;
  }
  res.json({ ok: true });
});

export const whatsappRoutes = router;
