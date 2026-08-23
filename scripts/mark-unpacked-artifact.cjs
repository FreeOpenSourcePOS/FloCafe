'use strict';

const fs = require('node:fs');
const path = require('node:path');

const releaseDir = path.resolve(__dirname, '../release');
const markerName = 'flo-unpacked-dev.marker';

function findResourceDirectories(currentDir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(currentDir, entry.name);
    if (entry.name.toLowerCase() === 'resources' && fs.existsSync(path.join(candidate, 'app.asar'))) {
      found.push(candidate);
      continue;
    }
    findResourceDirectories(candidate, found);
  }
  return found;
}

function isCurrentPlatformOutput(resourceDir) {
  const outputRoot = path.relative(releaseDir, resourceDir).split(path.sep)[0];
  if (process.platform === 'win32') return /^win(?:-[a-z0-9]+)?-unpacked$/i.test(outputRoot);
  if (process.platform === 'linux') return /^linux(?:-[a-z0-9]+)?-unpacked$/i.test(outputRoot);
  if (process.platform === 'darwin') return /^mac(?:-[a-z0-9]+)?$/i.test(outputRoot);
  return false;
}

const candidates = findResourceDirectories(releaseDir).filter(isCurrentPlatformOutput);
if (candidates.length !== 1) {
  throw new Error(`Expected one unpacked ${process.platform} resources directory, found ${candidates.length}`);
}

const markerPath = path.join(candidates[0], markerName);
fs.writeFileSync(markerPath, 'FloCafe unpacked development artifact\n', 'utf8');
console.log(`Marked unpacked artifact: ${markerPath}`);
