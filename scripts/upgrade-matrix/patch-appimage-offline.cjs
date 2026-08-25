'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appImage = process.argv[2];
const scratch = process.argv[3];
if (!appImage || !scratch) {
  throw new Error('usage: patch-appimage-offline.cjs <appimage> <scratch-directory>');
}

const root = path.join(scratch, 'squashfs-root');
const squashfs = `${scratch}.squashfs`;
const patched = `${appImage}.patched`;

try {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(squashfs, { force: true });
  fs.rmSync(patched, { force: true });
  fs.mkdirSync(scratch, { recursive: true });

  execFileSync(appImage, ['--appimage-extract'], { cwd: scratch, stdio: 'inherit' });
  if (!fs.statSync(root).isDirectory()) throw new Error(`AppImage extraction missing ${root}`);

  execFileSync(process.execPath, [
    path.join(__dirname, 'patch-offline-fixture.cjs'),
    root,
  ], { stdio: 'inherit' });

  const offset = Number(execFileSync(appImage, ['--appimage-offset'], { encoding: 'utf8' }).trim());
  if (!Number.isSafeInteger(offset) || offset <= 0) throw new Error(`invalid AppImage runtime offset: ${offset}`);
  const original = fs.readFileSync(appImage);
  if (offset >= original.length) throw new Error(`AppImage runtime offset exceeds file size: ${offset}`);

  execFileSync('mksquashfs', [root, squashfs, '-noappend', '-comp', 'xz', '-quiet'], { stdio: 'inherit' });
  fs.writeFileSync(patched, Buffer.concat([
    original.subarray(0, offset),
    fs.readFileSync(squashfs),
  ]));
  fs.chmodSync(patched, fs.statSync(appImage).mode);
  fs.renameSync(patched, appImage);

  console.log(JSON.stringify({ fixture: 'offline-appimage', artifact: path.basename(appImage) }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(squashfs, { force: true });
  fs.rmSync(patched, { force: true });
}
