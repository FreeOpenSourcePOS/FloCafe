export type SessionBoundaryEvent = 'lock' | 'pin-login' | 'login' | 'logout';

type SessionBoundaryListener = (event: SessionBoundaryEvent) => void;

const listeners = new Set<SessionBoundaryListener>();
let sessionBoundaryEpoch = 0;

export function getSessionBoundaryEpoch(): number {
  return sessionBoundaryEpoch;
}

export function onSessionBoundary(listener: SessionBoundaryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifySessionBoundary(event: SessionBoundaryEvent): void {
  sessionBoundaryEpoch += 1;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Listeners must not break auth transitions.
    }
  }
}
