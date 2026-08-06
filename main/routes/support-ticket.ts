import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireRole } from '../middleware/security';
import { cloudSync } from '../services/cloud-sync';

const router = Router();

router.post('/', requireRole('owner', 'manager', 'cashier', 'waiter', 'chef'), async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const subject = String(body.subject || '').trim().slice(0, 255);
  const message = String(body.message || '').trim().slice(0, 5000);
  if (!subject || !message) return res.status(400).json({ error: 'subject and message are required' });

  const clientTicketId = typeof body.client_ticket_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.client_ticket_id)
    ? body.client_ticket_id
    : randomUUID();
  const eventCode = String(body.event_code || '').slice(0, 64) || undefined;
  const includeContact = body.include_contact === true;
  const diagnostics = body.diagnostics && typeof body.diagnostics === 'object' && !Array.isArray(body.diagnostics)
    ? body.diagnostics : null;
  const queued = await cloudSync.queueSupportTicket({
    client_ticket_id: clientTicketId,
    subject,
    message,
    event_code: eventCode,
    correlation_id: String(body.correlation_id || '').slice(0, 64) || undefined,
    ...(includeContact ? {
      contact_name: String(body.contact_name || '').trim().slice(0, 255) || undefined,
      contact_email: String(body.contact_email || '').trim().slice(0, 255) || undefined,
      contact_phone: String(body.contact_phone || '').trim().slice(0, 50) || undefined,
    } : {}),
    diagnostics,
  });
  res.status(202).json({ ...queued, status: 'queued', message: 'Your request is queued and will be sent when FloCafe is online.' });
});

export const supportTicketRoutes = router;
