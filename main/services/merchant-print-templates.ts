/**
 * Merchant print templates service (#447, epic #438).
 *
 * CRUD + lifecycle for tenant-owned semantic receipt templates stored in the
 * dedicated `merchant_print_templates` table. This table is deliberately
 * SEPARATE from `installed_print_templates` (signed compliance-pack
 * artifacts): merchant rows are ordinary editable documents and must never
 * touch the pack trust model.
 *
 * Lifecycle: draft -> active -> archived, with single-step rollback via
 * `previous_payload_json`. Every write revalidates the payload against the
 * shared kernel validator (fail-closed) and recomputes `checksum`
 * (sha256 of the exact persisted payload text). Rollback verifies the
 * current checksum first so tampering is detected before a swap.
 *
 * Provenance: `origin` distinguishes created | imported | cloned; a cloned
 * row may carry `derived_from` pointing at a compliance-pack template id for
 * USER INFORMATION ONLY — no compliance trust transfers (see #447).
 */

import { createHash, randomUUID } from 'crypto';
import { getDatabase, now } from '../db';
import { validateMerchantTemplateText } from '../../shared/print';

export interface MerchantPrintTemplateRow {
  id: string;
  business_id: string;
  name: string;
  origin: 'created' | 'imported' | 'cloned';
  derived_from: string | null;
  document_type: string;
  schema_version: number;
  payload_json: string;
  status: 'draft' | 'active' | 'archived';
  previous_payload_json: string | null;
  checksum: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Structured provenance reference (stored as JSON in derived_from). */
export interface DerivedFromRef {
  /** Provenance class of the source. Compliance clones stay informational. */
  type: 'compliance-pack-template' | 'merchant-template';
  templateId: string;
}

export class MerchantTemplateError extends Error {
  readonly statusCode: number;
  readonly details?: readonly string[];
  constructor(message: string, statusCode = 400, details?: readonly string[]) {
    super(message);
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}

/**
 * The local SQLite file is single-store, so every row is scoped to the local
 * business tenant (`business_id = 'local'`), matching how the rest of the
 * embedded database scopes implicitly to one store.
 */
const LOCAL_BUSINESS_ID = 'local';

function computeChecksum(payloadJson: string): string {
  return createHash('sha256').update(payloadJson, 'utf8').digest('hex');
}

function parseDerivedFrom(raw: unknown): DerivedFromRef | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new MerchantTemplateError('derivedFrom must be an object with type and templateId');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MerchantTemplateError('derivedFrom must be an object with type and templateId');
  }
  const record = value as Record<string, unknown>;
  const { type, templateId } = record;
  if (type !== 'compliance-pack-template' && type !== 'merchant-template') {
    throw new MerchantTemplateError('derivedFrom.type must be "compliance-pack-template" or "merchant-template"');
  }
  if (typeof templateId !== 'string' || templateId.length === 0) {
    throw new MerchantTemplateError('derivedFrom.templateId must be a non-empty string');
  }
  return { type, templateId };
}

/** Validate + normalize a payload for storage. Returns canonical JSON text. */
function normalizePayload(payload: unknown): string {
  let rawText: string;
  if (typeof payload === 'string') {
    rawText = payload;
  } else {
    try {
      rawText = JSON.stringify(payload);
    } catch {
      throw new MerchantTemplateError('payload must be a JSON object');
    }
  }
  const validation = validateMerchantTemplateText(rawText);
  if (!validation.ok) {
    throw new MerchantTemplateError(
      `Invalid template payload: ${validation.errors[0]}`,
      400,
      validation.errors,
    );
  }
  // Re-stringify the validated object so the stored text is canonical.
  return JSON.stringify(validation.payload);
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new MerchantTemplateError('Template name is required');
  }
  const trimmed = name.trim();
  if (trimmed.length > 100) {
    throw new MerchantTemplateError('Template name must be at most 100 characters');
  }
  return trimmed;
}

export function listMerchantPrintTemplates(): MerchantPrintTemplateRow[] {
  try {
    return getDatabase().prepare(`
      SELECT * FROM merchant_print_templates
      WHERE business_id = ?
      ORDER BY updated_at DESC, id
    `).all(LOCAL_BUSINESS_ID) as MerchantPrintTemplateRow[];
  } catch {
    // Table not migrated yet — behave like "no merchant templates exist".
    return [];
  }
}

export function loadMerchantPrintTemplateRow(id: string): MerchantPrintTemplateRow | null {
  try {
    return getDatabase().prepare(`
      SELECT * FROM merchant_print_templates WHERE id = ? AND business_id = ? LIMIT 1
    `).get(id, LOCAL_BUSINESS_ID) as MerchantPrintTemplateRow | undefined || null;
  } catch {
    return null;
  }
}

/** Active template payload for the render path, or null when unavailable. */
export function loadActiveMerchantPrintTemplate(id: string): MerchantPrintTemplateRow | null {
  const row = loadMerchantPrintTemplateRow(id);
  if (!row || row.status !== 'active') return null;
  return row;
}

export function createMerchantPrintTemplate(input: {
  name: unknown;
  payload: unknown;
  origin?: unknown;
  derivedFrom?: unknown;
}, actorId: string | null): MerchantPrintTemplateRow {
  const name = validateName(input.name);
  const payloadJson = normalizePayload(input.payload);
  const origin = input.origin === undefined || input.origin === null
    ? 'created'
    : input.origin;
  if (origin !== 'created' && origin !== 'imported' && origin !== 'cloned') {
    throw new MerchantTemplateError('origin must be one of: created, imported, cloned');
  }
  const derivedFrom = parseDerivedFrom(input.derivedFrom);
  if (origin === 'cloned' && !derivedFrom) {
    throw new MerchantTemplateError('cloned templates require a derivedFrom reference');
  }

  const db = getDatabase();
  const id = randomUUID();
  const timestamp = now();
  db.prepare(`
    INSERT INTO merchant_print_templates (
      id, business_id, name, origin, derived_from, document_type, schema_version,
      payload_json, status, previous_payload_json, checksum,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'receipt', 1, ?, 'draft', NULL, ?, ?, ?, ?, ?)
  `).run(
    id,
    LOCAL_BUSINESS_ID,
    name,
    origin,
    derivedFrom ? JSON.stringify(derivedFrom) : null,
    payloadJson,
    computeChecksum(payloadJson),
    actorId,
    actorId,
    timestamp,
    timestamp,
  );
  return loadMerchantPrintTemplateRow(id)!;
}

/**
 * Update name and/or payload. Draft rows are freely editable; editing an
 * ACTIVE row snapshots its current payload into `previous_payload_json`
 * (single-step rollback) before applying the change.
 */
export function updateMerchantPrintTemplate(
  id: string,
  input: { name?: unknown; payload?: unknown },
  actorId: string | null,
): MerchantPrintTemplateRow {
  const row = loadMerchantPrintTemplateRow(id);
  if (!row) throw new MerchantTemplateError('Template not found', 404);
  if (row.status === 'archived') {
    throw new MerchantTemplateError('Archived templates cannot be edited', 409);
  }

  const name = input.name !== undefined ? validateName(input.name) : row.name;
  let payloadJson = row.payload_json;
  let previousPayloadJson = row.previous_payload_json;
  if (input.payload !== undefined) {
    payloadJson = normalizePayload(input.payload);
    if (payloadJson !== row.payload_json && row.status === 'active') {
      previousPayloadJson = row.payload_json;
    }
  }
  if (input.payload === undefined && input.name !== undefined && row.status === 'active') {
    // Renaming alone does not create a rollback point.
    previousPayloadJson = row.previous_payload_json;
  }

  getDatabase().prepare(`
    UPDATE merchant_print_templates
    SET name = ?, payload_json = ?, previous_payload_json = ?, checksum = ?, updated_by = ?, updated_at = ?
    WHERE id = ?
  `).run(name, payloadJson, previousPayloadJson, computeChecksum(payloadJson), actorId, now(), id);
  return loadMerchantPrintTemplateRow(id)!;
}

export function activateMerchantPrintTemplate(id: string, actorId: string | null): MerchantPrintTemplateRow {
  const row = loadMerchantPrintTemplateRow(id);
  if (!row) throw new MerchantTemplateError('Template not found', 404);
  if (row.status === 'archived') {
    throw new MerchantTemplateError('Archived templates cannot be activated', 409);
  }
  verifyChecksum(row);
  getDatabase().prepare(`
    UPDATE merchant_print_templates SET status = 'active', updated_by = ?, updated_at = ? WHERE id = ?
  `).run(actorId, now(), id);
  return loadMerchantPrintTemplateRow(id)!;
}

export function archiveMerchantPrintTemplate(id: string, actorId: string | null): MerchantPrintTemplateRow {
  const row = loadMerchantPrintTemplateRow(id);
  if (!row) throw new MerchantTemplateError('Template not found', 404);
  if (row.status === 'archived') {
    throw new MerchantTemplateError('Template is already archived', 409);
  }
  getDatabase().prepare(`
    UPDATE merchant_print_templates SET status = 'archived', updated_by = ?, updated_at = ? WHERE id = ?
  `).run(actorId, now(), id);
  return loadMerchantPrintTemplateRow(id)!;
}

function verifyChecksum(row: MerchantPrintTemplateRow): void {
  const actual = computeChecksum(row.payload_json);
  if (actual !== row.checksum) {
    throw new MerchantTemplateError(
      `Checksum mismatch for template ${row.id}: stored checksum does not match its payload`,
      409,
    );
  }
}

/**
 * Single-step rollback: restores `previous_payload_json` after verifying the
 * CURRENT row's checksum (tamper detection), then swaps payloads and clears
 * the rollback point. The restored payload is revalidated fail-closed so a
 * payload written by a newer schema version cannot sneak back in.
 */
export function rollbackMerchantPrintTemplate(id: string, actorId: string | null): MerchantPrintTemplateRow {
  const row = loadMerchantPrintTemplateRow(id);
  if (!row) throw new MerchantTemplateError('Template not found', 404);
  if (row.status === 'archived') {
    throw new MerchantTemplateError('Archived templates cannot be rolled back', 409);
  }
  if (!row.previous_payload_json) {
    throw new MerchantTemplateError('No previous payload to roll back to', 409);
  }
  verifyChecksum(row);

  const restoredValidation = validateMerchantTemplateText(row.previous_payload_json);
  if (!restoredValidation.ok) {
    throw new MerchantTemplateError(
      `Previous payload fails current validation: ${restoredValidation.errors[0]}`,
      409,
      restoredValidation.errors,
    );
  }
  const restoredJson = JSON.stringify(restoredValidation.payload);

  getDatabase().prepare(`
    UPDATE merchant_print_templates
    SET payload_json = ?, previous_payload_json = NULL, checksum = ?, updated_by = ?, updated_at = ?
    WHERE id = ?
  `).run(restoredJson, computeChecksum(restoredJson), actorId, now(), id);
  return loadMerchantPrintTemplateRow(id)!;
}
