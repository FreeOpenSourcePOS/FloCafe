import * as assert from 'node:assert/strict';
import {
  createRelaunchGate,
  decideRuntimeActivationAction,
  hasRelaunchAttemptFlag,
  isRuntimeHealthy,
} from '../main/runtime-recovery';

const healthyServices = { main: true, kds: true, serverApp: true };
const stoppedServices = { main: false, kds: false, serverApp: false };

assert.equal(isRuntimeHealthy('ready', healthyServices, false), true);
assert.equal(isRuntimeHealthy('ready', stoppedServices, false), false);
assert.equal(isRuntimeHealthy('ready', healthyServices, true), false);
assert.equal(isRuntimeHealthy('starting', healthyServices, false), false);

assert.equal(
  decideRuntimeActivationAction({
    state: 'ready',
    hasWindow: true,
    services: healthyServices,
    shutdownRequested: false,
  }),
  'show',
);
assert.equal(
  decideRuntimeActivationAction({
    state: 'ready',
    hasWindow: false,
    services: healthyServices,
    shutdownRequested: false,
  }),
  'create',
);
assert.equal(
  decideRuntimeActivationAction({
    state: 'starting',
    hasWindow: false,
    services: healthyServices,
    shutdownRequested: false,
  }),
  'wait',
);
assert.equal(
  decideRuntimeActivationAction({
    state: 'ready',
    hasWindow: true,
    services: stoppedServices,
    shutdownRequested: false,
  }),
  'relaunch',
);
assert.equal(
  decideRuntimeActivationAction({
    state: 'stopping',
    hasWindow: false,
    services: stoppedServices,
    shutdownRequested: true,
  }),
  'ignore',
);
assert.equal(
  decideRuntimeActivationAction({
    state: 'stopping',
    hasWindow: false,
    services: stoppedServices,
    shutdownRequested: false,
  }),
  'ignore',
);
assert.equal(
  decideRuntimeActivationAction({
    state: 'failed',
    hasWindow: false,
    services: stoppedServices,
    shutdownRequested: false,
  }),
  'relaunch',
);

const relaunchReasons: string[] = [];
const requestRelaunch = createRelaunchGate((reason) => relaunchReasons.push(reason));
assert.equal(requestRelaunch('runtime-lost'), true);
assert.equal(requestRelaunch('second-activation'), false);
assert.deepEqual(relaunchReasons, ['runtime-lost']);

// hasRelaunchAttemptFlag: bounds relaunches across process restarts, since
// createRelaunchGate's own gate resets on every new process (fresh closure).
const FLAG = '--flo-runtime-relaunch-attempt';
assert.equal(
  hasRelaunchAttemptFlag(['/usr/bin/flo', '.'], FLAG),
  false,
  'a first-launch argv has no attempt marker',
);
assert.equal(
  hasRelaunchAttemptFlag(['/usr/bin/flo', '.', FLAG], FLAG),
  true,
  'a relaunched process carries the marker its own relaunch appended',
);
assert.equal(
  hasRelaunchAttemptFlag([], FLAG),
  false,
  'an empty argv is treated as a first launch',
);

console.log('Runtime recovery tests passed');
