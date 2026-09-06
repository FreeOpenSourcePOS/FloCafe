import * as path from 'path';

/** Resolves segments against root, returning absolute path if strictly contained within root. */
export function resolveContainedPath(root: string, ...segments: string[]): string | null {
  const resolvedRoot = path.resolve(root);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  // path.join normalizes '..' and treats absolute segments as sub-paths of root.
  const joined = path.join(resolvedRoot, ...segments);
  const resolved = path.resolve(joined);

  if (resolved === resolvedRoot) {
    return resolvedRoot;
  }
  if (!resolved.startsWith(rootWithSep)) {
    return null;
  }
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}
