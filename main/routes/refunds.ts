import { createHash, randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { getDatabase, verifyPinAsync, withTxn } from '../db';
import { requirePermission } from '../services/authorization';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { checkPinRateLimit, isPinRateLimited, clearPinRateLimit } from './orders';
import {
  createRefund,
  getTenantCurrency,
  RefundRequest,
  validateRefundPreconditions,
  PreVerifiedRefundApprover,
} from '../services/refund';
import { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } from '../countries';
import { cloudSync } from '../services/cloud-sync';
import { isOperationReference, serializeOperationFailure } from '../lib/operation-failure';

const router = Router();
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_REASON_LENGTH = 500;

const refundPinLocks = new Map<string, Promise<void>>();

export async function withRefundPinLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = refundPinLocks.get(key) || Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  refundPinLocks.set(key, current);

  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    resolveCurrent();
    if (refundPinLocks.get(key) === current) {
      refundPinLocks.delete(key);
    }
  }
}

export function resetRefundPinLocksForTests(): void {
  refundPinLocks.clear();
}

function refundIdempotencyKey(req: Request): string | null {
  const supplied = req.get('Idempotency-Key')?.trim();
  if (!supplied) return null;
  if (supplied.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(supplied)) {
    throw Object.assign(new Error('Idempotency-Key is invalid or too long'), {
      statusCode: 400,
      diagnosticCode: 'idempotency_key_invalid',
    });
  }
  return supplied;
}

function refundRequestHash(
  billId: string,
  body: Record<string, unknown>,
  approverId: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        billId,
        order_item_id: body.order_item_id ?? null,
        amount: body.amount ?? null,
        method: body.method ?? null,
        reason: body.reason ?? null,
        shift_id: body.shift_id ?? null,
        approver_id: approverId,
      }),
    )
    .digest('hex');
}

function refundAmountMinorUnits(value: unknown, currency: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw Object.assign(new Error('Refund amount must be a finite number greater than zero'), {
      statusCode: 400,
      diagnosticCode: 'amount_invalid',
    });
  }
  const decimals = getCurrencyFractionDigits(currency);
  const factor = getCurrencyMinorUnitFactor(currency);
  const text = String(value).trim();
  const pattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(text)) {
    const decDesc = decimals === 0 ? 'without decimals' : `with at most ${decimals} decimal places`;
    throw Object.assign(
      new Error(`Refund amount must be a finite number greater than zero ${decDesc}`),
      { statusCode: 400, diagnosticCode: 'amount_invalid' },
    );
  }
  const parsed = Number(text);
  const minorUnits = Math.round(parsed * factor);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(minorUnits)) {
    throw Object.assign(new Error('Refund amount must be a finite number greater than zero'), {
      statusCode: 400,
      diagnosticCode: 'amount_invalid',
    });
  }
  return minorUnits;
}

function structuredRefundFailure(
  req: Request,
  error: string,
  capturePoint: string,
  displayCode?: string,
  outcome: 'not_applied' | 'applied' | 'unknown' = 'not_applied',
): Record<string, unknown> {
  const header = req.get('x-operation-id');
  const correlationId = isOperationReference(header) ? header : randomUUID();
  const failure = serializeOperationFailure({
    capture_point: capturePoint,
    outcome,
    correlation_id: correlationId,
    ...(displayCode ? { facts: { display_code: displayCode } } : {}),
  });
  if (!failure) return { error };
  (req as Request & { diagnosticsCaptured?: boolean }).diagnosticsCaptured = true;
  try {
    cloudSync.captureOperationFailure(failure);
  } catch {
    /* Diagnostics must not affect refunds. */
  }
  return {
    error,
    reason_code: failure.reason_code,
    operation: failure.operation,
    stage: failure.stage,
    classification: failure.classification,
    outcome: failure.outcome,
    correlation_id: failure.correlation_id,
    ...(failure.facts.display_code ? { display_code: failure.facts.display_code } : {}),
  };
}

router.post('/', requirePermission('refunds.initiate'), async (req: Request, res: Response) => {
  let operationCommitted = false;
  let transactionBodyCompleted = false;
  try {
    const body = req.body || {};
    const billId = body.bill_id;
    if (billId === undefined || billId === null || billId === '') {
      return res
        .status(400)
        .json(
          structuredRefundFailure(
            req,
            'bill_id is required',
            'fc.backend.payment.refund.validation',
            'bill_id_required',
          ),
        );
    }
    const orderItemId =
      body.order_item_id !== undefined && body.order_item_id !== null
        ? Number(body.order_item_id)
        : null;
    if (orderItemId !== null && !Number.isSafeInteger(orderItemId)) {
      return res
        .status(400)
        .json(
          structuredRefundFailure(
            req,
            'order_item_id must be an integer',
            'fc.backend.payment.refund.validation',
            'order_item_id_invalid',
          ),
        );
    }
    const db = getDatabase();
    const currency = getTenantCurrency(db);
    let amountCents: number | undefined;
    if (body.amount !== undefined && body.amount !== null) {
      amountCents = refundAmountMinorUnits(body.amount, currency);
    } else if (orderItemId === null) {
      return res
        .status(400)
        .json(
          structuredRefundFailure(
            req,
            'amount is required unless order_item_id is given',
            'fc.backend.payment.refund.validation',
            'amount_required',
          ),
        );
    }
    if (typeof body.reason === 'string' && body.reason.length > MAX_REASON_LENGTH) {
      return res
        .status(400)
        .json(
          structuredRefundFailure(
            req,
            'reason is too long',
            'fc.backend.payment.refund.validation',
            'reason_too_long',
          ),
        );
    }

    const approverId =
      body.approver_id !== undefined && body.approver_id !== null
        ? String(body.approver_id).trim()
        : '';
    const managerId =
      body.manager_id !== undefined && body.manager_id !== null
        ? String(body.manager_id).trim()
        : '';
    if (!approverId && !managerId) {
      return res.status(400).json({
        ...structuredRefundFailure(
          req,
          'approver_id is required',
          'fc.backend.payment.refund.validation',
          'approver_required',
        ),
        code: 'APPROVER_REQUIRED',
      });
    }
    if (approverId && managerId && approverId !== managerId) {
      return res.status(400).json({
        ...structuredRefundFailure(
          req,
          'approver_id and manager_id must identify the same approver',
          'fc.backend.payment.refund.validation',
          'approver_conflict',
        ),
        code: 'APPROVER_CONFLICT',
      });
    }
    const selectedApproverId = approverId || managerId;
    const idempotencyKey = refundIdempotencyKey(req);
    const requestHash = idempotencyKey
      ? refundRequestHash(String(billId), body, selectedApproverId)
      : undefined;

    const userId = String((req as any).user.userId);
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

    const checkIdempotencyReplay = (): Record<string, unknown> | null => {
      if (!idempotencyKey) return null;
      const prior = db
        .prepare(`
        SELECT bill_id, request_hash, response_json
        FROM refund_idempotency
        WHERE user_id = ? AND idempotency_key = ?
      `)
        .get(userId, idempotencyKey) as
        | { bill_id: string | number; request_hash: string; response_json: string }
        | undefined;
      if (!prior) return null;
      if (String(prior.bill_id) !== String(billId) || prior.request_hash !== requestHash) {
        throw Object.assign(
          new Error('Idempotency-Key was already used for a different refund request'),
          { statusCode: 409, diagnosticCode: 'idempotency_conflict' },
        );
      }
      try {
        return JSON.parse(prior.response_json);
      } catch {
        throw Object.assign(new Error('Stored refund response is invalid'), {
          statusCode: 500,
        });
      }
    };

    // 1. Check idempotency replay outside withTxn
    const initialReplay = checkIdempotencyReplay();
    if (initialReplay) {
      return res.status(201).json(initialReplay);
    }

    // 2. Pre-validate preconditions (business-day window, order item, amounts, session, etc.) before checking PIN
    const { lateRefund } = validateRefundPreconditions(db, {
      billId,
      method: body.method,
      amountCents,
      orderItemId,
    });

    const overridePin = body.override_pin;

    // 3. Rate-limited async PIN verification outside withTxn
    const rateLimitKey = `pin:${clientIp}:refund`;
    let preVerifiedApprover: PreVerifiedRefundApprover | null = null;
    let idempotencyReplay: Record<string, unknown> | null = null;

    await withRefundPinLock(rateLimitKey, async () => {
      idempotencyReplay = checkIdempotencyReplay();
      if (idempotencyReplay) {
        return;
      }

      if (!overridePin) {
        throw Object.assign(
          new Error(
            lateRefund
              ? 'Owner PIN required to process a refund on a completed order'
              : 'Manager PIN required to process a refund',
          ),
          { statusCode: 400, diagnosticCode: 'approver_pin_required' },
        );
      }

      if (isPinRateLimited(rateLimitKey)) {
        throw Object.assign(new Error('Too many PIN attempts. Try again in 15 minutes.'), {
          statusCode: 429,
          diagnosticCode: 'pin_rate_limited',
        });
      }

      const allowedRoles = lateRefund ? ROLE_ACCESS.owner : ROLE_ACCESS.ownerManager;
      const placeholders = allowedRoles.map(() => '?').join(', ');
      const candidate = db
        .prepare(
          `SELECT id, pin_hash, role, is_active FROM users WHERE id = ? AND pin_hash IS NOT NULL AND role IN (${placeholders}) AND is_active = 1`,
        )
        .get(selectedApproverId, ...allowedRoles) as
        | { id: string; pin_hash: string; role: string; is_active: number }
        | undefined;

      let pinMatches = false;
      if (candidate) {
        pinMatches = await verifyPinAsync(candidate.pin_hash, overridePin);
      }

      if (!candidate || !pinMatches) {
        idempotencyReplay = checkIdempotencyReplay();
        if (idempotencyReplay) {
          return;
        }
        checkPinRateLimit(rateLimitKey);
        throw Object.assign(new Error(lateRefund ? 'Invalid owner PIN' : 'Invalid manager PIN'), {
          statusCode: 403,
          diagnosticCode: 'approver_pin_invalid',
        });
      }

      preVerifiedApprover = {
        id: candidate.id,
        verifiedPinHash: candidate.pin_hash,
        lateRefund,
      };
    });

    if (idempotencyReplay) {
      return res.status(201).json(idempotencyReplay);
    }

    const refundRequest: RefundRequest = {
      billId,
      orderItemId,
      amountCents,
      method: body.method,
      reason: body.reason ?? null,
      shiftId: body.shift_id ?? null,
      overridePin: body.override_pin,
      approverId: selectedApproverId,
      createdByUserId: userId,
      clientIp,
      checkPinRateLimit,
      isPinRateLimited,
      clearPinRateLimit,
      idempotencyKey,
      requestHash,
      preVerifiedApprover,
    };

    const result = withTxn(() => {
      const refundResult = createRefund(db, refundRequest);
      transactionBodyCompleted = true;
      return refundResult;
    });
    clearPinRateLimit(rateLimitKey);
    operationCommitted = true;
    res.status(201).json(result);
  } catch (error: any) {
    const status = error.statusCode || 500;
    const outcome = operationCommitted
      ? 'applied'
      : transactionBodyCompleted
        ? 'unknown'
        : 'not_applied';
    const capturePoint = operationCommitted
      ? 'fc.backend.payment.refund.completion'
      : status >= 500
        ? 'fc.backend.payment.refund.persistence'
        : 'fc.backend.payment.refund.validation';
    const displayCode = status < 500 ? error.diagnosticCode : undefined;
    const payload =
      status >= 500 || displayCode
        ? structuredRefundFailure(
            req,
            error.message || 'Unable to process refund',
            capturePoint,
            displayCode,
            outcome,
          )
        : { error: error.message || 'Unable to process refund' };
    res.status(status).json(payload);
  }
});

router.get('/', requirePermission('refunds.view'), (req: Request, res: Response) => {
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
