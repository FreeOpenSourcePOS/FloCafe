// Owned fixture for the changed-file formatting gate (scripts/ci/check-changed-format.cjs):
// when only formatter policy changes, this file proves the root Oxc scope can still select,
// launch and check a real file. It must stay byte-stable under Oxfmt.
export const ROOT_SCOPE_PROBE = 'root scope probe';

export function describeRootScopeProbe(): string {
  return ROOT_SCOPE_PROBE;
}
