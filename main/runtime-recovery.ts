export type RuntimeState = 'starting' | 'ready' | 'stopping' | 'failed';

export type RuntimeServices = {
  main: boolean;
  kds: boolean;
  serverApp: boolean;
};

export type RuntimeActivationAction = 'show' | 'create' | 'wait' | 'relaunch' | 'ignore';

export function isRuntimeHealthy(
  state: RuntimeState,
  services: RuntimeServices,
  shutdownRequested: boolean,
): boolean {
  return state === 'ready'
    && !shutdownRequested
    && services.main
    && services.kds
    && services.serverApp;
}

export function decideRuntimeActivationAction(input: {
  state: RuntimeState;
  hasWindow: boolean;
  services: RuntimeServices;
  shutdownRequested: boolean;
}): RuntimeActivationAction {
  if (input.shutdownRequested || input.state === 'stopping') return 'ignore';
  if (input.state === 'failed') return 'relaunch';
  if (input.state === 'starting') return 'wait';
  if (!isRuntimeHealthy(input.state, input.services, input.shutdownRequested)) return 'relaunch';
  return input.hasWindow ? 'show' : 'create';
}

export function createRelaunchGate(onRelaunch: (reason: string) => void): (reason: string) => boolean {
  let relaunchRequested = false;
  return (reason: string): boolean => {
    if (relaunchRequested) return false;
    relaunchRequested = true;
    onRelaunch(reason);
    return true;
  };
}

/**
 * createRelaunchGate() only bounds relaunches within a single process's
 * lifetime — a relaunched process gets a fresh gate on module load. This
 * checks whether the CURRENT process's own argv already carries the marker
 * a prior relaunch attempt appended, so a persistent failure (e.g. a
 * permanently occupied port) degrades to a clear dialog after one relaunch
 * instead of looping indefinitely across process restarts.
 */
export function hasRelaunchAttemptFlag(argv: readonly string[], attemptFlag: string): boolean {
  return argv.includes(attemptFlag);
}

/**
 * Bounds hasRelaunchAttemptFlag() to the window between process start and the
 * runtime's first successful recovery, rather than the whole process
 * lifetime. Without this, a process that carries the attempt marker (because
 * it is itself the result of a relaunch) would treat every later relaunch
 * request as a second failed attempt forever — even hours after that relaunch
 * succeeded and the runtime ran healthy — and show the manual-restart dialog
 * instead of trying to recover from a new, unrelated failure.
 */
export function createRelaunchAttemptGuard(processCarriesAttemptFlag: boolean): {
  hasExhaustedAttempt: () => boolean;
  markRuntimeRecovered: () => void;
} {
  let recovered = false;
  return {
    hasExhaustedAttempt: () => processCarriesAttemptFlag && !recovered,
    markRuntimeRecovered: () => { recovered = true; },
  };
}
