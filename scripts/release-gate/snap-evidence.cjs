#!/usr/bin/env node

const fs = require('node:fs');
const { assertSnapEvidence } = require('./release-state.cjs');

function arg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`missing required argument ${name}`);
  return argv[index + 1];
}

function createSnapEvidence({ tag, channel, architecture }) {
  const evidence = {
    schemaVersion: 1,
    type: 'flocafe-snap-publication',
    tag,
    channel,
    architecture,
    status: 'published',
    snapName: 'flocafe',
    smartScreen: 'not-applicable',
  };
  assertSnapEvidence(evidence, { tag, channel });
  return evidence;
}

function main() {
  const argv = process.argv.slice(2);
  const evidence = createSnapEvidence({
    tag: arg(argv, '--tag'),
    channel: arg(argv, '--channel'),
    architecture: arg(argv, '--arch'),
  });
  const output = arg(argv, '--output');
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = { createSnapEvidence };
