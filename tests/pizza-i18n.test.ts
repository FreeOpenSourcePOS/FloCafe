/**
 * Pizza fork: the English-only pizza strings resolve under every language, and the strings
 * file gets the syntax and duplicate-key checks upstream's translation test does not give it.
 *
 * Usage: npx tsx --tsconfig tests/tsconfig.json -r ./tests/register-tsx.cjs tests/pizza-i18n.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@formatjs/icu-messageformat-parser';

const PIZZA_FILE = path.join(__dirname, '../frontend/src/lib/i18n/messages-pizza/en.json');
// `use-intl` lives in frontend/node_modules, which a test here cannot resolve by bare name.
const {
  createTranslator,
} = require('../frontend/node_modules/use-intl/dist/esm/production/core.js');
const { loadLocaleMessages } =
  require('../frontend/src/lib/i18n/loader') as typeof import('../frontend/src/lib/i18n/loader');

/** Keys repeated inside one object; JSON.parse keeps only the last, so read the raw text. */
function duplicateKeys(raw: string): string[] {
  const duplicates: string[] = [];
  const scopes: Array<Set<string>> = [];
  const token = /"(?:[^"\\]|\\.)*"|[{}]/g;
  for (let match = token.exec(raw); match; match = token.exec(raw)) {
    if (match[0] === '{') scopes.push(new Set());
    else if (match[0] === '}') scopes.pop();
    else if (/^\s*:/.test(raw.slice(token.lastIndex))) {
      const scope = scopes[scopes.length - 1];
      if (scope.has(match[0])) duplicates.push(match[0]);
      scope.add(match[0]);
    }
  }
  return duplicates;
}

function icuError(message: string): string | null {
  try {
    parse(message);
    return null;
  } catch (error: any) {
    return String(error?.message ?? error);
  }
}

function leaves(node: unknown, prefix = ''): Array<[string, unknown]> {
  if (node === null || typeof node !== 'object') return [[prefix, node]];
  return Object.entries(node).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key),
  );
}

async function run(): Promise<void> {
  console.log('Pizza fork: English-only pizza strings');

  const raw = fs.readFileSync(PIZZA_FILE, 'utf8');
  const pizza = JSON.parse(raw);
  const strings = leaves(pizza);
  assert.ok(strings.length > 0, 'the pizza strings file has at least one string');

  // 1. The checks can fail.
  assert.deepEqual(duplicateKeys('{"a": {"b": "x", "b": "y"}, "b": "z"}'), ['"b"']);
  assert.ok(icuError('Half: {name'), 'an unclosed placeholder is reported');
  console.log('  ✓ the duplicate-key and message-syntax checks detect a bad file');

  // 2. The strings file is well formed.
  assert.deepEqual(duplicateKeys(raw), [], 'no key is repeated inside one object');
  for (const [key, value] of strings) {
    assert.equal(typeof value, 'string', `pizza.${key} is a string`);
    assert.notEqual((value as string).trim(), '', `pizza.${key} is not empty`);
    assert.equal(icuError(value as string), null, `pizza.${key} is a valid ICU message`);
  }
  console.log(`  ✓ ${strings.length} pizza strings: valid ICU syntax, no duplicate keys`);

  // 3. No language file has its own `pizza` namespace: the loader's merge would replace it unseen.
  const messagesDir = path.join(path.dirname(PIZZA_FILE), '../messages');
  const languageFiles = fs.readdirSync(messagesDir).filter((file) => file.endsWith('.json'));
  assert.ok(languageFiles.length >= 32, 'the language files are found');
  for (const file of languageFiles) {
    const messages = JSON.parse(fs.readFileSync(path.join(messagesDir, file), 'utf8'));
    assert.ok(!('pizza' in messages), `${file} has no top-level pizza key`);
  }
  console.log(`  ✓ none of the ${languageFiles.length} language files has a pizza namespace`);

  // 4. A pizza key resolves under non-English languages, next to translated core strings.
  const english = (await loadLocaleMessages('en')) as any;
  assert.deepEqual(english.pizza, pizza, 'English carries the pizza namespace');
  for (const lang of ['de', 'ar'] as const) {
    const messages = (await loadLocaleMessages(lang)) as any;
    assert.deepEqual(messages.pizza, pizza, `${lang} carries the pizza namespace`);
    const t = createTranslator({ locale: lang, messages });
    assert.equal(
      t('pizza.setupProfileLabel'),
      'Pizza shop',
      `pizza.setupProfileLabel resolves under ${lang}`,
    );
    assert.notEqual(
      t('setup.emptyLabel'),
      createTranslator({ locale: 'en', messages: english })('setup.emptyLabel'),
      `core strings are still translated under ${lang}`,
    );
  }
  console.log('  ✓ pizza.setupProfileLabel resolves under de and ar');

  console.log('\nAll pizza i18n checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
