/** Forwards caught render exceptions to anonymous telemetry via Electron IPC;
 * returns boolean success without rejecting. */
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
