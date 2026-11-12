/** Counters behind the error-report card. The card decides; this stores the facts. */

import {
  getDatabase,
  getSettingValue,
  isDiagnosticsTransmissionEnabled,
  upsertSettings,
} from '../db';
import { DIAGNOSTICS_PROMPT_MAX } from '../../shared/diagnostics-prompt';

const COUNT_KEY = 'diagnostics_prompt_count';
const LAST_AT_KEY = 'diagnostics_prompt_last_at';
const DISMISSED_KEY = 'diagnostics_prompt_dismissed';

export interface DiagnosticsPromptState {
  enabled: boolean;
  dismissed: boolean;
  prompt_count: number;
  last_asked_at: string | null;
  problems_since: number;
}

function readCount(): number {
  const n = Number.parseInt(getSettingValue(COUNT_KEY) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readLastAskedAt(): string | null {
  return getSettingValue(LAST_AT_KEY) || null;
}

function countProblemsSince(askedAt: string | null): number {
  const db = getDatabase();
  const row = askedAt
    ? db
        .prepare(
          'SELECT COUNT(*) AS n FROM local_diagnostics WHERE datetime(created_at) > datetime(?)',
        )
        .get(askedAt)
    : db.prepare('SELECT COUNT(*) AS n FROM local_diagnostics').get();
  return Number((row as { n?: number } | undefined)?.n ?? 0);
}

export function readDiagnosticsPromptState(): DiagnosticsPromptState {
  const lastAskedAt = readLastAskedAt();
  return {
    enabled: isDiagnosticsTransmissionEnabled(),
    dismissed: getSettingValue(DISMISSED_KEY) === 'true',
    prompt_count: readCount(),
    last_asked_at: lastAskedAt,
    problems_since: countProblemsSince(lastAskedAt),
  };
}

/** Records an ask. The cap is enforced here, so a client cannot nag past it. */
export function recordDiagnosticsPromptShown(): DiagnosticsPromptState {
  const count = readCount();
  if (count < DIAGNOSTICS_PROMPT_MAX) {
    upsertSettings({
      [COUNT_KEY]: String(count + 1),
      [LAST_AT_KEY]: new Date().toISOString(),
    });
  }
  return readDiagnosticsPromptState();
}

export function dismissDiagnosticsPrompt(): DiagnosticsPromptState {
  upsertSettings({ [DISMISSED_KEY]: 'true' });
  return readDiagnosticsPromptState();
}
