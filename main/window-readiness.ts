/** Manages per-document renderer readiness and fail-safe window display. */

const RENDERER_READINESS_FAILSAFE_MS = 10_000;
const DOCUMENT_NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let rendererReadinessEpoch = 0;
let readyEpoch: number | null = null;
let rendererDocumentNonce: string | null = null;
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

/** Begins a fresh readiness epoch and arms the window display fail-safe. */
export function beginRendererDocument(): number {
  rendererReadinessEpoch += 1;
  readyEpoch = null;
  rendererDocumentNonce = null;
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

/** True only for a main-frame navigation that creates a new document. */
export function isFullDocumentMainFrameNavigation(details: {
  isMainFrame: boolean;
  isSameDocument: boolean;
}): boolean {
  return details.isMainFrame && !details.isSameDocument;
}

export function registerRendererDocument(documentNonce: unknown): boolean {
  if (typeof documentNonce !== 'string' || !DOCUMENT_NONCE_PATTERN.test(documentNonce)) return false;
  rendererDocumentNonce = documentNonce;
  return true;
}

export function getRendererDocumentNonce(): string | null {
  return rendererDocumentNonce;
}

/** Records a valid readiness report matching the current epoch. */
export function markWindowRendererReady(epoch: unknown, documentNonce: unknown): boolean {
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) return false;
  if (epoch !== rendererReadinessEpoch) return false;
  if (documentNonce !== rendererDocumentNonce) return false;
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
