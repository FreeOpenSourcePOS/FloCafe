/**
 * Merchant print template CRUD API (#447, epic #438).
 *
 * Owner-role lifecycle management for tenant-owned semantic receipt
 * templates: create draft -> activate -> archive, with single-step rollback.
 * Payloads are validated fail-closed by the shared kernel validator on every
 * write. #448 adds validated offline transfer: GET /:id/export downloads a
 * self-describing `.json` envelope; POST /import runs the same fail-closed
 * pipeline on an uploaded envelope and lands it as a NEW draft. This API
 * deliberately does NOT expose a visual editor.
 */

import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  MerchantTemplateError,
  activateMerchantPrintTemplate,
  archiveMerchantPrintTemplate,
  createMerchantPrintTemplate,
  exportMerchantPrintTemplateFile,
  importMerchantPrintTemplateFile,
  listMerchantPrintTemplates,
  loadMerchantPrintTemplateRow,
  rollbackMerchantPrintTemplate,
  updateMerchantPrintTemplate,
} from '../services/merchant-print-templates';
import type { MerchantPrintTemplateRow } from '../services/merchant-print-templates';

const router = Router();

const merchantTemplateWriteRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

function actorId(req: Request): string | null {
  const user = (req as Request & { user?: { userId?: string } }).user;
  return String(user?.userId || '') || null;
}

/** Public row shape: provenance stays informational, payloads stay internal. */
function shape(row: MerchantPrintTemplateRow) {
  return {
    id: row.id,
    name: row.name,
    origin: row.origin,
    derivedFrom: row.derived_from ? JSON.parse(row.derived_from) : null,
    documentType: row.document_type,
    schemaVersion: row.schema_version,
    status: row.status,
    hasPreviousPayload: Boolean(row.previous_payload_json),
    checksum: row.checksum,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof MerchantTemplateError) {
    res.status(error.statusCode).json({
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  console.error('[Print Templates] Internal error:', error);
  res.status(500).json({ error: 'Internal server error' });
}

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (_req: Request, res: Response) => {
  try {
    res.json({ templates: listMerchantPrintTemplates().map(shape) });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/', merchantTemplateWriteRateLimit, requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const row = createMerchantPrintTemplate({
      name: req.body?.name,
      payload: req.body?.payload,
      origin: req.body?.origin,
      derivedFrom: req.body?.derivedFrom,
    }, actorId(req));
    res.status(201).json({ template: shape(row) });
  } catch (error) {
    handleError(res, error);
  }
});

router.put('/:id', merchantTemplateWriteRateLimit, requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const row = updateMerchantPrintTemplate(String(req.params.id), {
      name: req.body?.name,
      payload: req.body?.payload,
    }, actorId(req));
    res.json({ template: shape(row) });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/:id/activate', merchantTemplateWriteRateLimit, requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const row = activateMerchantPrintTemplate(String(req.params.id), actorId(req));
    res.json({ template: shape(row) });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/:id/archive', merchantTemplateWriteRateLimit, requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const row = archiveMerchantPrintTemplate(String(req.params.id), actorId(req));
    res.json({ template: shape(row) });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/:id/rollback', merchantTemplateWriteRateLimit, requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const row = rollbackMerchantPrintTemplate(String(req.params.id), actorId(req));
    res.json({ template: shape(row) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/:id/payload', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const row = loadMerchantPrintTemplateRow(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'Template not found' });
    res.json({ id: row.id, schemaVersion: row.schema_version, checksum: row.checksum, payload: JSON.parse(row.payload_json) });
  } catch (error) {
    handleError(res, error);
  }
});

// --- Offline transfer (#448) ----------------------------------------------

/** Download the portable transfer envelope for one template (owner only). */
router.get('/:id/export', merchantTemplateWriteRateLimit, requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const file = exportMerchantPrintTemplateFile(String(req.params.id));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.json);
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * Import a transfer file as a NEW draft (owner only). The body carries the
 * raw envelope text in `file` (plus optional `name` override and the client
 * `fileName` for provenance); every byte is treated as untrusted input and
 * pushed through the full fail-closed validation pipeline in the service.
 */
router.post('/import', merchantTemplateWriteRateLimit, requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const row = importMerchantPrintTemplateFile({
      file: req.body?.file,
      name: req.body?.name,
      fileName: req.body?.fileName,
    }, actorId(req));
    res.status(201).json({ template: shape(row) });
  } catch (error) {
    handleError(res, error);
  }
});

export const printTemplateRoutes = router;
