import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import expressRateLimit from 'express-rate-limit';
import { requirePermission } from '../services/authorization';
import { cloudSync, DiagnosticEventInput, isAllowedDiagnosticEventCode } from '../services/cloud-sync';

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

export const diagnosticsRoutes = router;
