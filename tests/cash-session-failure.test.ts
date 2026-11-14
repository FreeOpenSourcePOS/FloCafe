/**
 * Shift-close refusals: the cash-session route answers 403
 * `session_owner_required` when a cashier tries to close a shift another user
 * opened. That code must reach the user as its own message, not the generic
 * failure text (issue #1551).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertEqualOrThrow, assertOrThrow } from './helpers/test-setup';
import { cashSessionCloseErrorKey } from '../frontend/src/lib/cash-session-failure';

const en = JSON.parse(
  readFileSync(join(__dirname, '../frontend/src/lib/i18n/messages/en.json'), 'utf8'),
) as { dashboard: Record<string, string> };

const ownerKey = cashSessionCloseErrorKey({
  error: 'Cashiers can only close their own shift',
  code: 'session_owner_required',
  display_code: 'session_owner_required',
});

assertEqualOrThrow(
  ownerKey,
  'shiftCloseOwnerRequired',
  'session_owner_required maps to its own message key',
);

assertOrThrow(
  /only the cashier who opened this shift, a manager, or an owner/i.test(
    en.dashboard.shiftCloseOwnerRequired ?? '',
  ),
  'the message explains who may close the shift',
);

assertEqualOrThrow(
  cashSessionCloseErrorKey({ code: 'session_owner_required' }),
  'shiftCloseOwnerRequired',
  'the bare code also maps, for payloads without display_code',
);

assertEqualOrThrow(
  cashSessionCloseErrorKey({ display_code: 'session_unavailable' }),
  null,
  'codes without their own message keep the generic failure text',
);

assertEqualOrThrow(
  cashSessionCloseErrorKey(null),
  null,
  'a missing payload keeps the generic text',
);

console.log('cash-session-failure: all assertions passed');
