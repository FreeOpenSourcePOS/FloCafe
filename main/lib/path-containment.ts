import * as path from 'path';

/**
 * Resolves `segments` against `root` and returns the normalized absolute path
 * only when it is strictly contained within `root`. Returns `null` when the
 * resolved path escapes `root` — via `..` segments, absolute segments, or any
 * other normalization that lands outside the root.
 *
 * This is a lexical containment check: `path.join`/`path.resolve` normalize
 * `..`, `.`, and redundant separators, and the result is compared against the
 * resolved root with a trailing separator so a sibling directory whose name
 * merely shares the root's prefix (e.g. `/var/www2`) cannot match.
 *
 * The final path is not `realpath`-resolved here. Callers that serve real
 * files still pass through `send`/`serve-static`, which resolves symlinks and
 * performs its own containment; this helper exists so the containment property
 * at each static-file boundary is explicit and statically verifiable.
 */
export function resolveContainedPath(root: string, ...segments: string[]): string | null {
  const resolvedRoot = path.resolve(root);
  // path.join (unlike path.resolve) does not discard earlier segments when a
  // later segment is absolute, so an absolute attacker segment is treated as a
  // sub-path of root rather than silently winning. It also normalizes `..`.
  const joined = path.join(resolvedRoot, ...segments);
  const resolved = path.resolve(joined);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolved;
}
