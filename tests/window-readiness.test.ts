/**
 * Readiness-lifecycle tests for main/window-readiness.ts (issue #461).
 *
 * Covers the three review-mandated scenarios as one coherent epoch lifecycle:
 *   1. Reject path: malformed/failed readiness reports never mark the document
 *      ready; the bounded fail-safe shows the window and fires exactly once.
 *   2. Reload path: a new document (did-start-navigation with
 *      isSameDocument=false) invalidates the previous document's reports, so a
 *      reload can never inherit a stale ready flag.
 *   3. Fail-safe path: an unconfirmed current epoch surfaces the window after
 *      the bounded timeout; a confirmed epoch cancels it.
 *
 * Run: npm run test:window-readiness
 */

import * as assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  beginRendererDocument,
  getRendererDocumentNonce,
  getRendererReadinessEpoch,
  initWindowReadiness,
  isCurrentRendererFrame,
  isFullDocumentMainFrameNavigation,
  isRendererReadinessFailSafeShown,
  isWindowRendererReady,
  markWindowRendererReady,
  registerRendererDocument,
} from '../main/window-readiness';

async function run(): Promise<void> {
  // ── 1. Malformed reports (reject path) ──────────────────────────────────────
  const shows: number[] = [];
  initWindowReadiness(() => shows.push(getRendererReadinessEpoch()), { failsafeMs: 20 });

  const firstEpoch = beginRendererDocument();
  assert.equal(firstEpoch, 1);
  assert.equal(isWindowRendererReady(), false);
  assert.equal(
    isFullDocumentMainFrameNavigation({ isMainFrame: true, isSameDocument: false }),
    true,
    'full main-frame navigation starts a new document epoch',
  );
  assert.equal(
    isFullDocumentMainFrameNavigation({ isMainFrame: true, isSameDocument: true }),
    false,
    'Next.js same-document navigation keeps the current epoch',
  );
  assert.equal(
    isFullDocumentMainFrameNavigation({ isMainFrame: false, isSameDocument: false }),
    false,
    'sub-frame navigation cannot reset the main document epoch',
  );
  const firstNonce = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(registerRendererDocument('not-a-document-nonce'), false);
  assert.equal(registerRendererDocument(firstNonce), true);
  assert.equal(getRendererDocumentNonce(), firstNonce);

  for (const bad of [undefined, null, '1', 0, -1, 1.5, Number.NaN, {}]) {
    assert.equal(
      markWindowRendererReady(bad, firstNonce),
      false,
      `malformed epoch ${String(bad)} must be rejected`,
    );
  }
  assert.equal(isWindowRendererReady(), false, 'malformed reports never mark the document ready');

  // Fail-safe covers the reject path: nothing valid reported -> window shown.
  await sleep(60);
  assert.deepEqual(shows, [firstEpoch], 'fail-safe must fire exactly once for the unconfirmed epoch');
  assert.equal(isRendererReadinessFailSafeShown(), true, 'fail-safe visibility remains recoverable');
  assert.equal(
    isCurrentRendererFrame({ frameToken: 'current' }, { frameToken: 'current' }),
    true,
    'current document frame identity is accepted',
  );
  assert.equal(
    isCurrentRendererFrame({ frameToken: 'old' }, { frameToken: 'current' }),
    false,
    'stale document frame identity is rejected',
  );
  assert.equal(
    isCurrentRendererFrame({ frameToken: 'current', detached: true }, { frameToken: 'current' }),
    false,
    'detached document frame identity is rejected',
  );
  assert.equal(isCurrentRendererFrame(null, { frameToken: 'current' }), false);

  // A late valid report still works after the fail-safe fired.
  assert.equal(markWindowRendererReady(firstEpoch, firstNonce), true);
  assert.equal(isWindowRendererReady(), true);

  // ── 2. Reload path (stale-epoch invalidation) ───────────────────────────────
  const secondEpoch = beginRendererDocument();
  assert.equal(secondEpoch, firstEpoch + 1, 'every document load begins a new epoch');
  assert.equal(isWindowRendererReady(), false, 'new document starts unready');
  assert.equal(isRendererReadinessFailSafeShown(), false, 'new document clears fail-safe show state');
  assert.equal(getRendererDocumentNonce(), null, 'new document starts without a registered nonce');

  // The previous document's report is now stale and must be ignored.
  assert.equal(markWindowRendererReady(firstEpoch, firstNonce), false, 'stale-epoch report must be ignored');
  assert.equal(isWindowRendererReady(), false);

  // The stale epoch's fail-safe must not fire for the superseded epoch, but
  // the new unconfirmed epoch's own fail-safe still covers it.
  await sleep(60);
  assert.equal(shows.filter((e) => e === firstEpoch).length, 1, 'superseded epoch timer stays inert');
  assert.ok(shows.includes(secondEpoch), 'new epoch fail-safe covers its unconfirmed document');

  const secondNonce = '123e4567-e89b-42d3-a456-426614174001';
  assert.equal(registerRendererDocument(secondNonce), true);
  assert.equal(markWindowRendererReady(secondEpoch, firstNonce), false, 'stale nonce must be ignored');
  assert.equal(markWindowRendererReady(secondEpoch, secondNonce), true);
  assert.equal(isWindowRendererReady(), true, 'current-epoch confirmation marks ready');

  // ── 3. Fail-safe cancellation on confirmed readiness ────────────────────────
  const thirdEpoch = beginRendererDocument();
  const thirdNonce = '123e4567-e89b-42d3-a456-426614174002';
  assert.equal(registerRendererDocument(thirdNonce), true);
  assert.equal(markWindowRendererReady(thirdEpoch, thirdNonce), true);
  await sleep(60);
  assert.ok(
    !shows.includes(thirdEpoch),
    'confirmed epochs cancel their fail-safe; no fail-safe show',
  );

  console.log('Window readiness lifecycle (epoch binding, stale rejection, fail-safe) verified.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
