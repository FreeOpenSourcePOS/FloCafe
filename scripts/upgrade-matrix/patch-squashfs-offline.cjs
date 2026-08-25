'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const archive = process.argv[2];
const scratch = process.argv[3];
if (!archive || !scratch) {
  throw new Error('usage: patch-squashfs-offline.cjs <squashfs-archive> <scratch-directory>');
}

const extracted = path.join(scratch, 'root');
const patched = `${archive}.patched`;

try {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(patched, { force: true });
  fs.mkdirSync(scratch, { recursive: true });
  execFileSync('unsquashfs', ['-d', extracted, archive], { stdio: 'inherit' });
  execFileSync(process.execPath, [
    path.join(__dirname, 'patch-offline-fixture.cjs'),
    extracted,
  ], { stdio: 'inherit' });
  execFileSync('mksquashfs', [extracted, patched, '-noappend', '-comp', 'xz', '-all-root', '-quiet'], { stdio: 'inherit' });
  fs.chmodSync(patched, fs.statSync(archive).mode);
  fs.renameSync(patched, archive);
  console.log(JSON.stringify({ fixture: 'offline-squashfs', artifact: path.basename(archive) }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(patched, { force: true });
}
