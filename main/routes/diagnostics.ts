import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import expressRateLimit from 'express-rate-limit';
import { requirePermission } from '../services/authorization';
import {
  cloudSync,
  DiagnosticEventInput,
  DIAGNOSTIC_LOG_MAX_ROWS,
  isAllowedDiagnosticEventCode,
} from '../services/cloud-sync';
import { isOperationReference, serializeOperationFailure } from '../lib/operation-failure';
import { buildSystemDiagnostics, resolveCategory } from './support-ticket';

const router = Router();

const diagnosticsWriteRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const EVENT_CODE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ALLOWED_SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'critical']);
const MAX_EVENT_CODE_CHARS = 64;
const MAX_SEVERITY_CHARS = 8;
const MAX_MESSAGE_CHARS = 300;
const MAX_CORRELATION_ID_CHARS = 64;
const MAX_METADATA_JSON_BYTES = 4096;
const MAX_METADATA_DEPTH = 3;
const MAX_METADATA_ENTRIES = 40;
const MAX_METADATA_STRING_CHARS = 300;
const FRONTEND_CAPTURE_POINTS = new Set([
  'fc.frontend.pos.order.create.transport',
  'fc.frontend.pos.order.create.recovery',
  'fc.frontend.pos.payment.create.transport',
  'fc.frontend.pos.payment.create.recovery',
  'fc.frontend.pos.order.create.retry_storage',
  'fc.frontend.pos.order.create.retry_cleanup',
  'fc.client.order.create.retry_state_update',
  'fc.client.payment.create.retry_state_update',
  'fc.client.bill.generate.retry_state_update',
  'fc.frontend.pos.payment.create.retry_storage',
  'fc.frontend.pos.payment.create.retry_cleanup',
  'fc.frontend.pos.order.create.held_cleanup',
  'fc.frontend.pos.payment.create.held_cleanup',
  'fc.frontend.pos.order.append.transport',
  'fc.frontend.pos.order.append.recovery',
  'fc.frontend.pos.order.append.retry_storage',
  'fc.frontend.pos.order.append.retry_cleanup',
]);
const MAX_CAPTURE_POINT_CHARS = Math.max(
  ...Array.from(FRONTEND_CAPTURE_POINTS, (point) => point.length),
);
const MAX_CAPTURE_FIELD_NAME_CHARS = 'capture_point'.length;
const MAX_CAPTURE_OUTCOME_CHARS = 16;
const MAX_CAPTURE_FACTS = 1;
const MAX_CAPTURE_FACT_KEY_CHARS = 'failure_class'.length;
const MAX_CAPTURE_FACT_VALUE_CHARS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Depth-clamps, key-limits, and string-trims client metadata without PII-shaped passthrough. */
function sanitizeDiagnosticMetadata(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): unknown {
  if (depth > MAX_METADATA_DEPTH) return undefined;
  if (typeof value === 'string') return value.slice(0, MAX_METADATA_STRING_CHARS);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let index = 0; index < value.length && budget.remaining > 0; index += 1) {
      budget.remaining -= 1;
      const child = sanitizeDiagnosticMetadata(value[index], depth + 1, budget);
      if (child !== undefined) out.push(child);
    }
    return out;
  }
  const objectValue = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key in objectValue) {
    if (!Object.prototype.hasOwnProperty.call(objectValue, key)) continue;
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    // Assignment would trigger the Object.prototype __proto__ setter and swap
    // the result's prototype instead of defining an own property.
    if (key === '__proto__') continue;
    const child = sanitizeDiagnosticMetadata(objectValue[key], depth + 1, budget);
    if (child !== undefined) {
      out[key.slice(0, 100)] = child;
    }
  }
  return out;
}

/** Validates and normalizes a client-submitted diagnostic event; null when the payload is unacceptable. */
export function buildDiagnosticEvent(body: unknown): DiagnosticEventInput | null {
  const raw =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const eventCode =
    typeof raw.event_code === 'string' && raw.event_code.length <= MAX_EVENT_CODE_CHARS
      ? raw.event_code.trim()
      : '';
  if (!EVENT_CODE_RE.test(eventCode) || !isAllowedDiagnosticEventCode(eventCode)) return null;
  const severity =
    typeof raw.severity === 'string' && raw.severity.length <= MAX_SEVERITY_CHARS
      ? raw.severity
      : '';
  if (!ALLOWED_SEVERITIES.has(severity)) return null;

  if (raw.metadata !== undefined && raw.metadata !== null && !isPlainObject(raw.metadata))
    return null;
  const metadata = isPlainObject(raw.metadata)
    ? (sanitizeDiagnosticMetadata(raw.metadata, 0, { remaining: MAX_METADATA_ENTRIES }) as Record<
        string,
        unknown
      >)
    : undefined;
  if (metadata !== undefined && JSON.stringify(metadata).length > MAX_METADATA_JSON_BYTES)
    return null;

  const correlationId =
    typeof raw.correlation_id === 'string'
      ? raw.correlation_id
          .slice(0, MAX_CORRELATION_ID_CHARS)
          .trim()
          .slice(0, MAX_CORRELATION_ID_CHARS)
      : undefined;
  const message =
    typeof raw.message === 'string'
      ? raw.message.slice(0, MAX_MESSAGE_CHARS).trim().slice(0, MAX_MESSAGE_CHARS)
      : undefined;

  return {
    event_id: randomUUID(),
    event_code: eventCode,
    severity: severity as DiagnosticEventInput['severity'],
    correlation_id: correlationId || undefined,
    message: message || undefined,
    metadata,
    occurred_at: new Date().toISOString(),
  };
}

router.post(
  '/event',
  requirePermission('support.use'),
  diagnosticsWriteRateLimit,
  (req: Request, res: Response) => {
    const event = buildDiagnosticEvent(req.body);
    if (!event) return res.status(400).json({ error: 'Invalid diagnostic event' });
    try {
      // Consent-gated, fire-and-forget: a rejected enqueue must never fail the request.
      cloudSync.reportDiagnostic(event);
    } catch {
      /* diagnostics must never mask the original failure */
    }
    res.status(202).json({ queued: true });
  },
);

// Cashier transport/recovery events are client-owned. Backend write failures are
// captured at their authoritative boundary and must not be reported here again.
router.post('/capture', diagnosticsWriteRateLimit, (req: Request, res: Response) => {
  const raw = isPlainObject(req.body) ? req.body : {};
  const capturePoint = raw.capture_point;
  const hasFacts = Object.hasOwn(raw, 'facts');
  let fieldCount = 0;
  for (const key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    if (
      key.length > MAX_CAPTURE_FIELD_NAME_CHARS ||
      (key !== 'capture_point' && key !== 'facts' && key !== 'operation_id' && key !== 'outcome')
    ) {
      return res.status(400).json({ error: 'Invalid diagnostic capture' });
    }
    fieldCount += 1;
    if (fieldCount > 4) return res.status(400).json({ error: 'Invalid diagnostic capture' });
  }
  if (
    fieldCount !== (hasFacts ? 4 : 3) ||
    typeof capturePoint !== 'string' ||
    capturePoint.length > MAX_CAPTURE_POINT_CHARS ||
    !FRONTEND_CAPTURE_POINTS.has(capturePoint) ||
    typeof raw.outcome !== 'string' ||
    raw.outcome.length > MAX_CAPTURE_OUTCOME_CHARS ||
    typeof raw.operation_id !== 'string' ||
    raw.operation_id.length !== 36 ||
    !isOperationReference(raw.operation_id)
  ) {
    return res.status(400).json({ error: 'Invalid diagnostic capture' });
  }
  if (hasFacts) {
    if (!isPlainObject(raw.facts))
      return res.status(400).json({ error: 'Invalid diagnostic capture' });
    let factCount = 0;
    for (const key in raw.facts) {
      if (!Object.prototype.hasOwnProperty.call(raw.facts, key)) continue;
      factCount += 1;
      if (factCount > MAX_CAPTURE_FACTS || key.length > MAX_CAPTURE_FACT_KEY_CHARS)
        return res.status(400).json({ error: 'Invalid diagnostic capture' });
      const value = raw.facts[key];
      if (typeof value === 'string' && value.length > MAX_CAPTURE_FACT_VALUE_CHARS)
        return res.status(400).json({ error: 'Invalid diagnostic capture' });
    }
  }
  const failure = serializeOperationFailure({
    capture_point: capturePoint,
    outcome: raw.outcome,
    correlation_id: raw.operation_id,
    ...(hasFacts ? { facts: raw.facts } : {}),
  });
  if (!failure) return res.status(400).json({ error: 'Invalid diagnostic capture' });
  cloudSync.captureOperationFailure({
    capture_point: failure.capture_point,
    outcome: failure.outcome,
    correlation_id: failure.correlation_id,
    facts: failure.facts,
  });
  return res.status(202).json({
    captured: true,
    reason_code: failure.reason_code,
    operation: failure.operation,
    stage: failure.stage,
    classification: failure.classification,
    outcome: failure.outcome,
    correlation_id: failure.correlation_id,
  });
});

router.get('/health', requirePermission('support.use'), (_req: Request, res: Response) => {
  res.json(cloudSync.listDiagnosticDeliveryHealth());
});

// Local read for the diagnostics screen; nothing here is transmitted.
router.get('/recent', requirePermission('support.use'), (req: Request, res: Response) => {
  const limitRaw = Number(req.query.limit);
  const limit =
    Number.isSafeInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, DIAGNOSTIC_LOG_MAX_ROWS)
      : 50;
  res.json({ failures: cloudSync.listLocalDiagnostics(limit) });
});

// Erasing the evidence is destructive, so it takes the same permission as
// changing the transmission setting rather than the read path's support.use.
router.delete('/recent', requirePermission('settings.manage'), (req: Request, res: Response) => {
  res.json({ removed: cloudSync.clearLocalDiagnostics() });
});

// The raw log tail is deliberately absent: it can carry order and customer
// detail, so the operator adds it on the screen after seeing what it is.
router.get('/support-bundle', requirePermission('support.use'), (req: Request, res: Response) => {
  const limitRaw = Number(req.query.limit);
  const limit =
    Number.isSafeInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, DIAGNOSTIC_LOG_MAX_ROWS)
      : 50;
  const failures = cloudSync.listLocalDiagnostics(limit);
  res.json({
    bundle: {
      system: buildSystemDiagnostics(req, resolveCategory(req.query.category)),
      recent_failures: failures.map((failure) => ({
        occurred_at: failure.occurred_at,
        event_code: failure.event_code,
        severity: failure.severity,
        signature: failure.signature,
        summary: failure.summary,
        ...(failure.metadata ? { metadata: failure.metadata } : {}),
      })),
    },
  });
});

export const diagnosticsRoutes = router;
