/**
 * Separator normalisation for the static source audits.
 *
 * Forward slashes are the canonical form for a repository-relative path: that is
 * how every allowlist, prefix check, and string key in the audits is written. A
 * host-native path is the thing that has to be converted, because `path.relative`
 * returns backslashes on Windows, and an unconverted comparison made every
 * forward-slash allowlist entry miss. The audits then either failed on an
 * intentionally reviewed file or skipped a guard entirely, while passing on
 * macOS and Linux.
 */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}
