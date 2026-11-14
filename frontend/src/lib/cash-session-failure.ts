/** Shift-close refusals that carry their own message, keyed by the display code
 *  the cash-session route answers with (main/routes/cash-sessions.ts). */
export type CashSessionCloseErrorKey = 'shiftCloseOwnerRequired';

export function cashSessionCloseErrorKey(payload: unknown): CashSessionCloseErrorKey | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { display_code?: unknown; code?: unknown };
  const code =
    typeof record.display_code === 'string'
      ? record.display_code
      : typeof record.code === 'string'
        ? record.code
        : null;
  if (code === 'session_owner_required') return 'shiftCloseOwnerRequired';
  return null;
}
