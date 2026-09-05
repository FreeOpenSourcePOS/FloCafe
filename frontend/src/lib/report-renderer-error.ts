/**
 * Sends a caught render exception to anonymous telemetry via main (see
 * main/ipc.ts report-renderer-error). Resolves to whether it actually sent —
 * false outside Electron, when telemetry is disabled, or on any failure —
 * so callers can show an honest outcome instead of assuming success. Never
 * rejects: this must not become a second failure on top of the one it's
 * reporting.
 */
export async function reportRendererError(error: Error & { digest?: string }, route?: string): Promise<boolean> {
  try {
    const result = await window.electronAPI?.reportRendererError?.({
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      route: route ?? (typeof window !== 'undefined' ? window.location.pathname : undefined),
    });
    return result?.success ?? false;
  } catch {
    return false;
  }
}
