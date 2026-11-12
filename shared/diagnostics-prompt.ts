/** When the error-report card may appear: never nagging, never over a running sale. */

/** Hard cap per install, so a declined ask is not repeated forever. */
export const DIAGNOSTICS_PROMPT_MAX = 3;

/** Minimum gap between two asks, in days. */
export const DIAGNOSTICS_PROMPT_MIN_INTERVAL_DAYS = 14;

export const DIAGNOSTICS_PROMPT_MIN_INTERVAL_MS =
  DIAGNOSTICS_PROMPT_MIN_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

export interface DiagnosticsPromptFacts {
  /** Error reports are already being sent. */
  enabled: boolean;
  /** The person chose "Don't ask again". */
  dismissed: boolean;
  /** How many times the card was shown on this device. */
  promptCount: number;
  /** ISO time of the last ask, or null when it was never shown. */
  lastAskedAt: string | null;
  /** Failures logged locally since the last ask. */
  problemsSince: number;
  now: number;
}

export function shouldShowDiagnosticsPrompt(facts: DiagnosticsPromptFacts): boolean {
  if (facts.enabled || facts.dismissed) return false;
  if (facts.problemsSince < 1) return false;
  if (facts.promptCount >= DIAGNOSTICS_PROMPT_MAX) return false;
  if (!facts.lastAskedAt) return true;
  const last = Date.parse(facts.lastAskedAt);
  // An unreadable timestamp must not silence the card forever.
  if (!Number.isFinite(last)) return true;
  return facts.now - last >= DIAGNOSTICS_PROMPT_MIN_INTERVAL_MS;
}
