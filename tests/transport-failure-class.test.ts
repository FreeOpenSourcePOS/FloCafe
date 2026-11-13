import assert from 'node:assert/strict';

const {
  classifyTransportFailure,
  NETWORK_FAILURE_CLASSES,
} = require('../frontend/src/lib/transport-failure');
const { serializeOperationFailure } = require('../main/lib/operation-failure');

const globalWithNavigator = globalThis as { navigator?: { onLine: boolean } };
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function setOnline(onLine: boolean | undefined) {
  Object.defineProperty(globalThis, 'navigator', {
    value: onLine === undefined ? undefined : { onLine },
    configurable: true,
    writable: true,
  });
}

try {
  setOnline(true);
  const cases: Array<[unknown, string]> = [
    [{ code: 'ECONNABORTED' }, 'timeout'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'ENOTFOUND' }, 'dns'],
    [{ code: 'ECONNREFUSED' }, 'connection_refused'],
    [{ code: 'ECONNRESET' }, 'connection_reset'],
    [{ code: 'ERR_CANCELED', name: 'CanceledError' }, 'aborted'],
    [{ name: 'AbortError' }, 'aborted'],
    [{ code: 'ERR_NETWORK', name: 'AxiosError' }, 'unreachable'],
    [{ code: 'ENETUNREACH' }, 'unreachable'],
    [new Error('boom'), 'unknown'],
    [null, 'unknown'],
    [{ code: 'SOMETHING_ELSE' }, 'unknown'],
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyTransportFailure(error), expected, JSON.stringify(error));
  }

  setOnline(false);
  assert.equal(classifyTransportFailure({ code: 'ERR_NETWORK' }), 'offline');
  assert.equal(classifyTransportFailure({ code: 'ERR_CANCELED' }), 'aborted');

  for (const failureClass of NETWORK_FAILURE_CLASSES) {
    for (const capturePoint of [
      'fc.frontend.pos.order.create.transport',
      'fc.frontend.pos.order.append.transport',
      'fc.frontend.pos.payment.create.transport',
    ]) {
      const failure = serializeOperationFailure({
        capture_point: capturePoint,
        outcome: 'unknown',
        facts: { failure_class: failureClass },
      });
      assert.ok(failure, `${capturePoint} accepts ${failureClass}`);
    }
  }
  console.log('ALL PASSED');
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalWithNavigator.navigator;
}
