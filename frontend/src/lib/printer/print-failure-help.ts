/** Maps a print failure cause or class to one actionable English fix step. */

const CAUSES = [
  'paper_out',
  'cover_open',
  'printer_error',
  'offline',
  'unreachable',
  'queue_offline',
  'queue_offline_snmp',
  'queue_missing',
] as const;

export type PrintFailureCause = (typeof CAUSES)[number];

export type PrintHintPlatform = 'win32' | 'darwin' | 'linux';

type CauseKey = `printWarnings.fix.cause.${PrintFailureCause}`;
type ClassKey =
  | `printWarnings.fix.class.offline.${PrintHintPlatform}`
  | 'printWarnings.fix.class.queue_unavailable'
  | 'printWarnings.fix.class.driver_error'
  | 'printWarnings.fix.class.spooler_error'
  | 'printWarnings.fix.class.permission_denied'
  | 'printWarnings.fix.class.timeout'
  | 'printWarnings.fix.class.needs_attention';

export type PrintHintKey = CauseKey | ClassKey;

/** Root-scoped translator (`useTranslations()`), or the bootstrapped one in warnings.ts. */
export type PrintHintTranslator = (key: PrintHintKey) => string;

export interface PrintFailureHintInput {
  /** `failure_class` from the API, e.g. `offline` or `driver_error`. */
  failureClass?: string | null;
  /** Live cause from the printer itself; wins over `failureClass` when set. */
  cause?: string | null;
  /** `network` means a direct TCP printer, which has no OS queue to resume. */
  connectionType?: string | null;
  /** `window.electronAPI?.platform`; anything else gets the CUPS text. */
  platform?: string | null;
  /** Raw printer detail; a queue refusal from an SNMP-checked port carries its own fix. */
  detail?: string | null;
}

const CLASS_KEYS: Record<string, ClassKey> = {
  queue_unavailable: 'printWarnings.fix.class.queue_unavailable',
  driver_error: 'printWarnings.fix.class.driver_error',
  spooler_error: 'printWarnings.fix.class.spooler_error',
  permission_denied: 'printWarnings.fix.class.permission_denied',
  timeout: 'printWarnings.fix.class.timeout',
  needs_attention: 'printWarnings.fix.class.needs_attention',
};

const SNMP_OFFLINE_DETAIL_RE = /SNMP status is enabled on this printer port/i;

function hintPlatform(platform?: string | null): PrintHintPlatform {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

/** Platform of the machine running the till, for the toast paths outside React. */
export function currentHintPlatform(): string | null {
  if (typeof window === 'undefined') return null;
  return window.electronAPI?.platform ?? null;
}

/** The fix step for this failure, or null when the current message already helps. */
export function printFailureHint(
  input: PrintFailureHintInput,
  t: PrintHintTranslator,
): string | null {
  if (input.detail && SNMP_OFFLINE_DETAIL_RE.test(input.detail))
    return t('printWarnings.fix.cause.queue_offline_snmp');

  const cause = input.cause;
  if (cause && (CAUSES as readonly string[]).includes(cause))
    return t(`printWarnings.fix.cause.${cause as PrintFailureCause}` as PrintHintKey);

  const failureClass = input.failureClass;
  if (!failureClass) return null;
  // The queue-offline class and the printer-offline class need the same step on
  // each OS, so both read the same three messages.
  if (failureClass === 'offline' && input.connectionType === 'network')
    return t('printWarnings.fix.cause.unreachable');
  if (failureClass === 'offline' || failureClass === 'queue_offline') {
    return t(`printWarnings.fix.class.offline.${hintPlatform(input.platform)}` as PrintHintKey);
  }
  const classKey = CLASS_KEYS[failureClass];
  return classKey ? t(classKey) : null;
}
