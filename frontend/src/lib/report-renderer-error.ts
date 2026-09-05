/**
 * Fire-and-forget: sends a caught render exception to anonymous telemetry via
 * main (see main/ipc.ts report-renderer-error). No-op outside Electron (e.g.
 * the frontend dev server in a browser) since window.electronAPI is undefined.
 */
export function reportRendererError(error: Error & { digest?: string }, route?: string): void {
  try {
    window.electronAPI?.reportRendererError?.({
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      route: route ?? (typeof window !== 'undefined' ? window.location.pathname : undefined),
    })?.catch(() => {});
  } catch {
    // Never let diagnostic reporting itself become a second failure.
  }
}
