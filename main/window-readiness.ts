let rendererReady = false;

export function resetWindowReadiness(): void {
  rendererReady = false;
}

export function markWindowRendererReady(): void {
  rendererReady = true;
}

export function isWindowRendererReady(): boolean {
  return rendererReady;
}
