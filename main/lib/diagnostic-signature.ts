/**
 * Derived diagnostic signatures.
 *
 * A stored diagnostic never carries the raw exception message: that message is
 * exactly where customer data appears (names, phone numbers, amounts, file
 * paths). Instead the message is reduced to a template in which every
 * confidently classified literal becomes a typed placeholder and everything
 * that cannot be classified is dropped, so the same failure on two different
 * tills - or on two different customers' tills - yields identical text.
 *
 * This is the single place that decides what a stored diagnostic says.
 */

const MAX_SOURCE_MESSAGE_CHARS = 400;
const MAX_TEMPLATE_CHARS = 240;
const ERROR_CLASS_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{6,}$/i;
const NUMBER_RE = /^[+-]?(?:\d{1,15}(?:\.\d+)?|\.\d+)$/;
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const QUOTED_RE = /^(["'`])([\s\S]*)\1$/;
const LEADING_PUNCTUATION_RE = /^[({\[]+/;
const TRAILING_PUNCTUATION_RE = /[)\]},.:;!?]+$/;

/**
 * Structural words that belong to a fixed error phrase rather than to a value.
 *
 * The list is derived from the repository's own diagnostic strings (the
 * approved event phrases, the POS order-failure text, the printer refusal
 * text) plus the SQLite phrase words, because those are words this application
 * chose. Everything absent from this list is dropped, which is the safe
 * default: a bare word that is not known to be structural may be a customer
 * name.
 *
 * This is a real, bounded leak surface and is not a filter that makes free
 * text impossible: a value composed entirely of these words - "Order Only",
 * "Table Key" - survives, because the derivation cannot tell it from the fixed
 * phrase around it. The guarantee is per token, not per message.
 */
const SAFE_WORDS = new Set([
  'a', 'aborted', 'all', 'an', 'and', 'any', 'app', 'are', 'at', 'attempted',
  'available', 'be', 'been', 'blank', 'browser', 'browsers', 'busy', 'by', 'can', 'canceled',
  'cancelled', 'cannot', 'check', 'column', 'columns', 'completed', 'compound', 'configured',
  'connection', 'could', 'constraint', 'copy', 'database', 'default', 'desktop', 'denied',
  'device', 'did', 'disabled', 'disk', 'do', 'document', 'duplicate', 'empty', 'error',
  'exists', 'failed', 'financial', 'found', 'foreign', 'from', 'group', 'groups',
  'has', 'having', 'image', 'in', 'incomplete', 'index', 'internal', 'invalid', 'into', 'is',
  'jobs', 'key', 'keys', 'kitchen', 'line', 'lines', 'locked', 'malformed', 'map', 'mismatch',
  'more', 'near', 'network', 'no', 'not', 'now', 'null', 'of', 'offline', 'on', 'one', 'only',
  'optional', 'order', 'orders', 'out', 'outside', 'overlap', 'payment', 'permission',
  'physical', 'placeholder', 'placement', 'print', 'printed', 'printer', 'query', 'queries',
  'queue', 'range', 'read', 'readonly', 'real', 'receipt', 'rejected', 'refused', 'rendered',
  'renderer', 'rendering', 'request', 'row', 'rows', 'select', 'semantic', 'server', 'source',
  'spooler', 'stage', 'storage', 'such', 'surface', 'syntax', 'table', 'tables', 'text',
  'than', 'the', 'this', 'timed', 'timeout', 'to', 'token', 'too', 'trigger', 'unit',
  'unavailable', 'unable', 'unexpected', 'unreachable', 'unique', 'unsupported', 'use', 'using',
  'validation', 'value', 'values', 'view', 'was', 'webusb', 'were', 'with', 'within',
]);

/**
 * Words after which a bare token is a schema reference rather than a value, e.g.
 * the `orders` in `no such table: orders`.
 */
const SCHEMA_SLOT_INTRODUCERS = new Set(['table', 'column', 'index', 'view', 'trigger', 'constraint']);

/** Plain-language opening clause per error class, so the operator reads a sentence. */
const CLASS_PHRASE: Record<string, string> = {
  sqliteerror: 'The database rejected a request',
  typeerror: 'A value had the wrong type',
  rangeerror: 'A value was outside the allowed range',
  referenceerror: 'A required value was missing',
  syntaxerror: 'A value was malformed',
  urierror: 'An address was malformed',
  error: 'An unexpected problem occurred',
};

export type DiagnosticSignature = {
  /** Normalised error class, e.g. `SQLiteError`. Never raw user input. */
  error_class: string;
  /** Stable grouping key and machine-readable cause, e.g. `SQLiteError: no such table: orders`. */
  signature: string;
  /** Plain-language line for the operator, e.g. `The database rejected a request: no such table: orders.` */
  summary: string;
};

function normaliseErrorClass(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return ERROR_CLASS_RE.test(candidate) ? candidate : 'Error';
}

/**
 * Splits a message on whitespace, but keeps a quoted span together so that a
 * quoted value is classified once as a whole rather than as loose words.
 */
function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  for (const ch of source) {
    if (quote) {
      current += ch;
      if (ch === quote) { tokens.push(current); current = ''; quote = ''; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (current) { tokens.push(current); current = ''; }
      quote = ch;
      current = ch;
      continue;
    }
    if (/\s/.test(ch)) { if (current) { tokens.push(current); current = ''; } continue; }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Classifies one token; returns the replacement text, or '' to drop it. */
function classifyToken(token: string, previousWord: string): string {
  if (QUOTED_RE.test(token)) return '<string>';
  if (ABSOLUTE_PATH_RE.test(token)) return '<path>';
  if (UUID_RE.test(token)) return '<id>';

  const prefix = LEADING_PUNCTUATION_RE.exec(token)?.[0] || '';
  const suffix = TRAILING_PUNCTUATION_RE.exec(token.slice(prefix.length))?.[0] || '';
  const core = token.slice(prefix.length, token.length - suffix.length);
  if (!core) return '';

  // Checked before the hex rule so an all-digit value (a phone number, a
  // count) is typed as a number rather than as an opaque identifier.
  if (NUMBER_RE.test(core)) return `${prefix}<number>${suffix}`;
  if (HEX_RE.test(core)) return `${prefix}<id>${suffix}`;

  const word = core.replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
  if (SAFE_WORDS.has(word)) return `${prefix}${core}${suffix}`;
  if (!SQL_IDENTIFIER_RE.test(core)) return '';
  // A dotted token such as `orders.customer_id` is a schema reference only in a
  // SQL phrase. Requiring the preceding word to be a known structural word stops
  // a dotted value elsewhere - a username, a hostname - from surviving.
  if (core.includes('.') && SAFE_WORDS.has(previousWord)) return `${prefix}${core}${suffix}`;
  if (SCHEMA_SLOT_INTRODUCERS.has(previousWord)) return `${prefix}${core}${suffix}`;
  return '';
}

/** Reduces an exception message to a literal-free template. */
export function deriveDiagnosticTemplate(rawMessage: unknown): string {
  const source = String(rawMessage ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE_MESSAGE_CHARS);
  if (!source) return '';

  const parts: string[] = [];
  let previousWord = '';
  for (const token of tokenize(source)) {
    const replacement = classifyToken(token, previousWord);
    const word = token.replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
    if (replacement) {
      parts.push(replacement);
      previousWord = word;
    } else {
      // Dropped token: the following token must not inherit it as a slot introducer.
      previousWord = '';
    }
  }

  return parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
    .slice(0, MAX_TEMPLATE_CHARS);
}

/**
 * The one code path that decides what a stored diagnostic says.
 *
 * `errorClass` comes from the thrown error's constructor; `message` is the raw
 * exception message and is never stored, only templated.
 */
export function deriveDiagnosticSignature(source: { errorClass?: unknown; message?: unknown } | null | undefined): DiagnosticSignature {
  const errorClass = normaliseErrorClass(source?.errorClass);
  const template = deriveDiagnosticTemplate(source?.message);
  const signature = template ? `${errorClass}: ${template}` : errorClass;
  const phrase = CLASS_PHRASE[errorClass.toLowerCase()] || CLASS_PHRASE.error;
  const summary = template ? `${phrase}: ${template}.` : `${phrase}.`;
  return { error_class: errorClass, signature, summary };
}

/** Class name of a thrown value, or `Error` when it is not an Error instance. */
export function errorClassOf(error: unknown): string {
  if (error instanceof Error && error.constructor?.name) return error.constructor.name;
  if (error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') {
    return normaliseErrorClass((error as { name: string }).name);
  }
  return 'Error';
}
