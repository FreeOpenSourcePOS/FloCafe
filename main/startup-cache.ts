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
// these caches whenever it doesn't match what's recorded avoids replaying
// cache built for a different engine build. A *missing* marker is treated
// the same as a mismatch (not skipped): it's what every profile that
// predates this check looks like on its first launch under the new code —
// exactly the upgrade path this exists to fix. Clearing is harmless when
// there's nothing to clear (rmSync with force:true is a no-op on paths that
// don't exist).
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

export interface CacheFsOps {
  readFileSync: typeof fs.readFileSync;
  writeFileSync: typeof fs.writeFileSync;
  rmSync: typeof fs.rmSync;
  mkdirSync: typeof fs.mkdirSync;
}

export function clearStaleRenderCachesOnVersionChange(
  userDataPath: string,
  currentElectronVersion: string,
  logger: Logger = console,
  fsOps: CacheFsOps = fs,
): void {
  const versionFile = path.join(userDataPath, VERSION_MARKER_FILENAME);
  let previousVersion: string | null = null;
  try {
    previousVersion = fsOps.readFileSync(versionFile, 'utf8').toString().trim();
  } catch {
    // No marker yet: either a brand-new profile (nothing to clear) or an
    // existing profile from before this check existed (needs clearing).
    // Fall through and let the mismatch branch below handle both.
  }

  if (previousVersion !== currentElectronVersion) {
    let allCleared = true;
    for (const dir of STALE_RENDER_CACHE_DIRS) {
      try {
        fsOps.rmSync(path.join(userDataPath, dir), { recursive: true, force: true });
      } catch (err) {
        allCleared = false;
        logger.warn(`[Flo] Failed to clear stale cache dir "${dir}":`, (err as Error).message);
      }
    }

    if (!allCleared) {
      // Leave the marker as it was so the next launch retries the
      // directories that failed to clear, instead of silently giving up.
      return;
    }

    logger.log(
      `[Flo] Electron version marker ${previousVersion ?? '(none)'} -> ${currentElectronVersion}; cleared render caches to avoid a stale-cache crash loop.`,
    );
  }

  try {
    fsOps.mkdirSync(userDataPath, { recursive: true });
    fsOps.writeFileSync(versionFile, currentElectronVersion, 'utf8');
  } catch (err) {
    logger.warn('[Flo] Failed to write Electron version marker:', (err as Error).message);
  }
}
