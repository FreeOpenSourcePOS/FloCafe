'use strict';

const fs = require('node:fs');
const path = require('node:path');

const replacements = [
  ['https://telemetry.flopos.com/collect', 'http://127.0.0.1:9/collect', 'telemetry'],
  ['https://blue.flopos.com/', 'http://127.0.0.1:9/', 'cloud'],
  ['https://blue.flopos.com', 'http://127.0.0.1:9', 'cloud'],
];

function listFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  return files;
}

function listTargets(root) {
  const stat = fs.statSync(root);
  if (stat.isDirectory()) return listFiles(root);
  if (stat.isFile()) return [root];
  throw new Error(`fixture root is neither a file nor a directory: ${root}`);
}

function padded(value, length) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`replacement is longer than source for ${value}`);
  return Buffer.concat([bytes, Buffer.alloc(length - bytes.length, 0x20)]);
}

function replaceAll(data, source, replacement) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = data.indexOf(source, offset);
    if (index < 0) return count;
    replacement.copy(data, index);
    count += 1;
    offset = index + replacement.length;
  }
}

function main() {
  const root = process.argv[2];
  if (!root) throw new Error('usage: patch-offline-fixture.cjs <asar-file-or-extracted-directory>');

  const files = listTargets(root);
  const counts = Object.fromEntries(replacements.map(([, , name]) => [name, 0]));
  for (const file of files) {
    const original = fs.readFileSync(file);
    const patched = Buffer.from(original);
    for (const [sourceText, replacementText, name] of replacements) {
      const source = Buffer.from(sourceText);
      counts[name] += replaceAll(patched, source, padded(replacementText, source.length));
    }
    if (!patched.equals(original)) fs.writeFileSync(file, patched);
  }

  if (counts.telemetry === 0) throw new Error(`telemetry endpoint not found under ${root}`);
  for (const file of files) {
    const contents = fs.readFileSync(file);
    for (const [sourceText] of replacements) {
      if (contents.includes(sourceText)) throw new Error(`production endpoint remains in ${file}`);
    }
  }

  console.log(JSON.stringify({
    fixture: 'offline',
    telemetry_replacements: counts.telemetry,
    cloud_replacements: counts.cloud,
    endpoint: 'http://127.0.0.1:9',
  }));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
