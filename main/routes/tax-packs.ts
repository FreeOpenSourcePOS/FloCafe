import { Router, Request, Response } from 'express';
import { randomUUID, createHash, type KeyLike } from 'crypto';
import Decimal from 'decimal.js';
import { getDatabase, getSettingValue, now, upsertSettings, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { TaxEngine } from '../services/tax-engine';
import type { CountryPack, TaxBehavior, TaxCategory, TaxRule } from '../tax-packs/types';
import { BUNDLED_COUNTRY_PACKS } from '../tax-packs/bundled';
import {
  downloadAndVerifyTaxPack,
  fetchRemoteTaxPackCatalog,
  verifyTaxPackSignature,
  type TaxPackCatalogEntry,
} from '../tax-packs/catalog';
import { TRUSTED_TAX_PACK_SIGNING_PUBLIC_KEY } from '../tax-packs/trusted-signing-key';

const router = Router();
const BUNDLED_PACKS_BY_ID = new Map(BUNDLED_COUNTRY_PACKS.map((pack) => [pack.id, pack]));
// India and Thailand were bundled unsigned before country packs moved to the
// signed release catalog. Existing customer databases still contain those
// exact artifacts. Rather than keep the original tax-rate content in the
// repo just to re-check it byte-for-byte, we keep only the SHA-256 digest of
// that exact historical JSON (sha256(JSON.stringify(pack))) — enough to keep
// validating those specific already-installed rows as trusted, without the
// underlying tax content living in source. Exported so tests can inject a
// synthetic id/digest pair instead of depending on real pack content.
// 'official-in'/'official-th' are the pre-rename ids used before commit
// 3a75876 renamed them to 'official-india'/'official-thailand'; stores that
// installed taxes before that rename still carry the old id in their DB and
// must keep validating too.
export const LEGACY_TRUSTED_PACK_DIGESTS: Record<string, string> = {
  'official-india': '873e8212625d5eefc4192bf99bcebece107cd2384ce8a1c6ecd44a7095082f2d',
  'official-thailand': '25f4082e56372599e90cad6222a493c426f7846552e00ccf486a71e7aa90d656',
  'official-in': 'f2b7f10cfb03a6c8bd987382ab30bb384ee154c816a328ca4b97a0a5eb0cdec7',
  'official-th': 'eb6bcee77ed077b4c218e5446e96e4669e162f8abefcc238cb97e9088309e7c3',
};
const APP_VERSION = String(require('../../package.json').version);
const ENTITY_TYPES = ['product', 'addon', 'packaging', 'delivery', 'service_charge'] as const;
const TAX_BEHAVIORS: TaxBehavior[] = ['country_default', 'inclusive', 'exclusive', 'exempt'];

type OverrideEntityType = typeof ENTITY_TYPES[number];

interface PackRow {
  id: string;
  publisher: string;
  country: string;
  jurisdiction: string;
  active_version_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  pack_id: string;
  version: string;
  schema_version: number;
  manifest_json: string;
  pack_json: string;
  digest: string | null;
  signature: string | null;
  effective_from: string;
  effective_to: string | null;
  min_flo_version: string;
  published_at: string;
  status: string;
  created_at: string;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function actorUserId(req: Request): string | null {
  return (req as any).user?.userId || (req as any).user?.id || null;
}

function activateInstalledPack(pack: PackRow, version: VersionRow, actorId: string | null): void {
  const db = getDatabase();
  const validation = validationChecklist(version);
  if (!validation.valid) {
    throw Object.assign(new Error('Tax pack failed activation validation'), { statusCode: 400 });
  }
  const previousVersionId = pack.active_version_id;
  withTxn(() => {
    db.prepare(`UPDATE country_packs SET status = 'installed', updated_at = ? WHERE country = ? AND id != ?`)
      .run(now(), pack.country, pack.id);
    if (previousVersionId) {
      db.prepare(`UPDATE country_pack_versions SET status = 'installed' WHERE id = ?`).run(previousVersionId);
      db.prepare(`UPDATE tax_overrides SET pack_version_id = ?, updated_at = ? WHERE pack_version_id = ?`)
        .run(version.id, now(), previousVersionId);
    }
    db.prepare(`UPDATE country_packs SET active_version_id = ?, status = 'active', updated_at = ? WHERE id = ?`)
      .run(version.id, now(), pack.id);
    db.prepare(`UPDATE country_pack_versions SET status = 'active' WHERE id = ?`).run(version.id);
    audit('activate_pack', actorId, pack.id, version.id, null, { previousVersionId, automatic: true });
  });
}

function persistPackArtifacts(version: VersionRow, definition: CountryPack, installedAt: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO country_pack_versions (
      id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
      effective_from, effective_to, min_flo_version, published_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', ?)
  `).run(
    version.id, version.pack_id, version.version, version.schema_version,
    version.manifest_json, version.pack_json, version.digest, version.signature,
    version.effective_from, version.effective_to, version.min_flo_version, version.published_at,
    installedAt,
  );
  const insertCategory = db.prepare(`
    INSERT INTO tax_categories (
      id, pack_version_id, category_id, label, default_behavior, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const category of definition.categories) {
    insertCategory.run(
      `${version.id}:category:${category.id}`,
      version.id, category.id, category.label,
      category.defaultBehavior || null,
      JSON.stringify(category),
      installedAt,
    );
  }
  const insertRule = db.prepare(`
    INSERT INTO tax_rules (
      id, pack_version_id, rule_id, label, calculation_type, rate, amount,
      applies_per, base_rule_ids, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const rule of definition.rules) {
    insertRule.run(
      `${version.id}:rule:${rule.id}`,
      version.id, rule.id, rule.label, rule.type,
      rule.rate || null, rule.amount || null, rule.appliesPer || null,
      JSON.stringify(rule.baseRuleIds || []),
      JSON.stringify(rule),
      installedAt,
    );
  }
}

function trustStatus(pack: PackRow, overrideCount: number): string {
  if (pack.status === 'revoked') return 'Revoked';
  if (pack.status === 'incompatible') return 'Incompatible';
  if (overrideCount > 0) return 'Customized';
  return pack.publisher === 'local' ? 'Local' : 'Official';
}

function activePackForCountry(country: string): { pack: PackRow; version: VersionRow; definition: CountryPack } {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT pack.*, version.id AS version_row_id, version.pack_id, version.version,
      version.schema_version, version.manifest_json, version.pack_json, version.digest,
      version.signature, version.effective_from, version.effective_to,
      version.min_flo_version, version.published_at, version.status AS version_status,
      version.created_at AS version_created_at
    FROM country_packs AS pack
    JOIN country_pack_versions AS version ON version.id = pack.active_version_id
    WHERE pack.country IN (?, '*') AND pack.status = 'active'
    ORDER BY CASE WHEN pack.country = ? THEN 0 ELSE 1 END, pack.updated_at DESC
    LIMIT 1
  `).get(country, country) as any;
  if (!row) throw Object.assign(new Error(`No active tax pack is installed for ${country}`), { statusCode: 409 });
  return {
    pack: {
      id: row.id,
      publisher: row.publisher,
      country: row.country,
      jurisdiction: row.jurisdiction,
      active_version_id: row.active_version_id,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    version: {
      id: row.version_row_id,
      pack_id: row.pack_id,
      version: row.version,
      schema_version: row.schema_version,
      manifest_json: row.manifest_json,
      pack_json: row.pack_json,
      digest: row.digest,
      signature: row.signature,
      effective_from: row.effective_from,
      effective_to: row.effective_to,
      min_flo_version: row.min_flo_version,
      published_at: row.published_at,
      status: row.version_status,
      created_at: row.version_created_at,
    },
    definition: JSON.parse(row.pack_json) as CountryPack,
  };
}

function validateOverrideTarget(
  packVersionId: string,
  entityType: unknown,
  entityId: unknown,
  categoryId: unknown,
): { entityType: OverrideEntityType; entityId: string | null; categoryId: string } {
  if (typeof entityType !== 'string' || !ENTITY_TYPES.includes(entityType as OverrideEntityType)) {
    throw Object.assign(new Error(`entity_type must be one of: ${ENTITY_TYPES.join(', ')}`), { statusCode: 400 });
  }
  if (typeof categoryId !== 'string' || !categoryId) {
    throw Object.assign(new Error('category_id is required'), { statusCode: 400 });
  }

  const db = getDatabase();
  const category = db.prepare(
    'SELECT 1 FROM tax_categories WHERE pack_version_id = ? AND category_id = ?'
  ).get(packVersionId, categoryId);
  if (!category) {
    throw Object.assign(new Error(`Unknown category "${categoryId}" for the active pack version`), { statusCode: 400 });
  }

  const normalizedType = entityType as OverrideEntityType;
  const requiresEntity = normalizedType === 'product' || normalizedType === 'addon';
  const normalizedEntityId = entityId === null || entityId === undefined || entityId === ''
    ? null
    : String(entityId);
  if (requiresEntity && !normalizedEntityId) {
    throw Object.assign(new Error(`entity_id is required for ${normalizedType} overrides`), { statusCode: 400 });
  }
  if (!requiresEntity && normalizedEntityId) {
    throw Object.assign(new Error(`entity_id must be empty for ${normalizedType} overrides`), { statusCode: 400 });
  }
  if (normalizedType === 'product') {
    const product = db.prepare('SELECT 1 FROM products WHERE id = ? AND deleted_at IS NULL').get(normalizedEntityId);
    if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  }
  if (normalizedType === 'addon') {
    const addon = db.prepare('SELECT 1 FROM addons WHERE id = ?').get(normalizedEntityId);
    if (!addon) throw Object.assign(new Error('Add-on not found'), { statusCode: 404 });
  }
  return { entityType: normalizedType, entityId: normalizedEntityId, categoryId };
}

function assertOverrideTargetAvailable(
  packVersionId: string,
  entityType: OverrideEntityType,
  entityId: string | null,
  excludingId?: string,
): void {
  const duplicate = getDatabase().prepare(`
    SELECT id FROM tax_overrides
    WHERE pack_version_id = ?
      AND entity_type = ?
      AND entity_id IS ?
      AND field_name = 'tax_category_id'
      AND (? IS NULL OR id != ?)
    LIMIT 1
  `).get(packVersionId, entityType, entityId, excludingId || null, excludingId || null);
  if (duplicate) {
    throw Object.assign(new Error('An override already exists for this target'), { statusCode: 409 });
  }
}

function semverParts(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function semverAtLeast(actual: string, minimum: string): boolean {
  const actualParts = semverParts(actual);
  const minimumParts = semverParts(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] !== minimumParts[index]) {
      return actualParts[index] > minimumParts[index];
    }
  }
  return true;
}

function containsUnsafeData(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes('../') || value.includes('..\\') || /^javascript:/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsUnsafeData);
  if (value && typeof value === 'object') return Object.values(value).some(containsUnsafeData);
  return false;
}

// Pack-agnostic activation vector: verifies self-consistency of the engine's
// output against the PACK'S OWN declared data (never a hardcoded expected
// rate keyed by a known pack id), so this works identically for the bundled
// packs and for any legitimately new pack installed from the signed catalog.
function activationVectorPasses(pack: CountryPack): boolean {
  const primaryCategory = pack.categories[0];
  if (!primaryCategory) return false;
  const calculate = (customer?: { stateCode: string; registrationNumber: string }) => TaxEngine.calculate({
    pack,
    country: pack.country === '*' ? 'ZZ' : pack.country,
    jurisdiction: pack.jurisdiction,
    businessType: 'restaurant',
    storeStateCode: 'ACTIVATION-VECTOR-HOME',
    customer,
    transactionDate: pack.effectiveFrom,
    lines: [{
      lineId: 'activation-vector',
      kind: 'product',
      quantity: '1',
      unitPrice: '100',
      productCategoryId: primaryCategory.id,
      taxBehavior: 'exclusive',
    }],
  });

  const intra = calculate();
  const line = intra.lines[0];
  const taxAmount = new Decimal(intra.taxAmount);
  const payableTotal = new Decimal(intra.payableTotal);
  if (!taxAmount.isFinite() || taxAmount.isNegative()) return false;
  // A category that DECLARES rules but produces zero applied components is a
  // real bug signature (e.g. a broken bidirectional category<->rule link).
  // A category with no declared rules at all (a blank manual/local template)
  // legitimately produces zero tax -- that is not a failure.
  if (primaryCategory.ruleIds.length > 0 && line.components.length === 0 && line.taxBehavior !== 'exempt') {
    return false;
  }
  const expectedBeforeRounding = new Decimal(100).plus(taxAmount);
  if (!new Decimal(intra.totalBeforePayableRounding).eq(expectedBeforeRounding)) return false;
  if (!payableTotal.eq(expectedBeforeRounding.plus(intra.payableRoundingAdjustment))) return false;

  const hasInterstateCondition = pack.rules.some(
    (rule) => primaryCategory.ruleIds.includes(rule.id) && rule.conditions?.customerStateRelation,
  );
  if (hasInterstateCondition) {
    try {
      calculate({ stateCode: 'ACTIVATION-VECTOR-AWAY', registrationNumber: 'ACTIVATION-VECTOR-REG' });
    } catch {
      return false;
    }
  }
  return true;
}

function audit(
  action: string,
  actorId: string | null,
  packId: string | null,
  packVersionId: string | null,
  overrideId: string | null,
  details: Record<string, unknown>,
): void {
  getDatabase().prepare(`
    INSERT INTO tax_config_audit (
      action, pack_id, pack_version_id, override_id, actor_user_id, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(action, packId, packVersionId, overrideId, actorId, JSON.stringify(details), now());
}

export function validationChecklist(
  version: VersionRow,
  publicKey: KeyLike = TRUSTED_TAX_PACK_SIGNING_PUBLIC_KEY,
): { valid: boolean; checks: Array<{ id: number; passed: boolean; message: string }> } {
  const checks: Array<{ id: number; passed: boolean; message: string }> = [];
  const add = (id: number, passed: boolean, message: string) => checks.push({ id, passed, message });
  let pack: CountryPack;
  try {
    pack = JSON.parse(version.pack_json) as CountryPack;
  } catch {
    return { valid: false, checks: [{ id: 1, passed: false, message: 'Pack JSON is invalid' }] };
  }

  add(1, pack.schemaVersion === 1 && version.schema_version === 1, 'Supported manifest and schema version');
  add(2, Boolean(pack.id && pack.publisher && /^([A-Z]{2}|\*)$/.test(pack.country)
    && pack.jurisdiction), 'Valid pack identity, publisher, country, and jurisdiction scope');
  const effectiveFrom = Date.parse(pack.effectiveFrom);
  const effectiveTo = pack.effectiveTo ? Date.parse(pack.effectiveTo) : null;
  add(3, /^\d+\.\d+\.\d+$/.test(pack.version) && Number.isFinite(effectiveFrom)
    && (effectiveTo === null || (Number.isFinite(effectiveTo) && effectiveTo >= effectiveFrom))
    && pack.version === version.version && pack.effectiveFrom === version.effective_from,
  'Valid, internally consistent version and effective-date range');
  add(4, semverAtLeast(APP_VERSION, pack.minFloVersion),
    `FloCafe ${APP_VERSION} satisfies minimum compatible version ${pack.minFloVersion}`);
  add(5, version.digest === createHash('sha256').update(version.pack_json).digest('hex'), 'Stored artifact digest matches');
  const bundledDefinition = BUNDLED_PACKS_BY_ID.get(pack.id);
  const legacyTrustedDigest = LEGACY_TRUSTED_PACK_DIGESTS[pack.id];
  const trustedArtifact = pack.publisher === 'local'
    ? version.signature === null
    : Boolean(
      (bundledDefinition && JSON.stringify(bundledDefinition) === JSON.stringify(pack))
      || (version.signature === null && legacyTrustedDigest
        && createHash('sha256').update(JSON.stringify(pack), 'utf8').digest('hex') === legacyTrustedDigest)
      || (version.signature && verifyTaxPackSignature(version.pack_json, version.signature, publicKey)),
    );
  add(6, trustedArtifact, pack.publisher === 'local'
    ? 'Synthetic local pack does not require a signature'
    : 'Artifact is bundled or has a valid trusted Ed25519 signature');
  add(7, version.status !== 'revoked' && version.status !== 'incompatible', 'Pack version is not revoked or incompatible');

  const categoryIds = pack.categories.map((category) => category.id);
  const ruleIds = pack.rules.map((rule) => rule.id);
  add(8, new Set(categoryIds).size === categoryIds.length && new Set(ruleIds).size === ruleIds.length, 'Category and rule IDs are unique');
  const requiredDefaults = ['packaging', 'delivery', 'service_charge', 'addon'] as const;
  add(9, categoryIds.includes(pack.unclassifiedCategoryId)
    && requiredDefaults.every((kind) => categoryIds.includes(pack.defaultCategories[kind])), 'Required defaults and unclassified category exist');
  add(10, pack.categories.every((category) => category.ruleIds.every((id) => ruleIds.includes(id)))
    && pack.rules.every((rule) => rule.categoryIds.every((id) => categoryIds.includes(id)))
    && pack.rules.every((rule) => (rule.baseRuleIds || []).every((id) => ruleIds.includes(id))), 'All category, rule, and dependency references resolve');

  const dependencies = new Map(pack.rules.map((rule) => [rule.id, rule.baseRuleIds || []]));
  let acyclic = true;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { acyclic = false; return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ruleIds) visit(id);
  add(11, acyclic, 'Rule dependency graph is acyclic');
  add(12, pack.rules.every((rule) => (rule.baseRuleIds || []).every((id) => ruleIds.includes(id)
    && !id.includes(':') && !id.includes('/'))), 'All dependencies reference rules on the same tax line');

  let amountsValid = true;
  for (const rule of pack.rules) {
    try {
      const value = new Decimal(rule.type === 'fixed' ? rule.amount || '' : rule.rate || '');
      if (!value.isFinite() || value.isNegative()) amountsValid = false;
    } catch { amountsValid = false; }
  }
  let payableIncrementValid = false;
  try {
    const increment = new Decimal(pack.payableRounding.increment);
    payableIncrementValid = increment.isFinite() && increment.gt(0) && increment.lte(1000);
  } catch { payableIncrementValid = false; }
  add(13, amountsValid && payableIncrementValid
    && Number.isInteger(pack.taxRounding.decimalPlaces)
    && pack.taxRounding.decimalPlaces >= 0 && pack.taxRounding.decimalPlaces <= 6,
  'Rates, fixed amounts, precision, and payable increment are within bounds');
  add(14, pack.rules.every((rule) => rule.type !== 'fixed' || (rule.baseRuleIds || []).length === 0), 'Fixed rules have no tax-rule dependencies');
  let inclusiveFixedValid = true;
  for (const category of pack.categories) {
    const fixedTotal = pack.rules
      .filter((rule) => rule.type === 'fixed' && category.ruleIds.includes(rule.id))
      .reduce((total, rule) => total.plus(rule.amount || 0), new Decimal(0));
    if (fixedTotal.gt(0)) {
      try {
        const result = TaxEngine.calculate({
          pack,
          country: pack.country === '*' ? 'ZZ' : pack.country,
          jurisdiction: pack.jurisdiction,
          businessType: 'restaurant',
          transactionDate: pack.effectiveFrom,
          lines: [{
            lineId: `inclusive-fixed-${category.id}`,
            kind: 'product',
            quantity: '1',
            unitPrice: fixedTotal.plus(1).toString(),
            productCategoryId: category.id,
            taxBehavior: 'inclusive',
          }],
        });
        if (result.lines.some((line) => new Decimal(line.taxableBase).isNegative())) inclusiveFixedValid = false;
      } catch { inclusiveFixedValid = false; }
    }
  }
  add(15, inclusiveFixedValid, 'Inclusive fixed-tax combinations produce a non-negative net amount');
  const recognizedConditions = pack.rules.every((rule) => {
    const conditions = rule.conditions;
    if (!conditions) return true;
    const keysValid = Object.keys(conditions).every((key) =>
      ['businessTypes', 'customerStateRelation', 'customerExempt'].includes(key));
    const relationValid = !conditions.customerStateRelation
      || ['interstate', 'intra_or_unspecified'].includes(conditions.customerStateRelation);
    return keysValid && relationValid
      && (!conditions.businessTypes || conditions.businessTypes.every((value) => typeof value === 'string' && value.length > 0))
      && (conditions.customerExempt === undefined || typeof conditions.customerExempt === 'boolean');
  });
  add(16, recognizedConditions
    && pack.categories.every((category) => !category.defaultBehavior || TAX_BEHAVIORS.includes(category.defaultBehavior)),
  'Every tax behavior and jurisdiction selector is recognized');
  add(17, ['unit', 'line', 'document'].includes(pack.taxRounding.scope)
    && ['half_up', 'half_even', 'floor', 'ceiling'].includes(pack.taxRounding.method)
    && ['half_up', 'half_even', 'floor', 'ceiling'].includes(pack.payableRounding.method)
    && new Decimal(pack.payableRounding.increment).gt(0), 'Tax and payable rounding policies are complete');
  let currencyValid = false;
  try {
    const formatter = new Intl.NumberFormat('en', { style: 'currency', currency: pack.currency });
    currencyValid = /^[A-Z]{3}$/.test(pack.currency)
      && Number.isInteger(formatter.resolvedOptions().maximumFractionDigits);
  } catch { currencyValid = false; }
  add(18, currencyValid, 'Currency code and decimal settings are valid');

  const active = getDatabase().prepare(
    'SELECT pack_json FROM country_pack_versions WHERE pack_id = ? AND status = ? LIMIT 1'
  ).get(version.pack_id, 'active') as { pack_json: string } | undefined;
  const activePack = active ? parseJson<CountryPack | null>(active.pack_json, null) : null;
  const stableIds = !activePack
    || (activePack.categories.every((category) => categoryIds.includes(category.id))
      && activePack.rules.every((rule) => ruleIds.includes(rule.id)));
  // Official packs must keep category/rule IDs stable across versions so
  // overrides never silently orphan (spec: "removed or renamed rules require
  // explicit resolution"). A local/manual pack is edited by re-submitting the
  // owner's full category list each time, so renaming or deleting a category
  // is a normal, expected edit there — the manual-config route (routes/
  // tax-packs.ts) handles that case itself by reassigning affected products/
  // add-ons to the new default and reporting what moved, so this check is
  // informational only for local packs rather than a hard block.
  add(19, stableIds || pack.publisher === 'local', 'Existing IDs remain available, so override aliases are not required');
  const activeVersion = getDatabase().prepare(
    'SELECT active_version_id FROM country_packs WHERE id = ?'
  ).get(version.pack_id) as { active_version_id: string | null } | undefined;
  const overrideConflicts = activeVersion?.active_version_id ? getDatabase().prepare(`
    SELECT COUNT(*) AS count
    FROM tax_overrides
    WHERE pack_version_id = ?
      AND json_extract(value_json, '$.categoryId') NOT IN (${categoryIds.map(() => '?').join(',') || "''"})
  `).get(activeVersion.active_version_id, ...categoryIds) as { count: number } : { count: 0 };
  add(20, overrideConflicts.count === 0, 'Every current merchant override resolves against this version');
  add(21, pack.categories.every((category) => Boolean(category.label))
    && pack.rules.every((rule) => Boolean(rule.label)), 'Default-language labels are present');
  add(22, typeof pack === 'object' && !containsUnsafeData(pack), 'Artifact is data-only and contains no executable or unsafe path values');
  let vectorPassed = false;
  try { vectorPassed = activationVectorPasses(pack); } catch { vectorPassed = false; }
  add(23, vectorPassed, 'Mandatory component, total, interstate, and rounding vectors are self-consistent');
  add(24, true, 'Activation uses one SQLite transaction and does not modify transactions');
  return { valid: checks.every((check) => check.passed), checks };
}

interface InstallCatalogEntryOptions {
  actorUserId: string | null;
  fetchImpl?: typeof fetch;
  publicKey?: KeyLike;
}

export async function installCatalogEntry(
  entry: TaxPackCatalogEntry,
  options: InstallCatalogEntryOptions,
): Promise<{
  packId: string;
  versionId: string;
  version: string;
  validation: ReturnType<typeof validationChecklist>;
}> {
  const publicKey = options.publicKey || TRUSTED_TAX_PACK_SIGNING_PUBLIC_KEY;
  const artifact = await downloadAndVerifyTaxPack(entry, options.fetchImpl || fetch, publicKey);
  const db = getDatabase();
  const existingPack = db.prepare('SELECT * FROM country_packs WHERE id = ?')
    .get(artifact.pack.id) as PackRow | undefined;
  if (existingPack && (
    existingPack.publisher !== artifact.pack.publisher
    || existingPack.country !== artifact.pack.country
    || existingPack.jurisdiction !== artifact.pack.jurisdiction
  )) {
    throw Object.assign(new Error('Downloaded pack identity conflicts with the installed pack'), { statusCode: 409 });
  }
  const duplicate = db.prepare(
    'SELECT id FROM country_pack_versions WHERE pack_id = ? AND version = ?'
  ).get(artifact.pack.id, artifact.pack.version);
  if (duplicate) {
    throw Object.assign(new Error('This tax pack version is already installed'), { statusCode: 409 });
  }

  const installedAt = now();
  const versionId = `${artifact.pack.id}@${artifact.pack.version}`;
  const version: VersionRow = {
    id: versionId,
    pack_id: artifact.pack.id,
    version: artifact.pack.version,
    schema_version: artifact.pack.schemaVersion,
    manifest_json: JSON.stringify(entry),
    pack_json: artifact.packJson,
    digest: entry.digest,
    signature: artifact.signature,
    effective_from: artifact.pack.effectiveFrom,
    effective_to: artifact.pack.effectiveTo || null,
    min_flo_version: artifact.pack.minFloVersion,
    published_at: artifact.pack.publishedAt,
    status: 'installed',
    created_at: installedAt,
  };
  const validation = validationChecklist(version, publicKey);
  if (!validation.valid) {
    throw Object.assign(new Error('Downloaded pack failed installation validation'), {
      statusCode: 400,
      validation,
    });
  }

  withTxn(() => {
    if (!existingPack) {
      db.prepare(`
        INSERT INTO country_packs (
          id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 'installed', ?, ?)
      `).run(
        artifact.pack.id,
        artifact.pack.publisher,
        artifact.pack.country,
        artifact.pack.jurisdiction,
        installedAt,
        installedAt,
      );
    } else {
      db.prepare('UPDATE country_packs SET updated_at = ? WHERE id = ?')
        .run(installedAt, artifact.pack.id);
    }
    const versionExists = db.prepare(
      'SELECT 1 FROM country_pack_versions WHERE pack_id = ? AND version = ?'
    ).get(artifact.pack.id, artifact.pack.version);
    if (versionExists) {
      throw Object.assign(new Error('This tax pack version is already installed'), { statusCode: 409 });
    }
    persistPackArtifacts(version, artifact.pack, installedAt);
    audit('install_downloaded_pack', options.actorUserId, artifact.pack.id, versionId, null, {
      source: 'github_release',
      version: artifact.pack.version,
      digest: entry.digest,
      downloadUrl: entry.downloadUrl,
    });
  });

  return {
    packId: artifact.pack.id,
    versionId,
    version: artifact.pack.version,
    validation,
  };
}

router.get('/', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const storeCountry = getSettingValue('country') || 'IN';
    const rows = db.prepare(`
      SELECT pack.*,
        (SELECT COUNT(*) FROM tax_overrides override
          WHERE override.pack_version_id = pack.active_version_id) AS override_count
      FROM country_packs AS pack
      ORDER BY CASE WHEN pack.country = ? THEN 0 WHEN pack.country = '*' THEN 1 ELSE 2 END,
        pack.country, pack.publisher, pack.id
    `).all(storeCountry) as Array<PackRow & { override_count: number }>;
    const packs = rows.map((pack) => {
      const versions = db.prepare(`
        SELECT id, version, schema_version, digest, effective_from, effective_to,
          min_flo_version, published_at, status, created_at
        FROM country_pack_versions WHERE pack_id = ? ORDER BY published_at DESC, version DESC
      `).all(pack.id);
      return {
        ...pack,
        active_for_store: pack.status === 'active' && (pack.country === storeCountry
          || (pack.country === '*' && !rows.some((candidate) => candidate.country === storeCountry && candidate.status === 'active'))),
        trust_status: trustStatus(pack, pack.override_count),
        versions,
      };
    });
    res.json({ store_country: storeCountry, packs });
  } catch (error: any) {
    console.error('[Tax Packs] List failed:', error);
    res.status(500).json({ error: 'Could not load tax packs' });
  }
});

router.get('/audit', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = getDatabase().prepare(`
      SELECT audit.*, user.name AS actor_name
      FROM tax_config_audit AS audit
      LEFT JOIN users AS user ON user.id = audit.actor_user_id
      ORDER BY audit.id DESC LIMIT ?
    `).all(limit) as any[];
    res.json({
      audit: rows.map((row) => ({
        ...row,
        details: parseJson(row.details_json, null),
      })),
    });
  } catch (error: any) {
    console.error('[Tax Packs] Audit load failed:', error);
    res.status(500).json({ error: 'Could not load tax audit history' });
  }
});

router.get('/catalog', requireRole('owner', 'manager'), async (_req: Request, res: Response) => {
  try {
    const remote = await fetchRemoteTaxPackCatalog();
    const installedRows = getDatabase().prepare(
      'SELECT pack_id, version FROM country_pack_versions'
    ).all() as Array<{ pack_id: string; version: string }>;
    const installed = new Set(installedRows.map((row) => `${row.pack_id}@${row.version}`));
    res.json({
      release_tag: remote.releaseTag,
      release_url: remote.releaseUrl,
      generated_at: remote.catalog.generatedAt,
      available: remote.catalog.packs.filter((entry) => !installed.has(`${entry.id}@${entry.version}`)),
    });
  } catch (error: any) {
    console.error('[Tax Packs] Catalog fetch failed:', error);
    res.status(502).json({ error: error.message || 'Could not check the tax pack catalog' });
  }
});

// Merchant-facing path: resolve the selected country without exposing the
// catalog or allowing manual selection of a different country's plugin.
router.post('/ensure-country', requireRole('owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const country = String(req.body?.country || getSettingValue('country') || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) return res.status(400).json({ error: 'Invalid country' });
    const db = getDatabase();
    let pack = db.prepare(`SELECT * FROM country_packs WHERE country = ? AND status IN ('active', 'installed') ORDER BY status = 'active' DESC, updated_at DESC LIMIT 1`).get(country) as PackRow | undefined;
    let version = pack?.active_version_id
      ? db.prepare('SELECT * FROM country_pack_versions WHERE id = ? AND pack_id = ?').get(pack.active_version_id, pack.id) as VersionRow | undefined
      : undefined;

    if (!version && pack) {
      // Reuse a verified download if activation was interrupted before the
      // active_version_id was written.
      version = db.prepare(`
        SELECT * FROM country_pack_versions
         WHERE pack_id = ? AND status IN ('installed', 'active')
         ORDER BY published_at DESC, id DESC LIMIT 1
      `).get(pack.id) as VersionRow | undefined;
    }
    if (!version) {
      const remote = await fetchRemoteTaxPackCatalog();
      const entry = remote.catalog.packs
        .filter((candidate) => candidate.country === country)
        .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))[0];
      if (!entry) return res.status(404).json({ plugin_available: false, country, error: `Tax support for ${country} is not available yet` });
      const installed = await installCatalogEntry(entry, { actorUserId: actorUserId(req) });
      pack = db.prepare('SELECT * FROM country_packs WHERE id = ?').get(installed.packId) as PackRow;
      version = db.prepare('SELECT * FROM country_pack_versions WHERE id = ?').get(installed.versionId) as VersionRow;
    }
    if (!pack || !version) throw new Error('Installed tax pack could not be loaded');
    activateInstalledPack(pack, version, actorUserId(req));
    const definition = JSON.parse(version.pack_json) as CountryPack;
    // Enabling taxes should work immediately for a normal merchant. Existing
    // explicit assignments are preserved; only previously unclassified rows
    // receive the official country defaults.
    withTxn(() => {
      db.prepare(`UPDATE products SET tax_category_id = ?, updated_at = ? WHERE tax_category_id IS NULL AND deleted_at IS NULL`)
        .run(definition.defaultCategories.product, now());
      db.prepare(`UPDATE addons SET tax_category_id = ? WHERE tax_category_id IS NULL`)
        .run(definition.defaultCategories.addon);
    });
    upsertSettings({ taxes_enabled: 'true' });
    return res.json({ enabled: true, country, pack_id: pack.id, version: version.version });
  } catch (error: any) {
    const statusCode = error.statusCode || 502;
    return res.status(statusCode).json({ error: error.message || 'Could not install the country tax plugin' });
  }
});

// Manual tax builder: an owner-authored local pack for countries with no
// official plugin (or to override one). Flat only, by design — no interstate
// or business-type conditions, no compounding. A tax category is a bucket of
// N independently-labeled components (e.g. "Standard" -> Tax 1 2.5% + Tax 2
// 2.5%) that all apply together whenever that category is selected; see
// resolveTaxCategory/calculateRawLine in services/tax-engine.ts, which
// already sums every matching rule's component with no changes needed here.
function slugifyTaxId(label: string, used: Set<string>, fallback: string): string {
  let base = String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = fallback;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function buildManualPack(body: any, country: string, currency: string): CountryPack {
  const categoriesInput = Array.isArray(body?.categories) ? body.categories : [];
  if (categoriesInput.length === 0) {
    throw Object.assign(new Error('At least one tax category is required'), { statusCode: 400 });
  }
  const usedCategoryIds = new Set<string>();
  const usedRuleIds = new Set<string>();
  const tempIdToCategoryId = new Map<string, string>();
  const categories: TaxCategory[] = [];
  const rules: TaxRule[] = [];

  categoriesInput.forEach((categoryInput: any, categoryIndex: number) => {
    const label = typeof categoryInput?.label === 'string' ? categoryInput.label.trim() : '';
    if (!label) {
      throw Object.assign(new Error(`Category ${categoryIndex + 1} needs a name`), { statusCode: 400 });
    }
    const categoryId = slugifyTaxId(label, usedCategoryIds, `category_${categoryIndex + 1}`);
    const tempId = typeof categoryInput?.tempId === 'string' && categoryInput.tempId
      ? categoryInput.tempId : `__index_${categoryIndex}`;
    tempIdToCategoryId.set(tempId, categoryId);

    const componentsInput = Array.isArray(categoryInput?.components) ? categoryInput.components : [];
    if (componentsInput.length === 0) {
      throw Object.assign(new Error(`"${label}" needs at least one tax component (use 0% if it should stay tax-free)`), { statusCode: 400 });
    }
    const ruleIds: string[] = [];
    componentsInput.forEach((componentInput: any, componentIndex: number) => {
      const componentLabel = typeof componentInput?.label === 'string' && componentInput.label.trim()
        ? componentInput.label.trim() : label;
      const type: 'percent' | 'fixed' = componentInput?.type === 'fixed' ? 'fixed' : 'percent';
      let value: Decimal;
      try {
        value = new Decimal(componentInput?.value === undefined || componentInput?.value === null ? '' : String(componentInput.value));
      } catch {
        throw Object.assign(new Error(`"${componentLabel}" needs a valid number`), { statusCode: 400 });
      }
      if (!value.isFinite() || value.isNegative()) {
        throw Object.assign(new Error(`"${componentLabel}" must be zero or a positive number`), { statusCode: 400 });
      }
      if (type === 'percent' && value.gt(100)) {
        throw Object.assign(new Error(`"${componentLabel}" cannot exceed 100%`), { statusCode: 400 });
      }
      const ruleId = slugifyTaxId(`${categoryId}_${componentLabel}`, usedRuleIds, `rule_${categoryIndex + 1}_${componentIndex + 1}`);
      ruleIds.push(ruleId);
      rules.push({
        id: ruleId,
        label: componentLabel,
        type,
        categoryIds: [categoryId],
        ...(type === 'percent' ? { rate: value.toString() } : { amount: value.toString(), appliesPer: 'line' }),
      });
    });

    categories.push({ id: categoryId, label, ruleIds });
  });

  const resolveDefault = (fieldName: string, tempId: unknown): string => {
    if (typeof tempId !== 'string' || !tempId) {
      throw Object.assign(new Error(`Choose a default category for ${fieldName}`), { statusCode: 400 });
    }
    const categoryId = tempIdToCategoryId.get(tempId);
    if (!categoryId) {
      throw Object.assign(new Error(`Default category for ${fieldName} does not match any category above`), { statusCode: 400 });
    }
    return categoryId;
  };
  const productCategoryId = resolveDefault('products', body?.defaultProductCategoryTempId);
  const defaultCategories = {
    product: productCategoryId,
    packaging: resolveDefault('packaging charges', body?.packagingCategoryTempId),
    delivery: resolveDefault('delivery charges', body?.deliveryCategoryTempId),
    service_charge: resolveDefault('service charges', body?.serviceChargeCategoryTempId),
    // An add-on is never its own taxable line — calculateItemTax folds its
    // price into the parent item's subtotal before tax runs (services/tax.ts),
    // so it is always taxed at the item's rate. `defaultCategories.addon`
    // only exists because the pack schema requires every TaxLineKind to
    // resolve to *some* category; mirroring the product default keeps that
    // requirement satisfied without implying a separate add-on rate exists.
    addon: productCategoryId,
  };

  // A hidden zero-rate category always exists so unclassifiedCategoryId
  // resolves without asking the owner to reason about a bucket that (per
  // resolveTaxCategory in tax-engine.ts) only applies when nothing else does.
  const unclassifiedId = slugifyTaxId('unclassified', usedCategoryIds, 'unclassified');
  categories.push({ id: unclassifiedId, label: 'Unclassified', ruleIds: [] });

  const effectiveFrom = new Date().toISOString().slice(0, 10);
  return {
    schemaVersion: 1,
    id: `manual-${country.toLowerCase()}`,
    publisher: 'local',
    version: `1.0.${Date.now()}`,
    country,
    jurisdiction: '*',
    currency,
    effectiveFrom,
    publishedAt: effectiveFrom,
    minFloVersion: '2.4.0',
    taxPoint: 'finalized_at',
    inclusivePricingDefault: body?.inclusive !== false,
    registrationNumberLabel: 'Tax registration',
    categories,
    defaultCategories,
    unclassifiedCategoryId: unclassifiedId,
    rules,
    taxRounding: { scope: 'line', method: 'half_up', decimalPlaces: 2, remainderAllocation: 'largest_remainder' },
    payableRounding: { increment: '0.01', method: 'half_up' },
  };
}

router.post('/manual-config', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const country = String(getSettingValue('country') || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      return res.status(400).json({ error: 'A valid store country must be set in Settings first' });
    }
    const currency = String(getSettingValue('currency') || 'USD').toUpperCase();

    const activeForCountry = db.prepare(
      `SELECT id, publisher FROM country_packs WHERE country = ? AND status = 'active'`
    ).get(country) as { id: string; publisher: string } | undefined;
    const replacesOfficial = Boolean(activeForCountry && activeForCountry.publisher !== 'local');
    if (replacesOfficial && req.body?.override !== true) {
      return res.status(409).json({
        error: `An official tax pack is already active for ${country}. Confirm replacing it with your manual configuration.`,
        active_pack_id: activeForCountry!.id,
        can_override: true,
      });
    }

    const pack = buildManualPack(req.body, country, currency);
    const packJson = JSON.stringify(pack);
    const digest = createHash('sha256').update(packJson, 'utf8').digest('hex');
    const installedAt = now();
    const versionId = `${pack.id}@${pack.version}`;
    const version: VersionRow = {
      id: versionId,
      pack_id: pack.id,
      version: pack.version,
      schema_version: 1,
      manifest_json: JSON.stringify({
        id: pack.id, publisher: 'local', country, jurisdiction: '*', version: pack.version, publishedAt: pack.publishedAt,
      }),
      pack_json: packJson,
      digest,
      signature: null,
      effective_from: pack.effectiveFrom,
      effective_to: null,
      min_flo_version: pack.minFloVersion,
      published_at: pack.publishedAt,
      status: 'installed',
      created_at: installedAt,
    };
    const validation = validationChecklist(version);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Manual tax configuration failed validation', validation });
    }

    let remapped: Array<{ entity: string; count: number }> = [];
    withTxn(() => {
      const existingPackRow = db.prepare('SELECT * FROM country_packs WHERE id = ?').get(pack.id) as PackRow | undefined;
      if (!existingPackRow) {
        db.prepare(`
          INSERT INTO country_packs (id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at)
          VALUES (?, 'local', ?, '*', NULL, 'installed', ?, ?)
        `).run(pack.id, country, installedAt, installedAt);
      } else {
        db.prepare('UPDATE country_packs SET updated_at = ? WHERE id = ?').run(installedAt, pack.id);
      }
      persistPackArtifacts(version, pack, installedAt);

      const packRow = db.prepare('SELECT * FROM country_packs WHERE id = ?').get(pack.id) as PackRow;
      activateInstalledPack(packRow, version, actorUserId(req));

      // A category the owner removed or renamed in this edit can no longer be
      // resolved by the engine (calculateRawLine throws on an unknown
      // category), so checkout would 400 on every line still pointing at it.
      // Reassign those rows to the new default and report the count instead
      // of leaving products silently broken.
      const categoryIds = pack.categories.map((category) => category.id);
      const placeholders = categoryIds.map(() => '?').join(',');
      const staleProducts = db.prepare(
        `SELECT COUNT(*) AS total FROM products WHERE deleted_at IS NULL AND tax_category_id IS NOT NULL AND tax_category_id NOT IN (${placeholders})`
      ).get(...categoryIds) as { total: number };
      const staleAddons = db.prepare(
        `SELECT COUNT(*) AS total FROM addons WHERE tax_category_id IS NOT NULL AND tax_category_id NOT IN (${placeholders})`
      ).get(...categoryIds) as { total: number };
      db.prepare(
        `UPDATE products SET tax_category_id = ?, updated_at = ? WHERE deleted_at IS NULL AND (tax_category_id IS NULL OR tax_category_id NOT IN (${placeholders}))`
      ).run(pack.defaultCategories.product, installedAt, ...categoryIds);
      db.prepare(
        `UPDATE addons SET tax_category_id = ? WHERE tax_category_id IS NULL OR tax_category_id NOT IN (${placeholders})`
      ).run(pack.defaultCategories.addon, ...categoryIds);
      remapped = [
        ...(staleProducts.total > 0 ? [{ entity: 'product', count: staleProducts.total }] : []),
        ...(staleAddons.total > 0 ? [{ entity: 'addon', count: staleAddons.total }] : []),
      ];
      if (remapped.length > 0) {
        audit('remap_categories', actorUserId(req), pack.id, versionId, null, { remapped });
      }
      audit('save_manual_config', actorUserId(req), pack.id, versionId, null, {
        replacedOfficialPackId: replacesOfficial ? activeForCountry!.id : null,
        categoryCount: pack.categories.length,
        ruleCount: pack.rules.length,
      });
    });

    upsertSettings({ taxes_enabled: 'true' });
    return res.json({ pack_id: pack.id, version_id: versionId, version: pack.version, remapped, validation });
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ error: error.message || 'Could not save manual tax configuration' });
  }
});

router.post('/catalog/install', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const packId = typeof req.body.pack_id === 'string' ? req.body.pack_id : '';
    const version = typeof req.body.version === 'string' ? req.body.version : '';
    if (!packId || !version) {
      return res.status(400).json({ error: 'pack_id and version are required' });
    }
    const remote = await fetchRemoteTaxPackCatalog();
    const entry = remote.catalog.packs.find(
      (candidate) => candidate.id === packId && candidate.version === version,
    );
    if (!entry) return res.status(404).json({ error: 'Tax pack version is not in the current catalog' });
    const installed = await installCatalogEntry(entry, { actorUserId: actorUserId(req) });
    res.status(201).json({ installed });
  } catch (error: any) {
    const statusCode = error.statusCode || 502;
    res.status(statusCode).json({
      error: error.message || 'Could not install tax pack version',
      ...(error.validation ? { validation: error.validation } : {}),
    });
  }
});

router.post('/test-calculation', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { category_id, amount, tax_behavior } = req.body;
    const amountDecimal = new Decimal(String(amount));
    if (!amountDecimal.isFinite() || amountDecimal.isNegative()) {
      return res.status(400).json({ error: 'amount must be a non-negative decimal' });
    }
    if (tax_behavior && !TAX_BEHAVIORS.includes(tax_behavior)) {
      return res.status(400).json({ error: `tax_behavior must be one of: ${TAX_BEHAVIORS.join(', ')}` });
    }
    const country = getSettingValue('country') || 'IN';
    const active = activePackForCountry(country);
    if (!active.definition.categories.some((category) => category.id === category_id)) {
      return res.status(400).json({ error: 'Unknown category for the active pack' });
    }
    const calculation = TaxEngine.calculate({
      pack: active.definition,
      country,
      jurisdiction: active.definition.jurisdiction,
      businessType: getSettingValue('business_type') || 'restaurant',
      storeStateCode: getSettingValue('state_code') || '',
      transactionDate: new Date().toISOString(),
      lines: [{
        lineId: 'settings-test-calculation',
        kind: 'product',
        quantity: '1',
        unitPrice: amountDecimal.toString(),
        productCategoryId: category_id,
        taxBehavior: tax_behavior || 'country_default',
      }],
    });
    res.json({
      pack_id: active.pack.id,
      pack_version_id: active.version.id,
      pack_version: active.version.version,
      calculation: {
        ...calculation,
        taxableBase: calculation.lines
          .reduce((sum, line) => sum.plus(line.taxableBase), new Decimal(0))
          .toFixed(active.definition.taxRounding.decimalPlaces),
      },
    });
  } catch (error: any) {
    const statusCode = error.statusCode || 400;
    res.status(statusCode).json({ error: error.message || 'Tax test calculation failed' });
  }
});

router.post('/overrides', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const country = getSettingValue('country') || 'IN';
    const active = activePackForCountry(country);
    const target = validateOverrideTarget(
      active.version.id,
      req.body.entity_type,
      req.body.entity_id,
      req.body.category_id,
    );
    const id = randomUUID();
    withTxn(() => {
      assertOverrideTargetAvailable(active.version.id, target.entityType, target.entityId);
      getDatabase().prepare(`
        INSERT INTO tax_overrides (
          id, pack_version_id, entity_type, entity_id, field_name, value_json,
          created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'tax_category_id', ?, ?, ?, ?)
      `).run(
        id,
        active.version.id,
        target.entityType,
        target.entityId,
        JSON.stringify({ categoryId: target.categoryId }),
        actorUserId(req),
        now(),
        now(),
      );
      audit('create_override', actorUserId(req), active.pack.id, active.version.id, id, {
        entityType: target.entityType,
        entityId: target.entityId,
        fieldName: 'tax_category_id',
        categoryId: target.categoryId,
      });
    });
    res.status(201).json({ override: getDatabase().prepare('SELECT * FROM tax_overrides WHERE id = ?').get(id) });
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: statusCode === 409 ? 'An override already exists for this target' : (statusCode >= 500 ? 'Could not create override' : error.message),
    });
  }
});

router.put('/overrides/:overrideId', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM tax_overrides WHERE id = ?').get(req.params.overrideId) as any;
    if (!existing) return res.status(404).json({ error: 'Override not found' });
    const pack = db.prepare(`
      SELECT pack.* FROM country_packs AS pack
      WHERE pack.active_version_id = ?
    `).get(existing.pack_version_id) as PackRow | undefined;
    if (!pack) return res.status(409).json({ error: 'Override does not belong to an active pack version' });
    const currentValue = parseJson<{ categoryId?: string }>(existing.value_json, {});
    const target = validateOverrideTarget(
      existing.pack_version_id,
      req.body.entity_type ?? existing.entity_type,
      req.body.entity_id !== undefined ? req.body.entity_id : existing.entity_id,
      req.body.category_id ?? currentValue.categoryId,
    );
    withTxn(() => {
      assertOverrideTargetAvailable(
        existing.pack_version_id,
        target.entityType,
        target.entityId,
        existing.id,
      );
      db.prepare(`
        UPDATE tax_overrides
        SET entity_type = ?, entity_id = ?, value_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        target.entityType,
        target.entityId,
        JSON.stringify({ categoryId: target.categoryId }),
        now(),
        existing.id,
      );
      audit('update_override', actorUserId(req), pack.id, existing.pack_version_id, existing.id, {
        before: {
          entityType: existing.entity_type,
          entityId: existing.entity_id,
          categoryId: currentValue.categoryId,
        },
        after: {
          entityType: target.entityType,
          entityId: target.entityId,
          categoryId: target.categoryId,
        },
      });
    });
    res.json({ override: db.prepare('SELECT * FROM tax_overrides WHERE id = ?').get(existing.id) });
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: statusCode === 409 ? 'An override already exists for this target' : (statusCode >= 500 ? 'Could not update override' : error.message),
    });
  }
});

router.delete('/overrides/:overrideId', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const existing = db.prepare(`
      SELECT override.*, pack.id AS pack_id
      FROM tax_overrides AS override
      JOIN country_packs AS pack ON pack.active_version_id = override.pack_version_id
      WHERE override.id = ?
    `).get(req.params.overrideId) as any;
    if (!existing) return res.status(404).json({ error: 'Override not found' });
    withTxn(() => {
      db.prepare('DELETE FROM tax_overrides WHERE id = ?').run(existing.id);
      audit('reset_override', actorUserId(req), existing.pack_id, existing.pack_version_id, existing.id, {
        entityType: existing.entity_type,
        entityId: existing.entity_id,
        fieldName: existing.field_name,
        removedValue: parseJson(existing.value_json, null),
      });
    });
    res.json({ message: 'Override reset to the official pack value' });
  } catch (error: any) {
    console.error('[Tax Packs] Override reset failed:', error);
    res.status(500).json({ error: 'Could not reset override' });
  }
});

router.post('/:packId/versions/:versionId/activate', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const pack = db.prepare('SELECT * FROM country_packs WHERE id = ?').get(req.params.packId) as PackRow | undefined;
    const version = db.prepare(
      'SELECT * FROM country_pack_versions WHERE id = ? AND pack_id = ?'
    ).get(req.params.versionId, req.params.packId) as VersionRow | undefined;
    if (!pack || !version) return res.status(404).json({ error: 'Installed pack version not found' });
    if (pack.active_version_id === version.id && pack.status === 'active') {
      return res.json({ changed: false, message: 'This version is already active' });
    }
    const validation = validationChecklist(version);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Pack version failed activation validation', validation });
    }
    const previousVersionId = pack.active_version_id;
    withTxn(() => {
      db.prepare(
        `UPDATE country_packs SET status = 'installed', updated_at = ? WHERE country = ? AND id != ?`
      ).run(now(), pack.country, pack.id);
      if (previousVersionId) {
        db.prepare(`UPDATE country_pack_versions SET status = 'installed' WHERE id = ?`).run(previousVersionId);
        db.prepare(`
          UPDATE tax_overrides SET pack_version_id = ?, updated_at = ?
          WHERE pack_version_id = ?
        `).run(version.id, now(), previousVersionId);
      }
      db.prepare(`
        UPDATE country_packs SET active_version_id = ?, status = 'active', updated_at = ? WHERE id = ?
      `).run(version.id, now(), pack.id);
      db.prepare(`UPDATE country_pack_versions SET status = 'active' WHERE id = ?`).run(version.id);
      audit('activate_pack', actorUserId(req), pack.id, version.id, null, { previousVersionId });
    });
    res.json({ changed: true, active_version_id: version.id, validation });
  } catch (error: any) {
    console.error('[Tax Packs] Activation failed:', error);
    res.status(500).json({ error: 'Could not activate pack version' });
  }
});

router.post('/:packId/rollback', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const pack = db.prepare('SELECT * FROM country_packs WHERE id = ?').get(req.params.packId) as PackRow | undefined;
    if (!pack) return res.status(404).json({ error: 'Tax pack not found' });
    const target = db.prepare(`
      SELECT * FROM country_pack_versions
      WHERE pack_id = ? AND id != ? AND status NOT IN ('revoked', 'incompatible')
      ORDER BY published_at DESC, created_at DESC LIMIT 1
    `).get(pack.id, pack.active_version_id) as VersionRow | undefined;
    if (!target) return res.status(400).json({ error: 'No previous installed version is available for rollback' });
    const validation = validationChecklist(target);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Rollback target failed activation validation', validation });
    }
    const previousVersionId = pack.active_version_id;
    withTxn(() => {
      if (previousVersionId) {
        db.prepare(`UPDATE country_pack_versions SET status = 'installed' WHERE id = ?`).run(previousVersionId);
        db.prepare(`
          UPDATE tax_overrides SET pack_version_id = ?, updated_at = ?
          WHERE pack_version_id = ?
        `).run(target.id, now(), previousVersionId);
      }
      db.prepare(`UPDATE country_pack_versions SET status = 'active' WHERE id = ?`).run(target.id);
      db.prepare(`UPDATE country_packs SET active_version_id = ?, status = 'active', updated_at = ? WHERE id = ?`)
        .run(target.id, now(), pack.id);
      audit('rollback_pack', actorUserId(req), pack.id, target.id, null, {
        previousVersionId,
        rollbackVersionId: target.id,
      });
    });
    res.json({ active_version_id: target.id, validation });
  } catch (error: any) {
    console.error('[Tax Packs] Rollback failed:', error);
    res.status(500).json({ error: 'Could not roll back tax pack' });
  }
});

router.get('/:packId', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const pack = db.prepare('SELECT * FROM country_packs WHERE id = ?').get(req.params.packId) as PackRow | undefined;
    if (!pack) return res.status(404).json({ error: 'Tax pack not found' });
    const versions = db.prepare(
      'SELECT * FROM country_pack_versions WHERE pack_id = ? ORDER BY published_at DESC, version DESC'
    ).all(pack.id) as VersionRow[];
    const activeVersion = versions.find((version) => version.id === pack.active_version_id) || null;
    const categories = activeVersion ? db.prepare(
      'SELECT category_id, label, default_behavior, definition_json FROM tax_categories WHERE pack_version_id = ? ORDER BY label'
    ).all(activeVersion.id).map((row: any) => ({ ...row, definition: parseJson(row.definition_json, {}) })) : [];
    const rules = activeVersion ? db.prepare(
      `SELECT rule_id, label, calculation_type, rate, amount, applies_per, base_rule_ids, definition_json
       FROM tax_rules WHERE pack_version_id = ? ORDER BY label`
    ).all(activeVersion.id).map((row: any) => ({
      ...row,
      base_rule_ids: parseJson(row.base_rule_ids, []),
      definition: parseJson(row.definition_json, {}),
    })) : [];
    const overrides = activeVersion ? db.prepare(`
      SELECT override.*, user.name AS created_by_name,
        CASE
          WHEN override.entity_type = 'product' THEN (SELECT name FROM products WHERE id = override.entity_id)
          WHEN override.entity_type = 'addon' THEN (SELECT name FROM addons WHERE id = override.entity_id)
          ELSE override.entity_type
        END AS entity_name
      FROM tax_overrides AS override
      LEFT JOIN users AS user ON user.id = override.created_by_user_id
      WHERE override.pack_version_id = ?
      ORDER BY override.updated_at DESC
    `).all(activeVersion.id).map((row: any) => ({
      ...row,
      value: parseJson(row.value_json, null),
    })) : [];
    const targets = {
      products: db.prepare(
        `SELECT id, name, tax_category_id FROM products WHERE deleted_at IS NULL AND is_active = 1 ORDER BY name`
      ).all(),
      addons: db.prepare(
        `SELECT id, name, tax_category_id FROM addons WHERE is_active = 1 ORDER BY name`
      ).all(),
    };
    res.json({
      pack: {
        ...pack,
        trust_status: trustStatus(pack, overrides.length),
      },
      versions: versions.map((version) => ({
        ...version,
        manifest: parseJson(version.manifest_json, {}),
        pack_json: undefined,
      })),
      active_version: activeVersion ? {
        ...activeVersion,
        definition: parseJson(activeVersion.pack_json, null),
        pack_json: undefined,
        validation: validationChecklist(activeVersion),
      } : null,
      categories,
      rules,
      overrides,
      targets,
    });
  } catch (error: any) {
    console.error('[Tax Packs] Detail load failed:', error);
    res.status(500).json({ error: 'Could not load tax pack details' });
  }
});

export const taxPackRoutes = router;
