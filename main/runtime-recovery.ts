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
