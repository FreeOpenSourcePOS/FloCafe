/**
 * Semantic merchant print template model v1 (#447, epic #438).
 *
 * A merchant template describes SEMANTIC STRUCTURE only: an ordered subset
 * of PrintDocument v1 blocks (see ./document.ts) with presentation options
 * (visibility, order, label variants). It never contains printer commands,
 * HTML, or renderer snippets — one template feeds every renderer by being
 * applied to a built {@link PrintDocument} before rendering.
 *
 * TRUST MODEL (#447): merchant templates are ordinary tenant-owned data,
 * deliberately separate from compliance templates in
 * `installed_print_templates` (signed country-pack artifacts). A
 * `derivedFrom` reference to a pack template is user information ONLY — no
 * compliance trust ever transfers. Required legal blocks in compliance
 * templates stay enforced by the compliance system itself; merchant copies
 * are freely editable documents.
 *
 * COMPATIBILITY POLICY: `schemaVersion` is major-versioned from day one.
 * Readers MUST fail closed on unknown major versions (this module rejects
 * anything other than major version 1 on write/import). Unknown fields and
 * unknown blocks are REJECTED here — stricter than render-time tolerance —
 * because write-time rejection keeps stored payloads forward-compatible and
 * auditable. Field names are stable semantic identifiers; internal i18n
 * translation keys are never exposed as template fields.
 *
 * Note: issue #445's `escpos-line-template-v1` payloads are the LEGACY
 * compliance-oriented line-template format for country packs. This model is
 * a different contract on purpose; do not converge them. See
 * docs/merchant-print-templates.md.
 *
 * OFFLINE TRANSFER (#448): templates travel as `.json` envelopes carrying the
 * validated payload plus integrity checksum and informational origin metadata.
 * Import treats every file as untrusted input: size-capped, single JSON
 * document, structurally validated envelope, then the SAME fail-closed
 * payload validator used on every write path, then checksum verification.
 * Imports always land as a NEW draft row (`origin: 'imported'`) — never as
 * an activation, never overwriting an existing identity.
 *
 * PURITY RULES (same contract as the rest of `shared/print/`, see README.md):
 * types + pure functions only — no Electron, DOM, Node built-ins, DB,
 * filesystem, network, or transport IO.
 */

import type { PrintDocument, PrintDocumentBlock, SemanticLabel } from './document';

// ---------------------------------------------------------------------------
// Constants (public-facing contract — stable values)
// ---------------------------------------------------------------------------

/** Discriminator stored inside every merchant template payload. */
export const MERCHANT_TEMPLATE_FORMAT = 'flocafe-merchant-print-template';

/** Supported document types (v1 ships receipts only). */
export const MERCHANT_TEMPLATE_DOCUMENT_TYPES = ['receipt'] as const;
export type MerchantTemplateDocumentType = typeof MERCHANT_TEMPLATE_DOCUMENT_TYPES[number];

/** Current schema major version. Bumping this is a breaking contract change. */
export const MERCHANT_TEMPLATE_SCHEMA_VERSION = 1;

/** Hard payload size cap (~256 KB) enforced on write/import. */
export const MAX_MERCHANT_TEMPLATE_PAYLOAD_BYTES = 256 * 1024;

/** Same cap applied to the whole offline transfer ENVELOPE (#448). */
export const MAX_MERCHANT_TEMPLATE_ENVELOPE_BYTES = 256 * 1024;

/**
 * Discriminator of the offline transfer file format (#448, epic #438).
 *
 * The envelope is a self-describing portable wrapper around one validated
 * merchant template payload: `{ format, schemaVersion, exportedAt,
 * appVersion?, origin?, checksum, template }`. It is a PUBLIC CONTRACT
 * (documented in docs/merchant-print-templates.md): stable field names,
 * fail-closed on unknown majors, unknown fields rejected on import.
 */
export const MERCHANT_TEMPLATE_EXPORT_FORMAT = 'flocafe-merchant-template';

/** Current transfer-envelope schema major version. Breaking when bumped. */
export const MERCHANT_TEMPLATE_EXPORT_SCHEMA_VERSION = 1;

/** Ordered union of every PrintDocument v1 block kind — the allowed set. */
export const MERCHANT_TEMPLATE_BLOCK_KINDS = [
  'business-header',
  'customer',
  'document-meta',
  'item-table',
  'totals',
  'tax-breakdown',
  'payments',
  'message',
] as const;

export type MerchantTemplateBlockKind = (typeof MERCHANT_TEMPLATE_BLOCK_KINDS)[number];

/**
 * Whitelisted semantic label fields per block kind. Keys are STABLE semantic
 * identifiers of the label slot inside the rendered block — never internal
 * translation keys. Values are merchant-provided literal strings that replace
 * the resolved label text for every language variant.
 */
export const MERCHANT_TEMPLATE_LABEL_FIELDS: Readonly<
  Record<MerchantTemplateBlockKind, readonly string[]>
> = Object.freeze({
  'business-header': [],
  'document-meta': ['title', 'invoiceNumber'],
  'customer': [],
  'item-table': ['item', 'quantity', 'amount', 'note'],
  'tax-breakdown': [],
  'totals': ['subtotal', 'discount', 'tax', 'grandTotal', 'pointsRedeemed', 'pointsEarned', 'pointsBalance'],
  'payments': [],
  'message': ['reprintBanner', 'thankYou'],
});

// ---------------------------------------------------------------------------
// Offline transfer envelope (#448) — shape + pure structural validation
// ---------------------------------------------------------------------------

/** Optional informational provenance recorded inside an exported envelope. */
export interface MerchantTemplateEnvelopeOrigin {
  /** Merchant-template row id at export time (informational only; import
   *  always creates a NEW identity and never overwrites by id). */
  readonly sourceTemplateId?: string;
  /** Template name at export time; importers may reuse it as a label. */
  readonly sourceName?: string;
  /** Payload checksum at export time (sha256 hex of canonical payload text). */
  readonly sourceChecksum?: string;
}

/** Structural view of a validated envelope. Checksum VERIFICATION (hashing)
 * happens at the IO boundary: run {@link validateMerchantTemplate} on
 * `payload`, then compare `claimedChecksum` against the sha256 of
 * {@link serializeMerchantTemplatePayload}(payload) — the same canonical text
 * the service persists. */
export interface ValidatedMerchantTemplateEnvelope {
  readonly exportedAt: string;
  readonly appVersion?: string;
  readonly origin?: MerchantTemplateEnvelopeOrigin;
  /** Claimed integrity checksum (verified by the caller). */
  readonly claimedChecksum: string;
  readonly payload: MerchantPrintTemplatePayload;
}

export type MerchantTemplateEnvelopeValidation =
  | { readonly ok: true; readonly envelope: ValidatedMerchantTemplateEnvelope }
  | { readonly ok: false; readonly errors: readonly string[] };

const ENVELOPE_ROOT_FIELDS = ['format', 'schemaVersion', 'exportedAt', 'appVersion', 'origin', 'checksum', 'template'];
const ENVELOPE_ORIGIN_FIELDS = ['sourceTemplateId', 'sourceName', 'sourceChecksum'];
const ISO8601_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UNSAFE_LABEL_TEXT_PATTERN = /[\u0000-\u001F\u007F]|\{[A-Z_/]+\}/;

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

function isIso8601DateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO8601_DATE_TIME_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) return false;

  if (match[7] !== 'Z') {
    const offset = /^[+-](\d{2}):(\d{2})$/.exec(match[7]);
    if (!offset || Number(offset[1]) > 23 || Number(offset[2]) > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/**
 * Structurally validate a PARSED offline transfer envelope (pure). Enforces
 * the #448 unknown-field-reject policy on the root and origin objects, the
 * format discriminator, the fail-closed envelope schema-major gate, and a
 * well-formed ISO-8601 `exportedAt`. The embedded TEMPLATE payload is NOT
 * validated here — run {@link validateMerchantTemplate} on it so exactly one
 * validator owns payload rules. Checksum equality is likewise verified by
 * the caller (it needs hashing); this function only checks its SHA-256 shape.
 */
export function validateMerchantTemplateEnvelope(value: unknown): MerchantTemplateEnvelopeValidation {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['transfer file must be a single JSON object'] };
  }

  for (const key of Object.keys(value)) {
    if (!ENVELOPE_ROOT_FIELDS.includes(key)) {
      reject(errors, `root: unknown field "${key}" (allowed: ${ENVELOPE_ROOT_FIELDS.join(', ')})`);
    }
  }

  if (value.format !== MERCHANT_TEMPLATE_EXPORT_FORMAT) {
    reject(errors, `root.format: expected "${MERCHANT_TEMPLATE_EXPORT_FORMAT}", got ${JSON.stringify(value.format)}`);
  }
  if (value.schemaVersion !== MERCHANT_TEMPLATE_EXPORT_SCHEMA_VERSION) {
    reject(errors, `root.schemaVersion: unsupported transfer-file version ${JSON.stringify(value.schemaVersion)}; this build supports major version ${MERCHANT_TEMPLATE_EXPORT_SCHEMA_VERSION} only`);
  }
  if (!isIso8601DateTime(value.exportedAt)) {
    reject(errors, 'root.exportedAt: expected an ISO-8601 date-time string');
  }
  if (value.appVersion !== undefined && typeof value.appVersion !== 'string') {
    reject(errors, 'root.appVersion: expected a string');
  }
  if (!isSha256Hex(value.checksum)) {
    reject(errors, 'root.checksum: expected a sha256 hex digest of the template payload');
  }

  if (!isPlainObject(value.template)) {
    reject(errors, 'root.template: expected the merchant template payload as a JSON object');
  }

  let origin: MerchantTemplateEnvelopeOrigin | undefined;
  if (value.origin !== undefined) {
    if (!isPlainObject(value.origin)) {
      reject(errors, 'root.origin: expected an object with informational source metadata');
    } else {
      for (const key of Object.keys(value.origin)) {
        if (!ENVELOPE_ORIGIN_FIELDS.includes(key)) {
          reject(errors, `root.origin: unknown field "${key}" (allowed: ${ENVELOPE_ORIGIN_FIELDS.join(', ')})`);
        }
      }
      for (const key of ENVELOPE_ORIGIN_FIELDS) {
        const entry = value.origin[key];
        if (entry !== undefined && typeof entry !== 'string') {
          reject(errors, `root.origin.${key}: expected a string`);
        }
      }
      origin = {
        ...(typeof value.origin.sourceTemplateId === 'string' ? { sourceTemplateId: value.origin.sourceTemplateId } : {}),
        ...(typeof value.origin.sourceName === 'string' ? { sourceName: value.origin.sourceName } : {}),
        ...(typeof value.origin.sourceChecksum === 'string' ? { sourceChecksum: value.origin.sourceChecksum } : {}),
      };
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    envelope: {
      exportedAt: value.exportedAt as string,
      ...(typeof value.appVersion === 'string' ? { appVersion: value.appVersion } : {}),
      ...(origin ? { origin } : {}),
      claimedChecksum: value.checksum as string,
      // Raw template object as parsed; callers must run validateMerchantTemplate
      // on it before treating this value as a trusted payload.
      payload: value.template as unknown as MerchantPrintTemplatePayload,
    },
  };
}

// ---------------------------------------------------------------------------
// Payload shape (what merchants store)
// ---------------------------------------------------------------------------

/** One block entry: which PrintDocument block to render, and how. */
export interface MerchantTemplateBlockSpec {
  /** Block kind from the PrintDocument v1 vocabulary. */
  readonly kind: MerchantTemplateBlockKind;
  /** Hide this block without removing it from the ordered list. Default true. */
  readonly visible?: boolean;
  /**
   * Label variants: replaces the RESOLVED label text of whitelisted semantic
   * slots with merchant literals (applied to every language variant).
   */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Versioned merchant template payload. Exactly these four root fields exist
 * in v1; anything else is rejected on write/import.
 */
export interface MerchantPrintTemplatePayload {
  readonly format: typeof MERCHANT_TEMPLATE_FORMAT;
  readonly documentType: MerchantTemplateDocumentType;
  readonly schemaVersion: typeof MERCHANT_TEMPLATE_SCHEMA_VERSION;
  /**
   * The complete block composition, in render order. A block absent from
   * this list is NOT rendered; visibility can additionally hide an entry.
   */
  readonly blocks: readonly MerchantTemplateBlockSpec[];
}

/** Discriminated validation result with actionable, pointer-carrying errors. */
export type MerchantTemplateValidation =
  | { readonly ok: true; readonly payload: MerchantPrintTemplatePayload }
  | { readonly ok: false; readonly errors: readonly string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reject(accumulated: string[], message: string): void {
  accumulated.push(message);
}

/**
 * Validate an already-parsed merchant template payload. Pure; returns every
 * violation found (not just the first) so import UIs can show actionable
 * errors. Unknown schema majors, unknown formats/document types, unknown
 * blocks, unknown fields, duplicate blocks, and wrong types all fail.
 */
export function validateMerchantTemplate(value: unknown): MerchantTemplateValidation {
  const errors: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, errors: ['template payload must be a JSON object'] };
  }

  // --- Root field whitelist -------------------------------------------------
  const allowedRootFields = ['format', 'documentType', 'schemaVersion', 'blocks'];
  for (const key of Object.keys(value)) {
    if (!allowedRootFields.includes(key)) {
      reject(errors, `root: unknown field "${key}" (allowed: ${allowedRootFields.join(', ')})`);
    }
  }

  // --- Format discriminator -------------------------------------------------
  if (value.format !== MERCHANT_TEMPLATE_FORMAT) {
    reject(errors, `root.format: expected "${MERCHANT_TEMPLATE_FORMAT}", got ${JSON.stringify(value.format)}`);
  }

  // --- Document type --------------------------------------------------------
  if (!MERCHANT_TEMPLATE_DOCUMENT_TYPES.includes(value.documentType as MerchantTemplateDocumentType)) {
    reject(errors, `root.documentType: unsupported document type ${JSON.stringify(value.documentType)} (supported: ${MERCHANT_TEMPLATE_DOCUMENT_TYPES.join(', ')})`);
  }

  // --- Schema version gate (fail-closed on unknown majors) ------------------
  if (value.schemaVersion !== MERCHANT_TEMPLATE_SCHEMA_VERSION) {
    reject(errors, `root.schemaVersion: unsupported schema version ${JSON.stringify(value.schemaVersion)}; this build supports major version ${MERCHANT_TEMPLATE_SCHEMA_VERSION} only`);
  }

  // --- Blocks ---------------------------------------------------------------
  if (!Array.isArray(value.blocks)) {
    reject(errors, 'root.blocks: expected a non-empty array of block entries');
  } else {
    if (value.blocks.length === 0) {
      reject(errors, 'root.blocks: expected a non-empty array of block entries');
    }
    const seenKinds = new Set<string>();
    value.blocks.forEach((entry, index) => {
      const at = `blocks[${index}]`;
      if (!isPlainObject(entry)) {
        reject(errors, `${at}: each block entry must be a JSON object`);
        return;
      }
      const allowedBlockFields = ['kind', 'visible', 'labels'];
      for (const key of Object.keys(entry)) {
        if (!allowedBlockFields.includes(key)) {
          reject(errors, `${at}: unknown field "${key}" (allowed: ${allowedBlockFields.join(', ')})`);
        }
      }
      const kind = entry.kind;
      if (typeof kind !== 'string' || !MERCHANT_TEMPLATE_BLOCK_KINDS.includes(kind as MerchantTemplateBlockKind)) {
        reject(errors, `${at}.kind: unknown block kind ${JSON.stringify(kind)} (allowed: ${MERCHANT_TEMPLATE_BLOCK_KINDS.join(', ')})`);
        return;
      }
      if (seenKinds.has(kind)) {
        reject(errors, `${at}.kind: duplicate block "${kind}" — each block may appear at most once`);
      }
      seenKinds.add(kind);

      if (entry.visible !== undefined && typeof entry.visible !== 'boolean') {
        reject(errors, `${at}.visible: expected a boolean`);
      }

      if (entry.labels !== undefined) {
        if (!isPlainObject(entry.labels)) {
          reject(errors, `${at}.labels: expected an object of semantic label field -> literal text`);
        } else {
          const allowedLabels = MERCHANT_TEMPLATE_LABEL_FIELDS[kind as MerchantTemplateBlockKind];
          for (const [key, fieldValue] of Object.entries(entry.labels)) {
            if (!allowedLabels.includes(key)) {
              reject(errors, `${at}.labels: unknown label field "${key}" for block "${kind}" (allowed: ${allowedLabels.length > 0 ? allowedLabels.join(', ') : 'none'})`);
            }
            if (typeof fieldValue !== 'string') {
              reject(errors, `${at}.labels.${key}: expected a literal string`);
            } else if (UNSAFE_LABEL_TEXT_PATTERN.test(fieldValue)) {
              reject(errors, `${at}.labels.${key}: contains printer control characters or tokens`);
            }
          }
        }
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: value as unknown as MerchantPrintTemplatePayload,
  };
}

/**
 * Validate a raw JSON TEXT payload: enforces the ~256 KB size cap, then
 * parses and validates. Use this on every write/import path.
 */
export function validateMerchantTemplateText(raw: string): MerchantTemplateValidation {
  const byteLength = new TextEncoder().encode(raw).length;
  if (byteLength > MAX_MERCHANT_TEMPLATE_PAYLOAD_BYTES) {
    return {
      ok: false,
      errors: [`payload is ${byteLength} bytes; the maximum allowed size is ${MAX_MERCHANT_TEMPLATE_PAYLOAD_BYTES} bytes`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`payload is not valid JSON: ${(error as Error).message}`] };
  }
  return validateMerchantTemplate(parsed);
}

/**
 * Canonical JSON text of a VALIDATED payload: object keys recursively sorted,
 * array order untouched (block order is semantic), no insignificant
 * whitespace. This exact text is what the service persists and the only text
 * integrity checksums hash (table column + transfer envelope), so
 * whitespace/key-order reformatting of a payload never changes its digest.
 */
export function serializeMerchantTemplatePayload(payload: MerchantPrintTemplatePayload): string {
  return JSON.stringify(canonicalizeJson(payload));
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Applying a template to a built document (pure)
// ---------------------------------------------------------------------------

/**
 * Replace a label's resolved text with the merchant's literal. Both language
 * variants receive the SAME literal — merchant overrides are language-neutral
 * text by design; the conceptId stays for provenance/debuggability.
 */
function overrideLabel(label: SemanticLabel, text: string): SemanticLabel {
  return Object.freeze({
    ...(label.conceptId !== undefined ? { conceptId: label.conceptId } : {}),
    primary: text,
    secondary: text,
  });
}

function applyLabelOverrides(
  block: PrintDocumentBlock,
  labels: Readonly<Record<string, string>>,
): PrintDocumentBlock {
  switch (block.kind) {
    case 'document-meta': {
      return Object.freeze({
        ...block,
        ...(labels.title !== undefined && block.title ? { title: overrideLabel(block.title, labels.title) } : {}),
        ...(labels.invoiceNumber !== undefined ? { invoiceNumberLabel: overrideLabel(block.invoiceNumberLabel, labels.invoiceNumber) } : {}),
      });
    }
    case 'item-table': {
      return Object.freeze({
        ...block,
        header: Object.freeze({
          item: labels.item !== undefined ? overrideLabel(block.header.item, labels.item) : block.header.item,
          quantity: labels.quantity !== undefined ? overrideLabel(block.header.quantity, labels.quantity) : block.header.quantity,
          amount: labels.amount !== undefined ? overrideLabel(block.header.amount, labels.amount) : block.header.amount,
        }),
        ...(labels.note !== undefined ? { noteLabel: overrideLabel(block.noteLabel, labels.note) } : {}),
      });
    }
    case 'totals': {
      return Object.freeze({
        ...block,
        subtotal: labels.subtotal !== undefined ? { ...block.subtotal, label: overrideLabel(block.subtotal.label, labels.subtotal) } : block.subtotal,
        discount: block.discount && labels.discount !== undefined
          ? { ...block.discount, label: overrideLabel(block.discount.label, labels.discount) }
          : block.discount,
        tax: block.tax && labels.tax !== undefined
          ? { ...block.tax, label: overrideLabel(block.tax.label, labels.tax) }
          : block.tax,
        grandTotal: labels.grandTotal !== undefined
          ? { ...block.grandTotal, label: overrideLabel(block.grandTotal.label, labels.grandTotal) }
          : block.grandTotal,
        pointsRedeemed: block.pointsRedeemed && labels.pointsRedeemed !== undefined
          ? { ...block.pointsRedeemed, label: overrideLabel(block.pointsRedeemed.label, labels.pointsRedeemed) }
          : block.pointsRedeemed,
        pointsEarned: block.pointsEarned && labels.pointsEarned !== undefined
          ? { ...block.pointsEarned, label: overrideLabel(block.pointsEarned.label, labels.pointsEarned) }
          : block.pointsEarned,
        pointsBalance: block.pointsBalance && labels.pointsBalance !== undefined
          ? { ...block.pointsBalance, label: overrideLabel(block.pointsBalance.label, labels.pointsBalance) }
          : block.pointsBalance,
      });
    }
    case 'message': {
      return Object.freeze({
        ...block,
        reprintBanner: block.reprintBanner && labels.reprintBanner !== undefined
          ? overrideLabel(block.reprintBanner, labels.reprintBanner)
          : block.reprintBanner,
        thankYou: block.thankYou && labels.thankYou !== undefined
          ? overrideLabel(block.thankYou, labels.thankYou)
          : block.thankYou,
      });
    }
    default:
      // Blocks without label fields pass through unchanged.
      return block;
  }
}

/**
 * Apply a validated merchant template to a built PrintDocument: selects the
 * configured blocks (in the template's order, honoring `visible`) and applies
 * label variants. Pure — returns a new frozen document; the input is untouched.
 */
export function applyMerchantTemplate(
  document: PrintDocument,
  payload: MerchantPrintTemplatePayload,
): PrintDocument {
  const byKind = new Map<string, PrintDocumentBlock>(
    document.blocks.map((block) => [block.kind, block]),
  );
  const blocks: PrintDocumentBlock[] = [];
  for (const spec of payload.blocks) {
    if (spec.visible === false) continue;
    const block = byKind.get(spec.kind);
    if (!block) continue;
    blocks.push(spec.labels !== undefined ? applyLabelOverrides(block, spec.labels) : block);
  }
  return Object.freeze({
    ...document,
    blocks: Object.freeze(blocks),
  });
}
