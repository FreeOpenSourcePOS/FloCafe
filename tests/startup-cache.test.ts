import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearStaleRenderCachesOnVersionChange, STALE_RENDER_CACHE_DIRS } from '../main/startup-cache';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeSilentLogger() {
  return { log: () => {}, warn: () => {} };
}

function withTempUserData(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-startup-cache-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── First run: no marker exists yet, so existing cache dirs (if any) must be left alone ──
withTempUserData((dir) => {
  const cacheDir = path.join(dir, 'GPUCache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'sentinel'), 'x');

  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', makeSilentLogger());

  assertEqual(fs.existsSync(path.join(cacheDir, 'sentinel')), true, 'first run must not touch existing cache');
  assertEqual(fs.readFileSync(path.join(dir, '.electron-version'), 'utf8'), '43.4.0', 'version marker written on first run');
});

// ── Same version on next launch: cache must be left alone ──
withTempUserData((dir) => {
  fs.writeFileSync(path.join(dir, '.electron-version'), '43.4.0');
  const cacheDir = path.join(dir, 'Code Cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'sentinel'), 'x');

  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', makeSilentLogger());

  assertEqual(fs.existsSync(path.join(cacheDir, 'sentinel')), true, 'unchanged version must not clear cache');
});

// ── Version changed since last launch: all known stale cache dirs must be wiped ──
withTempUserData((dir) => {
  fs.writeFileSync(path.join(dir, '.electron-version'), '31.7.7');
  for (const name of STALE_RENDER_CACHE_DIRS) {
    const cacheDir = path.join(dir, name);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'sentinel'), 'x');
  }
  // A directory that isn't a known stale-cache dir must survive untouched.
  fs.mkdirSync(path.join(dir, 'Local Storage'), { recursive: true });

  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', makeSilentLogger());

  for (const name of STALE_RENDER_CACHE_DIRS) {
    assertEqual(fs.existsSync(path.join(dir, name)), false, `${name} must be cleared after a version change`);
  }
  assertEqual(fs.existsSync(path.join(dir, 'Local Storage')), true, 'unrelated userData dirs must survive');
  assertEqual(fs.readFileSync(path.join(dir, '.electron-version'), 'utf8'), '43.4.0', 'version marker updated after clearing');
});

// ── A missing cache dir must not throw ──
withTempUserData((dir) => {
  fs.writeFileSync(path.join(dir, '.electron-version'), '31.7.7');
  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', makeSilentLogger());
  assertEqual(fs.readFileSync(path.join(dir, '.electron-version'), 'utf8'), '43.4.0', 'version marker updated even with no cache dirs present');
});

console.log('Startup render-cache tests passed');
