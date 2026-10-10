// Owned fixture for the changed-file formatting gate (scripts/ci/check-changed-format.cjs):
// when only frontend formatter policy changes, this file proves the frontend Oxc scope can
// still select, launch and check a real file. It must stay byte-stable under Oxfmt.
export const FRONTEND_SCOPE_PROBE = 'frontend scope probe';

export function describeFrontendScopeProbe(): string {
  return FRONTEND_SCOPE_PROBE;
}
