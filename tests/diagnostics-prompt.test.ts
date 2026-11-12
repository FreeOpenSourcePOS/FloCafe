/**
 * Diagnostics prompt card: when the error-report ask may appear, and the
 * counters that stop it from nagging (EDPB continuous-prompting limits).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/diagnostics-prompt.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-diagnostics-prompt-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.11.0' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const {
  shouldShowDiagnosticsPrompt,
  DIAGNOSTICS_PROMPT_MAX,
  DIAGNOSTICS_PROMPT_MIN_INTERVAL_MS,
} = require('../shared/diagnostics-prompt');

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const base = {
  enabled: false,
  dismissed: false,
  promptCount: 0,
  lastAskedAt: null,
  problemsSince: 1,
  orderOrPaymentOpen: false,
  now: NOW,
};

async function main() {
  console.log('Diagnostics Prompt Tests');
  console.log('='.repeat(56));

  console.log('\n1. The show/hide rules');
  assertEqualOrThrow(
    shouldShowDiagnosticsPrompt({ ...base }),
    true,
    'it asks once a problem is on the device',
  );
  assertEqualOrThrow(
    shouldShowDiagnosticsPrompt({ ...base, enabled: true }),
    false,
    'it never asks when error reports are already on',
  );
  assertEqualOrThrow(
    shouldShowDiagnosticsPrompt({ ...base, dismissed: true }),
    false,
    '"Don\'t ask again" is final',
  );
  assertEqualOrThrow(
    shouldShowDiagnosticsPrompt({ ...base, problemsSince: 0 }),
    false,
    'it stays quiet when nothing new went wrong since the last ask',
  );
  assertEqualOrThrow(
    shouldShowDiagnosticsPrompt({ ...base, promptCount: DIAGNOSTICS_PROMPT_MAX }),
    false,
    'it stops after the cap',
  );
  assertEqualOrThrow(
    shouldShowDiagnosticsPrompt({ ...base, promptCount: DIAGNOSTICS_PROMPT_MAX - 1 }),
    true,
    'the last allowed ask still appears',
  );
  assertEqualOrThrow(
    shouldShowDiagnosticsPrompt({
      ...base,
      promptCount: 1,
      lastAskedAt: new Date(NOW - DIAGNOSTICS_PROMPT_MIN_INTERVAL_MS + 60_000).toISOString(),
    }),
    false,
    'two asks are never less than the minimum interval apart',
  );
  assertEqualOrThrow(
    shouldShowDiagnosticsPrompt({
      ...base,
      promptCount: 1,
      lastAskedAt: new Date(NOW - DIAGNOSTICS_PROMPT_MIN_INTERVAL_MS).toISOString(),
    }),
    true,
    'it may ask again once the interval has passed',
  );
  assertEqualOrThrow(
    shouldShowDiagnosticsPrompt({ ...base, orderOrPaymentOpen: true }),
    false,
    'it never covers a running order or a payment',
  );

  console.log('\n2. The counters the card reads and writes');
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  db.prepare('DELETE FROM local_diagnostics').run();
  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const read = () =>
    api(baseUrl, '/api/settings/diagnostics-prompt', { headers: owner.authHeader });
  const post = (event: unknown) =>
    api(baseUrl, '/api/settings/diagnostics-prompt', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event },
    });

  const empty = await read();
  assertEqualOrThrow(empty.status, 200, 'the card can read its state');
  assertEqualOrThrow(empty.data.dismissed, false, 'nobody dismissed it yet');
  assertEqualOrThrow(empty.data.prompt_count, 0, 'it was never shown');
  assertEqualOrThrow(empty.data.last_asked_at, null, 'no ask is recorded');
  assertEqualOrThrow(empty.data.problems_since, 0, 'the device logged no problem');

  db.prepare(
    `INSERT INTO local_diagnostics (event_code, severity, error_class, signature, summary, occurred_at)
     VALUES ('printer.failed', 'error', 'PrinterError', 'x', 'x', ?)`,
  ).run(new Date().toISOString());
  const withProblem = await read();
  assertEqualOrThrow(withProblem.data.problems_since, 1, 'the logged problem is counted');

  const shown = await post('shown');
  assertEqualOrThrow(shown.status, 200, 'the card reports that it was shown');
  assertEqualOrThrow(shown.data.prompt_count, 1, 'one ask is recorded');
  assertOrThrow(
    typeof shown.data.last_asked_at === 'string' && shown.data.last_asked_at.endsWith('Z'),
    'the ask time is stored as an ISO timestamp the browser can parse',
  );
  assertEqualOrThrow(
    shown.data.problems_since,
    0,
    'the problems before the ask stop counting as new',
  );

  const repeated = await post('shown');
  assertEqualOrThrow(repeated.data.prompt_count, 2, 'each shown card counts once');

  const accepted = await post('accepted');
  assertEqualOrThrow(accepted.status, 200, 'the card reports an accepted ask');
  assertEqualOrThrow(accepted.data.prompt_count, 2, 'accepting is an event, not another ask');
  assertEqualOrThrow(accepted.data.dismissed, false, 'accepting is not a dismissal');

  const dismissed = await post('dismissed');
  assertEqualOrThrow(dismissed.status, 200, '"Don\'t ask again" is accepted');
  assertEqualOrThrow(dismissed.data.dismissed, true, 'the dismissal is stored');

  const bad = await post('maybe');
  assertEqualOrThrow(bad.status, 400, 'an unknown event is rejected');

  console.log('\n3. The cap holds even when a client keeps asking');
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_prompt_count', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(DIAGNOSTICS_PROMPT_MAX), new Date().toISOString());
  const overCap = await post('shown');
  assertEqualOrThrow(overCap.status, 200, 'the call still answers');
  assertEqualOrThrow(
    overCap.data.prompt_count,
    DIAGNOSTICS_PROMPT_MAX,
    'the count never grows past the cap',
  );

  console.log('\n3. Only settings managers reach the card state');
  const jwt = require('jsonwebtoken');
  const { getJWTSecret } = require('../main/routes/auth');
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('server-prompt', 'Server', 'server@test.local', 'x', 'server', 1, datetime('now'), datetime('now'))`,
  ).run();
  const serverAuth = {
    Authorization: `Bearer ${jwt.sign(
      { userId: 'server-prompt', email: 'server@test.local', role: 'server' },
      getJWTSecret(),
      { expiresIn: '1h' },
    )}`,
  };
  const serverRead = await api(baseUrl, '/api/settings/diagnostics-prompt', {
    headers: serverAuth,
  });
  assertEqualOrThrow(serverRead.status, 403, 'a server cannot read the card state');
  for (const event of ['shown', 'accepted', 'dismissed']) {
    const serverPost = await api(baseUrl, '/api/settings/diagnostics-prompt', {
      method: 'POST',
      headers: serverAuth,
      body: { event },
    });
    assertEqualOrThrow(serverPost.status, 403, `a server cannot record "${event}"`);
  }
  const serverConsent = await api(baseUrl, '/api/settings/diagnostics_transmission_enabled', {
    method: 'PUT',
    headers: serverAuth,
    body: { value: 'true' },
  });
  assertEqualOrThrow(serverConsent.status, 403, 'a server cannot turn reports on');

  console.log('\n' + '='.repeat(56));
  console.log('All diagnostics prompt tests passed.');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
