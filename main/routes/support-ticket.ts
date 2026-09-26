import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import * as os from 'os';
import { rateLimit } from '../middleware/security';
import { requirePermission } from '../services/authorization';
import { asyncHandler } from '../middleware/async-handler';
import { cloudSync } from '../services/cloud-sync';
import { getDatabase } from '../db';
import { getHttpRequestSignal } from '../shutdown';
import { normalizeOptionalPhone } from '../lib/phone';

const router = Router();

const ALLOWED_CATEGORIES = new Set(['general', 'bug', 'feature', 'account', 'printer', 'tax']);
const ALLOWED_SEVERITIES = new Set(['low', 'normal', 'high', 'urgent']);
const CLIENT_TICKET_ID_RE = /^[0-9a-f-]{36}$/i;
// Defensive server-side cap on the *byte* size of an attached log tail; the
// client already truncates to this size (see get-log-tail IPC).
const LOG_TAIL_MAX_BYTES = 200_000;

/** Rate limit for the unauthenticated pre-login support endpoints (no session to key off yet). */
function preLoginRateLimit(max: number) {
  return rateLimit({ windowMs: 15 * 60 * 1000, max, message: 'Too many requests. Please try again later.', bypassPrivateIp: false });
}
type SupportUser = { name?: string; email?: string; role?: string };
type AuthenticatedRequest = Request & { user?: { userId?: string; role?: string } };

const BLANK_PROFILE = {
  contact_name: '', contact_email: '', contact_phone: '',
  restaurant_name: '', country: '', timezone: '', submitted_by_role: '',
};

function isAuthenticatedRequest(req: Request): boolean {
  return !!(req as AuthenticatedRequest).user?.userId;
}

function supportProfile(req: Request) {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const authUser = (req as AuthenticatedRequest).user;
  const userId = String(authUser?.userId || '');
  const currentUser = userId
    ? db.prepare('SELECT name, email, role FROM users WHERE id = ? AND is_active = 1').get(userId) as SupportUser | undefined
    : null;
  const owner = db.prepare(
    "SELECT name, email, role FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at ASC LIMIT 1"
  ).get() as SupportUser | undefined;
  const contact = currentUser || owner || {};
  return {
    contact_name: String(contact.name || owner?.name || '').trim(),
    contact_email: String(settings.email || owner?.email || contact.email || '').trim(),
    contact_phone: String(settings.business_phone || settings.phone || '').trim(),
    restaurant_name: String(settings.business_name || '').trim(),
    country: String(settings.country || '').trim(),
    timezone: String(settings.timezone || '').trim(),
    submitted_by_role: String(contact.role || authUser?.role || '').trim(),
  };
}

/** Pre-login routes are reachable by any unauthenticated LAN client; never disclose owner/business PII there. */
function resolveProfile(req: Request) {
  return isAuthenticatedRequest(req) ? supportProfile(req) : BLANK_PROFILE;
}

/** Shared with the diagnostics screen so both surfaces classify a category identically. */
export function resolveCategory(value: unknown): string {
  return ALLOWED_CATEGORIES.has(String(value || '')) ? String(value) : 'general';
}

/**
 * System state for a diagnostics bundle. Shared with the support-ticket path so
 * the diagnostics screen and a raised ticket always report the same fields.
 * Exported rather than duplicated: the in-app screen is a presentation change
 * over this builder, not a second system-inspection implementation.
 */
export function buildSystemDiagnostics(req: Request, category: string) {
  const db = getDatabase();
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;
  const profile = resolveProfile(req);
  return {
    category,
    restaurant_name: profile.restaurant_name,
    country: profile.country,
    timezone: profile.timezone,
    app_version: require('../../package.json').version,
    platform: process.platform,
    arch: process.arch,
    device_name: os.hostname(),
    schema_version: schemaVersion,
    cloud: (() => {
      const status = cloudSync.getStatus();
      return {
        registration_status: status.cloud_registration_status,
        connected: status.cloud_connected,
        relay_mode: status.cloud_relay_mode,
        last_error: String(status.cloud_last_error || '').slice(0, 500) || null,
        pending_events: status.outbox_pending,
        failed_events: status.outbox_failed,
      };
    })(),
    submitted_by_role: profile.submitted_by_role,
  };
}

function profileHandler(req: Request, res: Response) {
  const profile = resolveProfile(req);
  res.json({ ...profile, app_version: require('../../package.json').version, platform: process.platform });
}

function statusHandler(req: Request, res: Response) {
  const clientTicketId = String(req.params.clientTicketId || '');
  if (!CLIENT_TICKET_ID_RE.test(clientTicketId)) return res.status(400).json({ error: 'invalid client_ticket_id' });
  const row = getDatabase().prepare(
    'SELECT status, support_code, last_error FROM support_ticket_outbox WHERE client_ticket_id = ?'
  ).get(clientTicketId) as { status: string; support_code: string | null; last_error: string | null } | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ status: row.status, support_code: row.support_code, last_error: row.last_error });
}

async function submitTicketHandler(req: Request, res: Response) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const subject = String(body.subject || '').trim().slice(0, 255);
  const message = String(body.message || '').trim().slice(0, 20000);
  if (!subject || !message) return res.status(400).json({ error: 'subject and message are required' });

  const clientTicketId = typeof body.client_ticket_id === 'string' && CLIENT_TICKET_ID_RE.test(body.client_ticket_id)
    ? body.client_ticket_id : randomUUID();
  const eventCode = String(body.event_code || '').slice(0, 64) || undefined;
  const category = resolveCategory(body.category);
  const severity = ALLOWED_SEVERITIES.has(String(body.severity || ''))
    ? String(body.severity) as 'low' | 'normal' | 'high' | 'urgent' : 'normal';
  const profile = resolveProfile(req);
  const contactEmail = String(body.contact_email || profile.contact_email).trim().slice(0, 255);
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return res.status(400).json({ error: 'contact_email must be a valid email address' });
  }

  let contactPhone: string | undefined = undefined;
  if (body.contact_phone !== undefined && body.contact_phone !== null && String(body.contact_phone).trim() !== '') {
    const phoneRes = normalizeOptionalPhone(body.contact_phone, profile.country || '');
    if (!phoneRes.valid || !phoneRes.e164) {
      return res.status(400).json({ error: 'contact_phone must be a valid phone number' });
    }
    contactPhone = phoneRes.e164;
  } else if (profile.contact_phone) {
    const phoneRes = normalizeOptionalPhone(profile.contact_phone, profile.country || '');
    contactPhone = phoneRes.valid && phoneRes.e164 ? phoneRes.e164 : undefined;
  }

  const suppliedDiagnostics = body.diagnostics && typeof body.diagnostics === 'object' && !Array.isArray(body.diagnostics)
    ? body.diagnostics : {};
  const diagnostics = { ...suppliedDiagnostics, ...buildSystemDiagnostics(req, category) };
  if (JSON.stringify(diagnostics).length > 15000) return res.status(400).json({ error: 'diagnostics are too large' });

  const logTail = typeof body.log_tail === 'string' && body.log_tail.trim()
    ? Buffer.from(body.log_tail, 'utf8').subarray(-LOG_TAIL_MAX_BYTES).toString('utf8')
    : undefined;

  const queued = await cloudSync.queueSupportTicket({
    client_ticket_id: clientTicketId,
    subject,
    message,
    severity,
    event_code: eventCode || `support.${category}`,
    correlation_id: String(body.correlation_id || '').slice(0, 64) || undefined,
    contact_name: String(body.contact_name || profile.contact_name).trim().slice(0, 255) || undefined,
    contact_email: contactEmail || undefined,
    contact_phone: contactPhone,
    diagnostics,
    log_tail: logTail,
  }, getHttpRequestSignal(req));
  res.status(queued.queued ? 202 : 503).json({
    ...queued,
    status: queued.queued ? 'queued' : 'unavailable',
    message: queued.queued
      ? 'Your request is queued and will be sent when FloCafe is online.'
      : 'Cloud data deletion is in progress; please try again later.',
  });
}

router.get('/profile', requirePermission('support.use'), profileHandler);
router.get('/diagnostics-preview', requirePermission('support.use'), (req: Request, res: Response) => {
  res.json(buildSystemDiagnostics(req, resolveCategory(req.query.category)));
});
router.get('/:clientTicketId/status', requirePermission('support.use'), statusHandler);
router.post('/', requirePermission('support.use'), asyncHandler(submitTicketHandler));

// Unauthenticated (login-screen) variants, exempted in main/server.ts;
// rate-limited here (private IPs included) since there is no user to key off.
router.get('/pre-login/profile', preLoginRateLimit(30), profileHandler);
router.get('/pre-login/:clientTicketId/status', preLoginRateLimit(60), statusHandler);
router.post('/pre-login', preLoginRateLimit(5), asyncHandler(submitTicketHandler));

export const supportTicketRoutes = router;
