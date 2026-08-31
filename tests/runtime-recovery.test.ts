import * as assert from 'node:assert/strict';
import {
  createRelaunchAttemptGuard,
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

// createRelaunchAttemptGuard: a successful recovery must not permanently
// disable a later, independent relaunch attempt (issue #568 #1) — the marker
// carried in process.argv should only count against the process until this
// process's own runtime first recovers.
{
  // A first launch (no marker) never counts as an exhausted attempt.
  const freshLaunch = createRelaunchAttemptGuard(false);
  assert.equal(freshLaunch.hasExhaustedAttempt(), false);
  freshLaunch.markRuntimeRecovered();
  assert.equal(freshLaunch.hasExhaustedAttempt(), false);
}
{
  // A relaunched process that fails again before ever recovering is exhausted.
  const failedRelaunch = createRelaunchAttemptGuard(true);
  assert.equal(failedRelaunch.hasExhaustedAttempt(), true, 'a relaunched process is exhausted until it recovers');
}
{
  // A relaunched process that recovers, then later hits an unrelated failure,
  // gets a fresh attempt instead of being treated as already exhausted.
  const recoveredRelaunch = createRelaunchAttemptGuard(true);
  assert.equal(recoveredRelaunch.hasExhaustedAttempt(), true);
  recoveredRelaunch.markRuntimeRecovered();
  assert.equal(
    recoveredRelaunch.hasExhaustedAttempt(),
    false,
    'a later, independent failure is not blocked by a marker from a relaunch that already succeeded',
  );
}

console.log('Runtime recovery tests passed');
