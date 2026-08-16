import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { resolveContainedPath } from '../main/lib/path-containment';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-path-containment-'));

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveContainedPath resolves a normal relative path inside root', () => {
  assert.equal(
    resolveContainedPath(root, 'a', 'b', 'index.html'),
    path.resolve(root, 'a', 'b', 'index.html'),
  );
});

test('resolveContainedPath returns null when .. escapes the root', () => {
  assert.equal(resolveContainedPath(root, '..', 'etc', 'passwd'), null);
  assert.equal(resolveContainedPath(root, 'a', '..', '..', '..', 'outside'), null);
});

test('resolveContainedPath normalizes .. that stays inside the root', () => {
  assert.equal(resolveContainedPath(root, 'a', '..', 'b'), path.resolve(root, 'b'));
});

test('resolveContainedPath rejects a sibling directory that shares the root prefix', () => {
  // `/var/www2` must not be treated as contained within `/var/www`.
  const sibling = `${root}2`;
  assert.equal(resolveContainedPath(root, '..', path.basename(sibling), 'x'), null);
});

test('resolveContainedPath treats an absolute later segment as a sub-path, not an override', () => {
  // path.join (not path.resolve) semantics: an absolute segment must not discard
  // the root and escape it. This matches the Windows __next. rewrite and the
  // `.${req.path}` SPA fallback, where req.path begins with `/`.
  assert.equal(
    resolveContainedPath(root, '/__next.foo', 'products', 'index.html'),
    path.resolve(root, '__next.foo', 'products', 'index.html'),
  );
});

test('resolveContainedPath with no segments returns the resolved root', () => {
  assert.equal(resolveContainedPath(root), path.resolve(root));
});
