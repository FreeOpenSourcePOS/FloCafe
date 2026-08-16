import { getDatabase } from '../db';

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

export function isAvailableBillTemplate(value: string): boolean {
  return isCoreBillTemplate(value) || Boolean(loadInstalledPrintTemplate(value));
}
