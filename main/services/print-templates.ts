import { getDatabase } from '../db';
import { loadMerchantPrintTemplateRow } from './merchant-print-templates';

export const CORE_BILL_TEMPLATES = ['classic', 'compact'] as const;
export type CoreBillTemplate = typeof CORE_BILL_TEMPLATES[number];

export interface InstalledPrintTemplate {
  template_id: string;
  pack_id: string;
  pack_version_id: string;
  country: string;
  jurisdiction: string;
  display_name: string;
  paper_widths_json: string;
  renderer_json: string;
  template_payload_json: string;
  status: string;
  created_at: string;
}

export function isCoreBillTemplate(value: string): value is CoreBillTemplate {
  return (CORE_BILL_TEMPLATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Selection identity (#447) — structured, not concatenated strings
// ---------------------------------------------------------------------------

/**
 * A structured bill-template selection persisted in the `bill_template`
 * setting as `{ source: 'core' | 'pack' | 'merchant', id }` JSON. Legacy bare
 * string values (`classic`, `compact`, `<pack-template-id>`) keep resolving
 * during the transition and are upgraded transparently on the next save.
 */
export type BillTemplateSource = 'core' | 'pack' | 'merchant';

export interface BillTemplateSelection {
  source: BillTemplateSource;
  id: string;
}

/** Shape check only; availability is a separate concern. */
function parseStructuredSelection(value: unknown): BillTemplateSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { source, id } = record;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (source !== 'core' && source !== 'pack' && source !== 'merchant') return null;
  return { source, id };
}

/**
 * Resolve ANY persisted `bill_template` value into a structured selection:
 * accepts the structured object, its JSON-string encoding, and every legacy
 * bare-string form. Returns null for values that resolve to nothing.
 *
 * Legacy resolution order mirrors history: core names first, then pack
 * template ids. Merchant ids are uuids that never collide with either.
 */
export function parseBillTemplateSelection(rawValue: unknown): BillTemplateSelection | null {
  // Structured object form.
  const direct = parseStructuredSelection(rawValue);
  if (direct) return direct;

  // Structured JSON-string form.
  let value = rawValue;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = parseStructuredSelection(JSON.parse(trimmed));
        if (parsed) return parsed;
      } catch {
        // Not JSON after all — fall through to legacy string handling.
      }
    }
    value = trimmed;
  }

  if (typeof value !== 'string' || value.length === 0) return null;

  // Legacy bare strings.
  const normalized = value.toLowerCase();
  if ((CORE_BILL_TEMPLATES as readonly string[]).includes(normalized)) {
    return { source: 'core', id: normalized as CoreBillTemplate };
  }
  if (loadInstalledPrintTemplate(value)) return { source: 'pack', id: value };
  if (loadMerchantPrintTemplateRow(value)) return { source: 'merchant', id: value };
  return null;
}

/** Canonical persistence form for a selection (stored in settings). */
export function serializeBillTemplateSelection(selection: BillTemplateSelection): string {
  return JSON.stringify({ source: selection.source, id: selection.id });
}

/**
 * Upgrade any accepted input to its canonical structured form when it is
 * resolvable; returns null for unresolvable values (caller decides policy).
 */
export function upgradeBillTemplateValue(rawValue: unknown): string | null {
  const selection = parseBillTemplateSelection(rawValue);
  return selection ? serializeBillTemplateSelection(selection) : null;
}

export function listInstalledPrintTemplates(): InstalledPrintTemplate[] {
  try {
    return getDatabase().prepare(`
      SELECT template.*
      FROM installed_print_templates AS template
      JOIN country_pack_versions AS version ON version.id = template.pack_version_id
      JOIN country_packs AS pack ON pack.id = template.pack_id
      WHERE version.status NOT IN ('revoked', 'incompatible')
        AND pack.status IN ('active', 'installed')
      ORDER BY template.country, template.display_name, template.template_id
    `).all() as InstalledPrintTemplate[];
  } catch {
    return [];
  }
}

export function loadInstalledPrintTemplate(templateId: string): InstalledPrintTemplate | null {
  try {
    const row = getDatabase().prepare(`
      SELECT template.*
      FROM installed_print_templates AS template
      JOIN country_pack_versions AS version ON version.id = template.pack_version_id
      JOIN country_packs AS pack ON pack.id = template.pack_id
      WHERE template.template_id = ?
        AND version.status NOT IN ('revoked', 'incompatible')
        AND pack.status IN ('active', 'installed')
      LIMIT 1
    `).get(templateId) as InstalledPrintTemplate | undefined;
    return row || null;
  } catch {
    return null;
  }
}

/**
 * Extended for #447: accepts both the structured `{ source, id }` forms and
 * every legacy bare-string value; merchant templates qualify while they have
 * an ACTIVE row (drafts and archived rows are not selectable).
 */
export function isAvailableBillTemplate(value: unknown): boolean {
  const selection = parseBillTemplateSelection(value);
  if (!selection) return false;
  switch (selection.source) {
    case 'core':
      return isCoreBillTemplate(selection.id);
    case 'pack':
      return Boolean(loadInstalledPrintTemplate(selection.id));
    case 'merchant': {
      const row = loadMerchantPrintTemplateRow(selection.id);
      return Boolean(row) && row!.status === 'active';
    }
  }
}
