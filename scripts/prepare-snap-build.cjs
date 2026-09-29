const fs = require('fs');
const path = require('path');

const core24Path = require.resolve('app-builder-lib/out/targets/snap/core24.js');
const source = fs.readFileSync(core24Path, 'utf8');
const expected = 'const desktopFilePath = path.join(guiOutput, `${this.helper.getDesktopFileName(snap.name)}.desktop`);';
const replacement = 'const desktopFilePath = path.join(stageDir, this.configRelativePath, "meta", "gui", `${this.helper.getDesktopFileName(snap.name)}.desktop`);';

if (source.includes(replacement)) {
  console.log('Snap desktop staging workaround already applied.');
  process.exit(0);
}

if (!source.includes(expected)) {
  throw new Error(`Unsupported app-builder-lib core24.js: expected desktop staging line not found at ${core24Path}`);
}

fs.writeFileSync(core24Path, source.replace(expected, replacement));
console.log(`Applied Snapcraft core24 desktop staging workaround to ${path.relative(process.cwd(), core24Path)}.`);
