/**
 * Release integrity checks — catches the class of bug where macOS
 * auto-update silently 404'd on latest-mac.yml for every release from
 * v1.6.7 through v1.9.11: electron-builder needs a `zip` mac target to
 * produce that manifest, and the release workflow has to actually upload
 * it (and the Windows/NSIS equivalent, latest.yml) alongside the installer.
 * None of this requires an actual platform build — it's a config/workflow
 * shape check, fast enough to run on every `npm test`.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function run() {
  console.log('Testing release config + workflow integrity...');

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const build = pkg.build;

  // ── electron-builder config ──────────────────────────────────────────
  assert.ok(build?.publish?.provider === 'github', 'build.publish must target GitHub releases');

  const macTargets = (build?.mac?.target || []).map((t: any) => t.target);
  assert.ok(
    macTargets.includes('zip'),
    'mac build target must include "zip" — DMG alone cannot be used for electron-updater\'s ' +
    'silent background updates, and without a zip target electron-builder never produces latest-mac.yml'
  );

  const winTargets = (build?.win?.target || []).map((t: any) => t.target);
  assert.ok(
    winTargets.includes('nsis'),
    'win build target must include "nsis" — electron-updater\'s Windows auto-update relies on ' +
    'the NSIS installer + latest.yml'
  );

  // ── Linux snap: Path B (snapcraft, core24) shape ────────────────
  assert.ok(
    build?.snapcraft?.base === 'core24',
    'build.snapcraft.base must be "core24" — modern Electron (≥28) is supported, GNOME extension ' +
    'requires core22+. Old "snap" block is legacy and can\'t declare the GNOME extension cleanly.'
  );
  const snapsPlugs = (build?.snapcraft?.core24?.plugs || []) as string[];
  assert.ok(
    snapsPlugs.includes('default'),
    'plugs must include "default" so electron-builder\'s Electron base plug set (x11, wayland, ' +
    'home, network, audio-playback, opengl, ...) is preserved instead of replaced'
  );
  assert.ok(
    snapsPlugs.includes('network-bind'),
    'plugs must include "network-bind" — the local Express server binds 0.0.0.0:3001 and the ' +
    'KDS server binds 0.0.0.0:3002; without this both fail under strict confinement'
  );
  const linuxEnv = build?.snapcraft?.core24?.environment || {};
  assert.ok(
    linuxEnv.TMPDIR === '$XDG_RUNTIME_DIR',
    'snapcraft.core24.environment.TMPDIR must be "$XDG_RUNTIME_DIR" — Chromium/Electron needs a ' +
    'writable runtime tmpdir or libappindicator resources become unreadable under confinement'
  );
  const linuxSynopsis = build?.linux?.synopsis;
  assert.ok(
    typeof linuxSynopsis === 'string' && linuxSynopsis.length > 0 && linuxSynopsis.length <= 78,
    `linux.synopsis must be set and ≤78 chars (got ${JSON.stringify(linuxSynopsis)})`
  );

  // ── Linux AppImage: AppImageHub catalog compatibility ────────────
  // The AppImageHub catalog auto-discovers AppImages whose filename
  // matches <AppName>-<Version>-<arch>.AppImage. The productName
  // ("Flo Cafe") default would produce "Flo Cafe-2.0.4-x86_64.AppImage"
  // (space + capital letter) which the catalog regex won't match.
  const linuxArtifact = build?.linux?.artifactName;
  assert.ok(
    typeof linuxArtifact === 'string' && linuxArtifact.includes('${arch}') && !/\s/.test(linuxArtifact.replace(/\$\{[^}]+\}/g, '')),
    `linux.artifactName must be a single lowercased template using \${arch} (got ${JSON.stringify(linuxArtifact)})`
  );

  const linuxTargets = (build?.linux?.target || []) as Array<{ target: string; arch?: string[] }>;
  // arm64 must be declared on EVERY Linux target — AppImage, deb, rpm, snap.
  // otherwise the arm64 matrix runner would skip that target and the release
  // would only ship half-arch.
  const expectedArchPerTarget: Array<[string, string]> = [
    ['AppImage', 'AppImagehub auto-discovery + ARM Linux desktops'],
    ['deb', 'Debian / Ubuntu / Raspberry Pi OS / SteamOS'],
    ['rpm', 'Fedora / RHEL / Nobara / openSUSE on arm64'],
    ['snap', 'Snap Store on Raspberry Pi + ARM servers'],
  ];
  for (const [targetName, why] of expectedArchPerTarget) {
    const target = linuxTargets.find((t) => t.target === targetName);
    assert.ok(
      target,
      `linux.target must include "${targetName}" (${why})`
    );
    assert.ok(
      target.arch && target.arch.includes('arm64'),
      `${targetName} target.arch must include "arm64" (${why})`
    );
  }

  // AppStream metainfo file must be wired into the AppImage at the
  // freedesktop-spec path usr/share/metainfo/. AppImageHub's catalog
  // CI runs appstreamcli validate against this file.
  const extraFiles: any[] = build?.linux?.extraFiles || [];
  const metainfoEntry = extraFiles.find(
    (f) => typeof f?.to === 'string' && f.to.startsWith('usr/share/metainfo/')
  );
  assert.ok(
    metainfoEntry,
    'linux.extraFiles must include an entry that copies the AppStream metainfo to usr/share/metainfo/'
  );
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', metainfoEntry!.from)),
    `metainfo source file must exist on disk: ${metainfoEntry!.from}`
  );
  // The release job must invoke scripts/update-metainfo.js before the
  // build so each AppImage ships with a fresh <release> entry. A stale
  // 1.7.1 entry has shipped in every release since 2.x.
  assert.ok(
    fs.existsSync(path.join(__dirname, '../scripts/update-metainfo.js')),
    'scripts/update-metainfo.js must exist — it is invoked by the release job to keep ' +
    'assets/com.flo.desktop.metainfo.xml current.'
  );

  // ── release workflow uploads the auto-update manifests, not just installers ──
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');

  const linuxJob = workflow.split(/^\s*release-linux:/m)[1]?.split(/^\s*release-mac:/m)[0] || '';
  assert.ok(
    /update-metainfo\.js/.test(linuxJob),
    'release-linux job must run scripts/update-metainfo.js before the electron-builder build.'
  );
  assert.ok(
    /ubuntu-24\.04-arm64/.test(linuxJob),
    'release-linux job must include an ubuntu-24.04-arm64 matrix entry so arm64 AppImages ' +
    'are actually built — declaring arm64 in build.linux.target is not enough without a runner.'
  );
  assert.ok(
    /matrix\.arch\s*==\s*['"]x64['"]/.test(linuxJob),
    "snap-to-snap-store publish must be gated on matrix.arch == 'x64' — the snap target's " +
    'arch list is x64-only and the arm64 entry would otherwise fail to find the .snap.'
  );

  const macJob = workflow.split(/^\s*release-mac:/m)[1]?.split(/^\s*release-windows:/m)[0] || '';
  assert.ok(macJob.includes('latest-mac.yml'), 'release-mac job must upload latest-mac.yml');
  assert.ok(/release\/\*\.zip\b/.test(macJob), 'release-mac job must upload the .zip artifact');
  assert.ok(macJob.includes('.zip.blockmap'), 'release-mac job must upload the .zip.blockmap');

  const winJob = workflow.split(/^\s*release-windows:/m)[1] || '';
  assert.ok(winJob.includes('latest.yml'), 'release-windows job must upload latest.yml');
  assert.ok(winJob.includes('.exe.blockmap'), 'release-windows job must upload the .exe.blockmap');

  console.log('✅ Release config + workflow integrity checks passed');
}

run();
