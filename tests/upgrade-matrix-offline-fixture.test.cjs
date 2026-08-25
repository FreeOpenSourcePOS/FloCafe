'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-upgrade-offline-'));
try {
  const bundle = path.join(root, 'dist');
  fs.mkdirSync(bundle);
  const file = path.join(bundle, 'index.js');
  fs.writeFileSync(file, [
    "const telemetry = 'https://telemetry.flopos.com/collect';",
    "const cloud = 'https://blue.flopos.com';",
  ].join('\n'));

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/upgrade-matrix/patch-offline-fixture.cjs'),
    root,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const fixtureResult = JSON.parse(result.stdout);
  assert.equal(fixtureResult.telemetry_replacements, 1);
  assert.equal(fixtureResult.cloud_replacements, 1);

  const patched = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(patched, /https:\/\/telemetry\.flopos\.com\/collect/);
  assert.doesNotMatch(patched, /https:\/\/blue\.flopos\.com/);
  assert.match(patched, /http:\/\/127\.0\.0\.1:9/);

  const packed = path.join(root, 'app.asar');
  fs.writeFileSync(packed, Buffer.from('https://telemetry.flopos.com/collect'));
  const packedResult = spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/upgrade-matrix/patch-offline-fixture.cjs'),
    packed,
  ], { encoding: 'utf8' });
  assert.equal(packedResult.status, 0, packedResult.stderr);
  assert.doesNotMatch(fs.readFileSync(packed, 'utf8'), /https:\/\/telemetry\.flopos\.com\/collect/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
