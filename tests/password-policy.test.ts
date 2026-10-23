/**
 * The system-wide password policy: at least 4 characters, no composition rules, one shared module
 * used by every backend route and frontend form.
 *
 * Run: npm run test:password-policy
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
  validatePassword,
} = require('../shared/password-policy');
const { validatePassword: securityValidatePassword } = require('../main/middleware/security');

assertEqualOrThrow(PASSWORD_MIN_LENGTH, 4, 'minimum length is 4');
assertOrThrow(
  PASSWORD_POLICY_MESSAGE.includes('at least 4 characters'),
  'message states the minimum',
);

for (const accepted of [
  'abcd',
  '1234',
  'abcd1',
  'password',
  'ALLUPPER',
  'ab!d',
  'a b c',
  'пароль',
]) {
  assertOrThrow(validatePassword(accepted), `accepts ${JSON.stringify(accepted)}`);
}
for (const rejected of ['', 'abc', '123', '   ', null, undefined, 1234, {}]) {
  assertOrThrow(!validatePassword(rejected), `rejects ${JSON.stringify(rejected)}`);
}
assertEqualOrThrow(
  securityValidatePassword,
  validatePassword,
  'backend middleware re-exports the shared rule',
);

const root = path.join(__dirname, '..');
const sources: string[] = [];
for (const dir of ['main', 'frontend/src']) {
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) sources.push(full);
    }
  };
  walk(path.join(root, dir));
}

const duplicatedRules = sources.filter((file) => {
  const text = fs.readFileSync(file, 'utf8');
  return (
    /\[A-Z\]\/\.test\(\s*(?:new_?[pP]assword|password)\s*\)/.test(text) ||
    /(?:new_?[pP]assword|password)\.length\s*<\s*\d/.test(text)
  );
});
assertOrThrow(
  duplicatedRules.length === 0,
  `no source file re-implements a password rule outside shared/password-policy.ts: ${duplicatedRules.map((file) => path.relative(root, file)).join(', ')}`,
);

console.log('password-policy: all assertions passed');
