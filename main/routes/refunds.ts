import { createHash } from 'crypto';
import { Router, Request, Response } from 'express';
import { getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { checkPinRateLimit } from './orders';
import { createRefund, RefundRequest } from '../services/refund';

const router = Router();
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_REASON_LENGTH = 500;

function refundIdempotencyKey(req: Request): string | null {
  const supplied = req.get('Idempotency-Key')?.trim();
  if (!supplied) return null;
  if (supplied.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(supplied)) {
    throw Object.assign(new Error('Idempotency-Key is invalid or too long'), { statusCode: 400 });
  }
  return supplied;
}

function refundRequestHash(billId: string, body: any): string {
  return createHash('sha256').update(JSON.stringify({
    billId,
    order_item_id: body.order_item_id ?? null,
    amount: body.amount ?? null,
    method: body.method ?? null,
    reason: body.reason ?? null,
    shift_id: body.shift_id ?? null,
  })).digest('hex');
}

function refundAmountCents(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw Object.assign(new Error('Refund amount must be a finite number greater than zero'), { statusCode: 400 });
  }
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw Object.assign(new Error('Refund amount must be a finite number greater than zero with at most 2 decimal places'), { statusCode: 400 });
  }
  const parsed = Number(text);
  const cents = Math.round(parsed * 100);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(cents)) {
    throw Object.assign(new Error('Refund amount must be a finite number greater than zero'), { statusCode: 400 });
  }
  return cents;
}

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const billId = body.bill_id;
    if (billId === undefined || billId === null || billId === '') {
      return res.status(400).json({ error: 'bill_id is required' });
    }
    const orderItemId = body.order_item_id !== undefined && body.order_item_id !== null ? Number(body.order_item_id) : null;
    if (orderItemId !== null && !Number.isSafeInteger(orderItemId)) {
      return res.status(400).json({ error: 'order_item_id must be an integer' });
    }
    let amountCents: number | undefined;
    if (body.amount !== undefined && body.amount !== null) {
      amountCents = refundAmountCents(body.amount);
    } else if (orderItemId === null) {
      return res.status(400).json({ error: 'amount is required unless order_item_id is given' });
    }
    if (typeof body.reason === 'string' && body.reason.length > MAX_REASON_LENGTH) {
      return res.status(400).json({ error: 'reason is too long' });
    }

    const idempotencyKey = refundIdempotencyKey(req);
    const requestHash = idempotencyKey ? refundRequestHash(String(billId), body) : undefined;

    const db = getDatabase();
    const userId = String((req as any).user.userId);
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

    const refundRequest: RefundRequest = {
      billId,
      orderItemId,
      amountCents,
      method: body.method,
      reason: body.reason ?? null,
      shiftId: body.shift_id ?? null,
      overridePin: body.override_pin,
      managerId: body.manager_id || body.user_id,
      createdByUserId: userId,
      clientIp,
      checkPinRateLimit,
      idempotencyKey,
      requestHash,
    };

    const result = withTxn(() => createRefund(db, refundRequest));
    res.status(201).json(result);
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to process refund' });
  }
});

router.get('/', requireRole(...ROLE_ACCESS.ownerManagerCashier), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = 'SELECT * FROM refunds WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as count FROM refunds WHERE 1=1';
    const params: any[] = [];

    if (req.query.bill_id) {
      query += ' AND bill_id = ?';
      countQuery += ' AND bill_id = ?';
      params.push(req.query.bill_id);
    }

    const requestedLimit = req.query.limit !== undefined ? Number(req.query.limit) : 50;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }
    const limit = Math.min(requestedLimit, 500);
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    query += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
    const pageParams = [...params, limit, offset];

    const refunds = db.prepare(query).all(...pageParams);
    const total = Number((db.prepare(countQuery).get(...params) as any)?.count || 0);
    res.json({
      refunds,
      pagination: {
        limit,
        per_page: limit,
        offset,
        total,
        next_offset: offset + refunds.length < total ? offset + refunds.length : null,
        has_more: offset + refunds.length < total,
      },
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to list refunds' });
  }
});

export { router as refundRoutes };
