#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const code = process.argv[2];
const usage = 'Usage: npm run i18n:add -- <two-or-three-letter-language-code>';

if (!code || process.argv.length > 3) {
  console.error(usage);
  process.exit(1);
}

// Registry keys are deliberately limited to lowercase ISO 639-style primary
// language identifiers. Region/script metadata belongs in the registry's
// `locale` field, not in the message filename/key.
if (!/^[a-z]{2,3}$/.test(code)) {
  console.error(`Invalid language code "${code}". Use a lowercase two- or three-letter language identifier.`);
  process.exit(1);
}

try {
  const parsed = new Intl.Locale(code);
  if (parsed.language !== code) throw new Error('not a canonical language identifier');
} catch {
  console.error(`Invalid language code "${code}". It must be a valid BCP-47 language identifier.`);
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const messagesDir = path.join(root, 'frontend', 'src', 'lib', 'i18n', 'messages');
const source = path.join(messagesDir, 'en.json');
const target = path.join(messagesDir, `${code}.json`);

if (!fs.existsSync(source)) {
  console.error(`English source messages are missing: ${path.relative(root, source)}`);
  process.exit(1);
}

try {
  // COPYFILE_EXCL makes the no-overwrite guarantee atomic, including when two
  // contributors accidentally run the helper at the same time.
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
} catch (error) {
  if (error && error.code === 'EEXIST') {
    console.error(`Refusing to overwrite existing messages file: ${path.relative(root, target)}`);
  } else {
    console.error(`Could not create ${path.relative(root, target)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

console.log(`Created ${path.relative(root, target)} from the English canonical schema.`);
console.log('Next steps:');
console.log(`  1. Add a "${code}" entry to frontend/src/lib/i18n/languages.ts (locale, nativeName, direction, selectable, and dynamic load()).`);
console.log(`  2. Translate every leaf in frontend/src/lib/i18n/messages/${code}.json while preserving ICU arguments and tags.`);
console.log('  3. Run npm run i18n:check before opening the PR.');
