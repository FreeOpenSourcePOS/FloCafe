export interface LoginFailure {
  status: number | undefined;
  message: string | undefined;
  attemptsRemaining: number | undefined;
  lockoutMinutes: number | undefined;
}

/**
 * Normalizes an unknown login rejection into a structured failure shape.
 * Unstructured rejections return undefined status, treated as network/availability issues.
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
