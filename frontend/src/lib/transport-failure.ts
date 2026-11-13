export const NETWORK_FAILURE_CLASSES = [
  'timeout',
  'dns',
  'connection_refused',
  'connection_reset',
  'aborted',
  'offline',
  'unreachable',
  'invalid_response',
  'unknown',
] as const;
export type NetworkFailureClass = (typeof NETWORK_FAILURE_CLASSES)[number];

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_TIMEOUT']);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE']);
const UNREACHABLE_CODES = new Set(['ERR_NETWORK', 'EHOSTUNREACH', 'ENETUNREACH']);
const ABORT_NAMES = new Set(['CanceledError', 'AbortError']);

/** Maps a request that produced no HTTP response onto the closed failure-class list. */
export function classifyTransportFailure(error: unknown): NetworkFailureClass {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  if (code === 'ERR_CANCELED' || (typeof name === 'string' && ABORT_NAMES.has(name)))
    return 'aborted';
  if (typeof code === 'string') {
    if (TIMEOUT_CODES.has(code)) return 'timeout';
    if (DNS_CODES.has(code)) return 'dns';
    if (code === 'ECONNREFUSED') return 'connection_refused';
    if (RESET_CODES.has(code)) return 'connection_reset';
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'offline';
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return 'unreachable';
  return 'unknown';
}
