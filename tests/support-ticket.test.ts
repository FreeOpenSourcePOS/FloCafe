/**
 * Integration tests for the Help & Support ticket endpoint and its
 * outbox delivery mechanism (issue #220 item #7 — "existing ... several
 * UI/release flows lack direct tests"; main/routes/support-ticket.ts had
 * no dedicated test file at all before this).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/support-ticket.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-support-ticket-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '2.9.5' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { cloudSync } = require('../main/services/cloud-sync');

async function main() {
  console.log('Support Ticket Outbox Integration Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  const owner = seedOwnerUser(db);

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n1. Owner submits a ticket — it is queued, not sent, and lands in the outbox');
    const clientTicketId = '11111111-2222-3333-4444-555555555555';
    const createRes = await api(baseUrl, '/api/support-ticket', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        client_ticket_id: clientTicketId,
        subject: 'Printer not responding',
        message: 'The kitchen printer stopped printing tickets after the last update.',
        category: 'printer',
        severity: 'high',
      },
    });
    assertEqual(createRes.status, 202, 'a well-formed ticket is accepted and queued');
    assertEqual(createRes.data.status, 'queued', 'response reports queued status');
    assertEqual(createRes.data.client_ticket_id, clientTicketId, 'response echoes the client ticket id');

    const outboxRow = db.prepare(
      `SELECT client_ticket_id, status, payload FROM support_ticket_outbox WHERE client_ticket_id = ?`
    ).get(clientTicketId) as { client_ticket_id: string; status: string; payload: string };
    assert(!!outboxRow, 'a row was written to support_ticket_outbox');
    assertEqual(outboxRow.status, 'pending', 'the outbox row starts pending (not yet sent to the cloud)');
    const payload = JSON.parse(outboxRow.payload);
    assertEqual(payload.subject, 'Printer not responding', 'the outbox payload carries the submitted subject');
    assertEqual(payload.event_code, 'support.printer', 'event_code defaults from category when not supplied');
    assertEqual(payload.diagnostics.category, 'printer', 'diagnostics embed the resolved category');
    assert(typeof payload.diagnostics.app_version === 'string' && payload.diagnostics.app_version.length > 0,
      'diagnostics embed the app version');

    console.log('\n2. GET status reflects the outbox row');
    const statusRes = await api(baseUrl, `/api/support-ticket/${clientTicketId}/status`, { headers: owner.authHeader });
    assertEqual(statusRes.status, 200, 'status lookup succeeds for a known ticket');
    assertEqual(statusRes.data.status, 'pending', 'status lookup reports the outbox row\'s real status');

    console.log('\n3. Resubmitting the same client_ticket_id is idempotent (no duplicate outbox row)');
    const resubmitRes = await api(baseUrl, '/api/support-ticket', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        client_ticket_id: clientTicketId,
        subject: 'Printer not responding (resent by client retry)',
        message: 'Retried after a network blip.',
      },
    });
    assertEqual(resubmitRes.status, 202, 'a resubmission with the same client_ticket_id is still accepted');
    const outboxCount = db.prepare(
      `SELECT COUNT(*) AS c FROM support_ticket_outbox WHERE client_ticket_id = ?`
    ).get(clientTicketId) as { c: number };
    assertEqual(outboxCount.c, 1, 'INSERT OR IGNORE means a client retry never creates a second outbox row');
    const unchangedRow = db.prepare(
      `SELECT payload FROM support_ticket_outbox WHERE client_ticket_id = ?`
    ).get(clientTicketId) as { payload: string };
    assertEqual(
      JSON.parse(unchangedRow.payload).subject, 'Printer not responding',
      'the original payload is preserved — a retry does not overwrite the first submission',
    );

    console.log('\n4. Validation rejects malformed submissions before anything is queued');
    const missingSubject = await api(baseUrl, '/api/support-ticket', {
      method: 'POST', headers: owner.authHeader, body: { message: 'no subject here' },
    });
    assertEqual(missingSubject.status, 400, 'a ticket without a subject is rejected');

    const missingMessage = await api(baseUrl, '/api/support-ticket', {
      method: 'POST', headers: owner.authHeader, body: { subject: 'no message here' },
    });
    assertEqual(missingMessage.status, 400, 'a ticket without a message is rejected');

    const badEmail = await api(baseUrl, '/api/support-ticket', {
      method: 'POST',
      headers: owner.authHeader,
      body: { subject: 'x', message: 'y', contact_email: 'not-an-email' },
    });
    assertEqual(badEmail.status, 400, 'an invalid contact_email is rejected');

    console.log('\n5. An unrecognized category silently falls back to "general" rather than failing');
    const unknownCategoryRes = await api(baseUrl, '/api/support-ticket', {
      method: 'POST',
      headers: owner.authHeader,
      body: { client_ticket_id: '22222222-3333-4444-5555-666666666666', subject: 'x', message: 'y', category: 'not-a-real-category' },
    });
    assertEqual(unknownCategoryRes.status, 202, 'an unrecognized category does not block submission');
    const fallbackRow = db.prepare(
      `SELECT payload FROM support_ticket_outbox WHERE client_ticket_id = '22222222-3333-4444-5555-666666666666'`
    ).get() as { payload: string };
    assertEqual(JSON.parse(fallbackRow.payload).diagnostics.category, 'general', 'category falls back to "general"');

    console.log('\n6. Status lookup rejects a malformed id and 404s a genuinely unknown one');
    const badIdRes = await api(baseUrl, '/api/support-ticket/not-a-uuid/status', { headers: owner.authHeader });
    assertEqual(badIdRes.status, 400, 'a malformed client_ticket_id is rejected before querying the database');

    const unknownIdRes = await api(baseUrl, '/api/support-ticket/99999999-8888-7777-6666-555555555555/status', { headers: owner.authHeader });
    assertEqual(unknownIdRes.status, 404, 'a well-formed but unknown client_ticket_id 404s');

    console.log('\n7. Submissions are blocked (not queued) while a cloud account deletion is in progress');
    (cloudSync as any).cloudDeletionInProgress = true;
    try {
      const duringDeletionRes = await api(baseUrl, '/api/support-ticket', {
        method: 'POST',
        headers: owner.authHeader,
        body: { client_ticket_id: '33333333-4444-5555-6666-777777777777', subject: 'x', message: 'y' },
      });
      assertEqual(duringDeletionRes.status, 503, 'submission is refused while cloud deletion is in progress');
      assertEqual(duringDeletionRes.data.status, 'unavailable', 'response reports the unavailable status');
      const blockedRow = db.prepare(
        `SELECT COUNT(*) AS c FROM support_ticket_outbox WHERE client_ticket_id = '33333333-4444-5555-6666-777777777777'`
      ).get() as { c: number };
      assertEqual(blockedRow.c, 0, 'nothing is written to the outbox while deletion is in progress');
    } finally {
      (cloudSync as any).cloudDeletionInProgress = false;
    }
  } finally {
    server.close();
    closeDatabase();
  }

  console.log('\n' + '='.repeat(56));
  const results = getResults();
  console.log(`${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Test suite crashed:', error);
  process.exit(1);
});
