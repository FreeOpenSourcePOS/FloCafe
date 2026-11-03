import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getStatusMessage,
  resolveStatusLanguage,
  RTL_STATUS_LANGUAGES,
  STATUS_LANGUAGES,
  type StatusKey,
} from '../main/status-messages';

const KEYS: StatusKey[] = [
  'starting',
  'checking',
  'backingUp',
  'services',
  'welcome',
  'closing',
  'shutdownBackup',
  'saved',
];

const languagesSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'lib', 'i18n', 'languages.ts'),
  'utf8',
);
const block = languagesSource.slice(
  languagesSource.indexOf('export const LANGUAGES = {'),
  languagesSource.indexOf('export type Language ='),
);
const appLanguages = [...block.matchAll(/^ {2}(?:'([a-z-]+)'|([a-z]+)): \{$/gm)].map(
  (match) => match[1] ?? match[2],
);

assert.ok(appLanguages.length >= 24, 'the app language registry was parsed');
for (const language of appLanguages) {
  assert.ok(STATUS_LANGUAGES.includes(language), `${language} has startup/shutdown messages`);
  for (const key of KEYS) {
    const [title, detail] = getStatusMessage(key, language);
    assert.ok(title.trim().length > 0 && detail.trim().length > 0, `${language}.${key} is filled`);
  }
}
for (const language of STATUS_LANGUAGES) {
  assert.ok(appLanguages.includes(language), `${language} is a registered app language`);
}
for (const rtl of RTL_STATUS_LANGUAGES) assert.ok(appLanguages.includes(rtl));

assert.equal(resolveStatusLanguage('es'), 'es');
assert.equal(resolveStatusLanguage('es-MX'), 'es');
assert.equal(resolveStatusLanguage('en-US'), 'en');
assert.equal(resolveStatusLanguage('zh-TW'), 'zh-tw');
assert.equal(resolveStatusLanguage('zh-Hant-HK'), 'zh-tw');
assert.equal(resolveStatusLanguage('zh-CN'), 'zh');
assert.equal(resolveStatusLanguage('tl-PH'), 'fil');
assert.equal(resolveStatusLanguage('xx'), 'en');
assert.equal(resolveStatusLanguage(null), 'en');
assert.equal(getStatusMessage('starting', 'unknown')[0], 'Starting Flo');

console.log('Status messages cover every app language.');
