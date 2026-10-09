import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import expressRateLimit from 'express-rate-limit';
import { requirePermission } from '../services/authorization';
import { cloudSync, DiagnosticEventInput, DIAGNOSTIC_LOG_MAX_ROWS, isAllowedDiagnosticEventCode } from '../services/cloud-sync';
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
const MAX_MESSAGE_CHARS = 300;
const MAX_CORRELATION_ID_CHARS = 64;
const MAX_METADATA_JSON_BYTES = 4096;
const MAX_METADATA_DEPTH = 3;
const MAX_METADATA_KEYS = 40;
const MAX_METADATA_STRING_CHARS = 300;
const FRONTEND_CAPTURE_POINTS = new Set([
  'fc.frontend.pos.order.create.transport',
  'fc.frontend.pos.order.create.recovery',
  'fc.frontend.pos.payment.create.transport',
  'fc.frontend.pos.payment.create.recovery',
  'fc.frontend.pos.order.create.retry_storage',
  'fc.frontend.pos.order.create.retry_cleanup',
  'fc.frontend.pos.payment.create.retry_storage',
  'fc.frontend.pos.payment.create.retry_cleanup',
  'fc.frontend.pos.order.append.retry_storage',
  'fc.frontend.pos.order.append.retry_cleanup',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Depth-clamps, key-limits, and string-trims client metadata without PII-shaped passthrough. */
function sanitizeDiagnosticMetadata(value: unknown, depth: number): unknown {
  if (depth > MAX_METADATA_DEPTH) return undefined;
  if (typeof value === 'string') return value.slice(0, MAX_METADATA_STRING_CHARS);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const child = sanitizeDiagnosticMetadata(item, depth + 1);
      if (child !== undefined) out.push(child);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, childValue] of Object.entries(value)) {
    // Assignment would trigger the Object.prototype __proto__ setter and swap
    // the result's prototype instead of defining an own property.
    if (key === '__proto__') continue;
    if (keys >= MAX_METADATA_KEYS) break;
    const child = sanitizeDiagnosticMetadata(childValue, depth + 1);
    if (child !== undefined) {
      out[key.slice(0, 100)] = child;
      keys += 1;
    }
  }
  return out;
}

/** Validates and normalizes a client-submitted diagnostic event; null when the payload is unacceptable. */
export function buildDiagnosticEvent(body: unknown): DiagnosticEventInput | null {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const eventCode = typeof raw.event_code === 'string' ? raw.event_code.trim() : '';
  if (!EVENT_CODE_RE.test(eventCode) || !isAllowedDiagnosticEventCode(eventCode)) return null;
  const severity = typeof raw.severity === 'string' ? raw.severity : '';
  if (!ALLOWED_SEVERITIES.has(severity)) return null;

  if (raw.metadata !== undefined && raw.metadata !== null && !isPlainObject(raw.metadata)) return null;
  const metadata = isPlainObject(raw.metadata)
    ? sanitizeDiagnosticMetadata(raw.metadata, 0) as Record<string, unknown>
    : undefined;
  if (metadata !== undefined && JSON.stringify(metadata).length > MAX_METADATA_JSON_BYTES) return null;

  return {
    event_id: randomUUID(),
    event_code: eventCode,
    severity: severity as DiagnosticEventInput['severity'],
    correlation_id: typeof raw.correlation_id === 'string' && raw.correlation_id.trim()
      ? raw.correlation_id.trim().slice(0, MAX_CORRELATION_ID_CHARS)
      : undefined,
    message: typeof raw.message === 'string' && raw.message.trim()
      ? raw.message.trim().slice(0, MAX_MESSAGE_CHARS)
      : undefined,
    metadata,
    occurred_at: new Date().toISOString(),
  };
}

router.post('/event', requirePermission('support.use'), diagnosticsWriteRateLimit, (req: Request, res: Response) => {
  const event = buildDiagnosticEvent(req.body);
  if (!event) return res.status(400).json({ error: 'Invalid diagnostic event' });
  try {
    // Consent-gated, fire-and-forget: a rejected enqueue must never fail the request.
    cloudSync.reportDiagnostic(event);
  } catch { /* diagnostics must never mask the original failure */ }
  res.status(202).json({ queued: true });
});

// Cashier transport/recovery events are client-owned. Backend write failures are
// captured at their authoritative boundary and must not be reported here again.
router.post('/capture', diagnosticsWriteRateLimit, (req: Request, res: Response) => {
  const raw = isPlainObject(req.body) ? req.body : {};
  const capturePoint = raw.capture_point;
  const hasFacts = raw.facts !== undefined;
  if (Object.keys(raw).sort().join(',') !== (hasFacts ? 'capture_point,facts,operation_id,outcome' : 'capture_point,operation_id,outcome')
    || typeof capturePoint !== 'string' || !FRONTEND_CAPTURE_POINTS.has(capturePoint)
    || typeof raw.outcome !== 'string' || !isOperationReference(raw.operation_id)) {
    return res.status(400).json({ error: 'Invalid diagnostic capture' });
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
  const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, DIAGNOSTIC_LOG_MAX_ROWS) : 50;
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
  const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, DIAGNOSTIC_LOG_MAX_ROWS) : 50;
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
