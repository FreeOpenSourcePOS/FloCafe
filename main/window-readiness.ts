/**
 * Per-document renderer readiness lifecycle for the main POS window.
 *
 * The window starts hidden and is shown once the current document confirms
 * its window-control surface is present (native overlay confirmed, or HTML
 * fallback controls committed). Readiness is bound to an epoch token so the
 * lifecycle is coherent across reloads:
 *
 * - Every document load (`did-start-loading`, including the initial load)
 *   begins a new epoch, which invalidates any report from the previous
 *   document and re-arms a bounded fail-safe.
 * - The renderer learns the current epoch from `get-status` and reports
 *   readiness bound to it; stale-epoch or malformed reports are ignored.
 * - If the current epoch's document never confirms (renderer crash before
 *   mount, getStatus() rejection, hung load), the fail-safe fires and shows
 *   the window anyway: a visible window without verified controls beats an
 *   invisible POS forever, and the path taken is logged loudly.
 */

const RENDERER_READINESS_FAILSAFE_MS = 10_000;

let rendererReadinessEpoch = 0;
let readyEpoch: number | null = null;
let rendererReadinessFailSafeShown = false;
let showWindowFn: (() => void) | null = null;
let failsafeTimer: ReturnType<typeof setTimeout> | null = null;
let failsafeMs = RENDERER_READINESS_FAILSAFE_MS;

/** Registers the callback used to surface the window (fail-safe path). */
export function initWindowReadiness(
  showWindow: () => void,
  options?: { failsafeMs?: number },
): void {
  showWindowFn = showWindow;
  failsafeMs = Math.max(0, options?.failsafeMs ?? RENDERER_READINESS_FAILSAFE_MS);
}

function clearReadinessFailSafe(): void {
  if (failsafeTimer !== null) {
    clearTimeout(failsafeTimer);
    failsafeTimer = null;
  }
}

/**
 * Begins a fresh readiness epoch for an incoming document. Called on window
 * creation and on every `did-start-loading`; invalidates prior documents'
 * readiness reports and arms the fail-safe for this one.
 */
export function beginRendererDocument(): number {
  rendererReadinessEpoch += 1;
  readyEpoch = null;
  rendererReadinessFailSafeShown = false;
  clearReadinessFailSafe();

  const epoch = rendererReadinessEpoch;
  failsafeTimer = setTimeout(() => {
    failsafeTimer = null;
    if (epoch !== rendererReadinessEpoch) return;
    if (readyEpoch === epoch) return;
    rendererReadinessFailSafeShown = true;
    if (showWindowFn) {
      console.error(
        `[Window] Renderer readiness FAIL-SAFE fired for epoch ${epoch}: ` +
          'the renderer never confirmed its window-control surface (getStatus ' +
          'rejected/hung, or the document failed to mount controls). Showing ' +
          'the window anyway - visible-without-controls beats invisible.',
      );
      showWindowFn();
    }
  }, failsafeMs);

  return epoch;
}

export function getRendererReadinessEpoch(): number {
  return rendererReadinessEpoch;
}

/**
 * Records a readiness report bound to an epoch. Returns true only when the
 * report is well-formed and matches the current epoch; stale documents'
 * reports are rejected so a reload can never inherit readiness.
 */
export function markWindowRendererReady(epoch: unknown): boolean {
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) return false;
  if (epoch !== rendererReadinessEpoch) return false;
  readyEpoch = epoch;
  clearReadinessFailSafe();
  return true;
}

/** True when the current document's control surface has confirmed ready. */
export function isWindowRendererReady(): boolean {
  return readyEpoch === rendererReadinessEpoch && readyEpoch !== null && rendererReadinessEpoch > 0;
}

export function isRendererReadinessFailSafeShown(): boolean {
  return rendererReadinessFailSafeShown;
}

export function isCurrentRendererFrame(
  senderFrame: { frameToken?: string; detached?: boolean } | null | undefined,
  currentFrame: { frameToken?: string; detached?: boolean } | null | undefined,
): boolean {
  return Boolean(
    senderFrame
      && currentFrame
      && senderFrame.detached !== true
      && currentFrame.detached !== true
      && typeof senderFrame.frameToken === 'string'
      && senderFrame.frameToken === currentFrame.frameToken,
  );
}
