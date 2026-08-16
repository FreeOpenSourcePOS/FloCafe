export interface LoginFailure {
  status: number | undefined;
  message: string | undefined;
  attemptsRemaining: number | undefined;
  lockoutMinutes: number | undefined;
}

/**
 * Normalizes an unknown login rejection into a shape the login page can route
 * safely (issue #229). Rejections can be Axios errors, plain `Error`s, strings,
 * or `null`/`undefined`; reading `.response` off a non-object would throw and
 * misroute the message. Anything without a valid Axios response shape returns
 * `status: undefined`, which callers treat as an availability/network failure
 * rather than a database or authentication error.
 */
export function parseLoginFailure(err: unknown): LoginFailure {
  const empty: LoginFailure = {
    status: undefined,
    message: undefined,
    attemptsRemaining: undefined,
    lockoutMinutes: undefined,
  };
  if (!err || typeof err !== 'object') return empty;

  const response = (err as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return empty;

  const r = response as { status?: unknown; data?: unknown };
  const data = r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : undefined;

  return {
    status: typeof r.status === 'number' ? r.status : undefined,
    message: typeof data?.error === 'string' ? data.error : undefined,
    attemptsRemaining: typeof data?.attempts_remaining === 'number' ? data.attempts_remaining : undefined,
    lockoutMinutes: typeof data?.lockout_minutes === 'number' ? data.lockout_minutes : undefined,
  };
}
