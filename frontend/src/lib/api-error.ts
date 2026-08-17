import toast from 'react-hot-toast';

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface ApiErrorBody {
  error?: string;
  reason?: string;
  code?: string;
}

/**
 * Resolves a backend error into a localized user-facing message.
 *
 * Backend `error` strings are deliberately kept in English (for logs, support
 * tickets, and telemetry) and are never shown verbatim to the customer.
 * Resolution priority:
 *   1. A stable `reason`/`code` mapped to `<namespace>.<code>`.
 *   2. The caller-supplied localized fallback.
 */
export function apiErrorText(
  err: unknown,
  fallback: string,
  t: Translate,
  namespace = 'apiError',
): string {
  const data = (err as { response?: { data?: ApiErrorBody } })?.response?.data;
  const code = data?.reason || data?.code;
  if (code) {
    const key = `${namespace}.${code}`;
    const translated = t(key);
    // t() falls back to the key itself when missing — only use a real translation.
    if (translated !== key) return translated;
  }
  return fallback;
}

/** Shows a backend error as a localized toast (never the raw English string). */
export function toastApiError(
  err: unknown,
  fallback: string,
  t: Translate,
  namespace = 'apiError',
): void {
  toast.error(apiErrorText(err, fallback, t, namespace));
}
