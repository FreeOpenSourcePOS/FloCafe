import * as fs from 'fs';
import * as path from 'path';

// A large Electron version jump (e.g. 31 -> 43) can leave V8 Code Cache and
// GPU shader cache entries in userData that were built for a different
// Chromium ABI. When the new Chromium replays that stale state, it can
// produce a malformed internal message; Chromium's IPC validator rejects it
// as a bad Mojo message on content.mojom.ChildProcessHost and force-kills
// the renderer (bad_message.cc, reason 123). Because the crash recovery path
// immediately recreates the window, it replays the same stale cache and
// crashes again — an infinite "Renderer process gone: killed" loop.
//
// Stamping the running Electron version per userData profile and wiping
// these caches the first time it changes (not on every launch) avoids
// replaying cache built for a different engine build.
export const STALE_RENDER_CACHE_DIRS = [
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Shader Cache',
];

const VERSION_MARKER_FILENAME = '.electron-version';

interface Logger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export function clearStaleRenderCachesOnVersionChange(
  userDataPath: string,
  currentElectronVersion: string,
  logger: Logger = console,
): void {
  const versionFile = path.join(userDataPath, VERSION_MARKER_FILENAME);
  let previousVersion: string | null = null;
  try {
    previousVersion = fs.readFileSync(versionFile, 'utf8').trim();
  } catch {
    // First run for this profile, or the marker predates this check —
    // nothing to compare against, so leave any existing cache alone.
  }

  if (previousVersion !== null && previousVersion !== currentElectronVersion) {
    for (const dir of STALE_RENDER_CACHE_DIRS) {
      try {
        fs.rmSync(path.join(userDataPath, dir), { recursive: true, force: true });
      } catch (err) {
        logger.warn(`[Flo] Failed to clear stale cache dir "${dir}":`, (err as Error).message);
      }
    }
    logger.log(
      `[Flo] Electron upgraded ${previousVersion} -> ${currentElectronVersion}; cleared render caches to avoid a stale-cache crash loop.`,
    );
  }

  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(versionFile, currentElectronVersion, 'utf8');
  } catch (err) {
    logger.warn('[Flo] Failed to write Electron version marker:', (err as Error).message);
  }
}
