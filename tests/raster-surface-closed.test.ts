import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChromiumRasterRenderer } from '../main/printers/raster-renderer';

// Electron's native getters throw "Object has been destroyed" once a window closes.
function closedSurface(contents: EventEmitter): EventEmitter & Record<string, any> {
  const surface = new EventEmitter() as EventEmitter & Record<string, any>;
  let destroyed = false;
  surface.on('closed', () => {
    destroyed = true;
  });
  Object.defineProperty(surface, 'webContents', {
    get() {
      if (destroyed) throw new TypeError('Object has been destroyed');
      return contents;
    },
  });
  surface.isDestroyed = () => destroyed;
  surface.markDestroyed = () => {
    destroyed = true;
  };
  surface.close = () => surface.emit('closed');
  return surface;
}

const request = {
  version: 1 as const,
  requestId: 'closed-surface-1',
  text: 'Receipt',
  widthDots: 576,
  maxBandHeight: 200,
  direction: 'ltr' as const,
  style: 'normal' as const,
  financial: false,
  maxLines: 4,
};

/** A closed raster window must not crash teardown, and must fail pending renders. */
async function surfaceClosedTest(): Promise<void> {
  const ipc = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), {
    loadURL: async () => undefined,
    send: () => undefined,
  });
  const surface = closedSurface(contents);
  const renderer = new ChromiumRasterRenderer({
    timeoutMs: 1000,
    ipc: ipc as any,
    windowFactory: () => surface as any,
  });

  ipc.emit('flo:raster-ready', { sender: contents });
  const pending = renderer.render(request);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.doesNotThrow(() => surface.emit('closed'));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal((result as any).code, 'render-failed');
  assert.equal(renderer.isDestroyed(), true);
  assert.doesNotThrow(() => renderer.destroy());
  assert.equal((await renderer.render(request)).ok, false);
}

/** IPC that arrives after the window is destroyed, before `closed`, must not read webContents. */
function ipcAfterDestroyTest(): void {
  const ipc = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), { loadURL: async () => undefined });
  const surface = closedSurface(contents);
  new ChromiumRasterRenderer({
    timeoutMs: 1000,
    ipc: ipc as any,
    windowFactory: () => surface as any,
  });
  surface.markDestroyed();
  assert.doesNotThrow(() => ipc.emit('flo:raster-ready', { sender: contents }));
}

ipcAfterDestroyTest();
void surfaceClosedTest().then(
  () => console.log('raster-surface-closed: passed'),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
