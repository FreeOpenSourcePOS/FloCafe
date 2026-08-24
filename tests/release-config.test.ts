import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const YAML = require('js-yaml') as { load: (text: string) => unknown };
const builderUtil = require('builder-util') as {
  Arch: { x64: number; arm64: number };
  getArtifactArchName: (arch: number, ext: string) => string;
};

function loadWorkflow(fileName: string): any {
  const workflow = YAML.load(fs.readFileSync(path.join(__dirname, '../.github/workflows', fileName), 'utf8')) as any;
  assert.ok(workflow && typeof workflow === 'object' && workflow.jobs, `${fileName} must parse as a workflow with jobs`);
  return workflow;
}

function findStep(job: any, name: string): any {
  const step = (job.steps || []).find((candidate: any) => candidate.name === name);
  assert.ok(step, `workflow job must contain step "${name}"`);
  return step;
}

function assertShellStep(job: any, name: string): void {
  const step = findStep(job, name);
  assert.equal(typeof step.run, 'string', `workflow step "${name}" must execute a shell script`);
}

function run() {
  console.log('Testing release config + workflow integrity...');

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const build = pkg.build;
  const releaseVerifier = require('../scripts/verify-release-assets.cjs');

  assert.equal(pkg.engines?.node, '>=22.12.0', 'root Node engine must match Electron 43 minimum');
  assert.equal(pkg.scripts?.['verify:electron'], 'node scripts/verify-electron-runtime.cjs', 'Electron runtime verification must be cross-platform');
  assert.equal(pkg.scripts?.['verify:release-artifacts'], 'node scripts/assert-release-artifact-names.cjs', 'release artifact filename assertion must be available to CI');
  assert.ok(fs.existsSync(path.join(__dirname, '../scripts/verify-electron-runtime.cjs')), 'cross-platform Electron runtime verifier must exist');
  assert.ok(fs.existsSync(path.join(__dirname, '../scripts/assert-release-artifact-names.cjs')), 'release artifact filename verifier must exist');
  assert.equal(typeof releaseVerifier.assertReleaseAssetInventory, 'function', 'draft release verifier must expose inventory validation');
  assert.deepEqual(
    releaseVerifier.expectedManifestNames('latest'),
    ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'],
    'draft release verification must require both Linux architecture manifests'
  );
  assert.equal(build?.publish?.channel, 'latest', 'stable builds must default to the latest update channel');
  assert.equal(build?.detectUpdateChannel, false, 'GitHub release channels must be selected explicitly by the release pipeline');
  assert.equal(build?.generateUpdatesFilesForAllChannels, true, 'electron-builder must support channel update manifests');
  assert.equal(build?.publish?.provider, 'github', 'build.publish must target GitHub releases');

  const macTargets = (build?.mac?.target || []).map((target: any) => target.target);
  assert.ok(macTargets.includes('zip'), 'mac build target must include zip for electron-updater');

  const winTargets = (build?.win?.target || []).map((target: any) => target.target);
  assert.ok(winTargets.includes('nsis'), 'win build target must include nsis for electron-updater');
  assert.equal(
    pkg.scripts?.['build:appx'],
    'npm run build:frontend && npm run build && electron-builder --win appx --x64 --arm64 --config.npmRebuild=false',
    'build:appx must preserve local x64 and arm64 Store builds'
  );
  assert.ok(build?.appx?.identityName, 'build.appx.identityName must be set');
  assert.ok(build?.appx?.publisher, 'build.appx.publisher must be set');
  assert.ok(winTargets.includes('appx'), 'win build target must include appx');
  const appxConfig = (build?.win?.target || []).find((target: any) => target.target === 'appx');
  assert.ok(appxConfig?.arch?.includes('arm64'), 'win appx target must include arm64');

  assert.equal(build?.snapcraft?.base, 'core24', 'snapcraft must use core24');
  const snapPlugs = build?.snapcraft?.core24?.plugs || [];
  assert.ok(snapPlugs.includes('default'), 'snapcraft must preserve the default Electron plugs');
  assert.ok(snapPlugs.includes('network-bind'), 'snapcraft must permit the local servers to bind');
  assert.equal(build?.snapcraft?.core24?.environment?.TMPDIR, '$XDG_RUNTIME_DIR', 'snapcraft must use a writable runtime temp directory');
  assert.ok(typeof build?.linux?.synopsis === 'string' && build.linux.synopsis.length > 0 && build.linux.synopsis.length <= 78, 'linux synopsis must be present and short');

  assert.equal(build?.linux?.artifactName, 'flocafe-${version}-linux.${ext}', 'Linux package artifact template must remain deterministic');
  assert.equal(build?.appImage?.artifactName, 'flocafe-${version}-linux.appimage', 'AppImage artifact extension must be lowercase');
  assert.equal(builderUtil.getArtifactArchName(builderUtil.Arch.x64, 'AppImage'), 'x86_64', 'electron-builder AppImage x64 macro spelling must be documented');
  assert.equal(builderUtil.getArtifactArchName(builderUtil.Arch.arm64, 'AppImage'), 'arm64', 'electron-builder AppImage arm64 macro spelling must be documented');
  for (const artifact of [build?.linux?.artifactName, build?.appImage?.artifactName]) {
    assert.ok(typeof artifact === 'string' && artifact.includes('${version}') && !artifact.includes('${arch}') && !/\s/.test(artifact.replace(/\$\{[^}]+\}/g, '')), `Linux artifact template must be safe: ${JSON.stringify(artifact)}`);
  }

  const linuxTargets = build?.linux?.target || [];
  for (const targetName of ['AppImage', 'deb', 'rpm', 'snap']) {
    const target = linuxTargets.find((entry: any) => entry.target === targetName);
    assert.ok(target?.arch?.includes('arm64'), `${targetName} must include arm64`);
  }

  const extraFiles: any[] = build?.linux?.extraFiles || [];
  const metainfoEntry = extraFiles.find((entry: any) => typeof entry?.to === 'string' && entry.to.startsWith('usr/share/metainfo/'));
  assert.ok(metainfoEntry, 'linux.extraFiles must include AppStream metainfo');
  assert.ok(fs.existsSync(path.join(__dirname, '..', metainfoEntry.from)), 'AppStream metainfo source must exist');
  assert.ok(fs.existsSync(path.join(__dirname, '../scripts/update-metainfo.js')), 'AppStream metadata updater must exist');

  const workflow = loadWorkflow('release.yml');
  const jobs = workflow.jobs;
  const triggers = workflow.on || workflow['true'];
  const createRelease = jobs['create-release'];
  const metadata = findStep(createRelease, 'Determine release metadata');
  const validateTag = findStep(createRelease, 'Validate release tag');
  assertShellStep(createRelease, 'Determine release metadata');
  assertShellStep(createRelease, 'Validate release tag');
  assertShellStep(createRelease, 'Create GitHub draft release (if not exists)');
  assert.equal(metadata.env.RELEASE_REF_NAME, '${{ github.ref_name }}');
  assert.equal(validateTag.env.RELEASE_TAG, '${{ steps.release-metadata.outputs.tag }}');
  assert.deepEqual(Object.keys(createRelease.outputs).sort(), ['channel', 'make_latest', 'manifest_prefix', 'prerelease', 'promotion_only', 'version']);
  assert.deepEqual(triggers.workflow_dispatch.inputs.channel.options, ['stable', 'beta'],
    'nightly releases are rejected (#503): stable and beta are the only channels');
  assert.equal(triggers.workflow_dispatch.inputs.channel.type, 'choice');
  assert.equal(triggers.workflow_dispatch.inputs.release_tag.required, true);
  assert.equal(triggers.workflow_dispatch.inputs.release_tag.type, 'string');
  assert.equal(triggers.workflow_dispatch.inputs.promote_stable.type, 'boolean');

  for (const scriptName of ['release:linux', 'release:mac', 'release:win']) {
    assert.match(pkg.scripts?.[scriptName], /--publish never$/, `${scriptName} must not publish outside the release workflow`);
  }

  const linuxJob = jobs['release-linux'];
  const linuxBuild = findStep(linuxJob, 'Build Linux artifacts');
  assertShellStep(linuxJob, 'Build Linux artifacts');
  assert.equal(linuxBuild.env.FLO_LINUX_ARCH, '${{ matrix.arch }}', 'Linux release names must use the safe matrix architecture labels');
  assertShellStep(linuxJob, 'Verify Linux release assets');
  assertShellStep(linuxJob, 'Upload Linux assets to GitHub release');
  assertShellStep(linuxJob, 'Prepend AppStream release entry');
  const snapPublish = findStep(linuxJob, 'Publish snap to the matching Snap Store channel');
  assertShellStep(linuxJob, 'Publish snap to the matching Snap Store channel');
  assert.deepEqual(linuxJob.strategy.matrix.include.map((entry: any) => entry.runner), ['ubuntu-24.04', 'ubuntu-24.04-arm']);
  assert.equal(snapPublish.if, undefined, 'Snap publication must run for both architectures');

  const macJob = jobs['release-mac'];
  assertShellStep(macJob, 'Build macOS');
  assertShellStep(macJob, 'Verify macOS release assets');
  assertShellStep(macJob, 'Upload macOS assets to GitHub release');

  const winJob = jobs['release-windows'];
  assertShellStep(winJob, 'Build Windows');
  assertShellStep(winJob, 'Verify Windows release assets');
  assertShellStep(winJob, 'Upload Windows assets to GitHub release');
  const storeSetup = findStep(winJob, 'Setup Microsoft Store Developer CLI');
  const storePublish = findStep(winJob, 'Publish Windows AppX packages to Microsoft Store');
  assertShellStep(winJob, 'Publish Windows AppX packages to Microsoft Store');
  assert.equal(storeSetup.uses, 'microsoft/microsoft-store-apppublisher@cc9910a8d59f2eb55cbb83df0a3800cf3b5300e0');
  assert.equal(storeSetup.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/') && needs.create-release.outputs.channel == 'stable'");
  assert.equal(storePublish.if, storeSetup.if);
  assert.equal(storePublish.env.RELEASE_CHANNEL, undefined);

  const verifyJob = jobs['verify-release'];
  const verifierDependencies = findStep(verifyJob, 'Install verifier dependencies');
  assert.equal(verifierDependencies.run, 'npm ci --ignore-scripts --no-audit --no-fund');
  const publishJob = jobs['publish-release'];
  assert.deepEqual(verifyJob.needs, ['create-release', 'release-linux', 'release-mac', 'release-windows']);
  assert.deepEqual(publishJob.needs, ['create-release', 'release-linux', 'release-mac', 'release-windows', 'verify-release']);
  assertShellStep(verifyJob, 'Download and verify every release manifest and referenced artifact');
  assertShellStep(publishJob, 'Publish draft without changing GitHub Latest by default');
  const promoteJob = jobs['promote-release'];
  assert.equal(promoteJob.needs, 'create-release');
  assert.equal(promoteJob.if, "needs.create-release.outputs.promotion_only == 'true'");
  assertShellStep(promoteJob, 'Promote published stable release to GitHub Latest');

  // ── Stable feed isolation (#463 / decision #503) ─────────────────────────
  // The stable release path must be structurally incapable of emitting a
  // prerelease-flagged release or a beta-channel manifest:
  //   - stable channel forces PRERELEASE=false and MANIFEST_PREFIX=latest;
  //   - prerelease flagging and non-latest manifest prefixes are gated on
  //     `$CHANNEL != stable` in every step that touches them;
  //   - GitHub's Latest pointer only moves through an explicit human action
  //     (promote_stable=true), which is rejected for any non-stable channel;
  //   - nightlies are rejected outright, so no third feed can appear.
  const metadataRun = metadata.run as string;
  assert.ok(metadataRun.includes('PRERELEASE=false'), 'release metadata must default PRERELEASE to false for stable');
  assert.ok(
    metadataRun.includes('[ "$CHANNEL" != "stable" ] && PRERELEASE=true'),
    'prerelease flagging must be gated on a non-stable channel'
  );
  assert.ok(metadataRun.includes('MANIFEST_PREFIX=latest'), 'stable releases must use the latest manifest prefix');
  assert.ok(
    metadataRun.includes('[ "$CHANNEL" != "stable" ] && MANIFEST_PREFIX="$CHANNEL"'),
    'beta-channel manifests must be gated on a non-stable channel'
  );
  assert.ok(
    metadataRun.includes('[ "$CHANNEL" = "stable" ] && [ "$VERSION_CHANNEL" != "stable" ]'),
    'a stable-channel release must require a stable package version'
  );

  const draftReleaseStep = findStep(createRelease, 'Create GitHub draft release (if not exists)');
  const draftReleaseRun = draftReleaseStep.run as string;
  assert.ok(draftReleaseRun.includes('--latest=false'), 'creating a draft release must never move GitHub Latest by itself');
  assert.ok(
    draftReleaseRun.includes('[ "$CHANNEL" != "stable" ] && RELEASE_ARGS+=(--prerelease)'),
    'draft releases may only be flagged prerelease for non-stable channels'
  );

  const publishRun = findStep(publishJob, 'Publish draft without changing GitHub Latest by default').run as string;
  assert.ok(publishRun.includes('-F make_latest=false'), 'ordinary publishing must never move GitHub Latest');
  assert.ok(
    publishRun.includes('-F prerelease="${PRERELEASE}"') || publishRun.includes('-F prerelease="${{ needs.create-release.outputs.prerelease }}"'),
    'publishing must carry the per-channel prerelease flag from release metadata'
  );
  const promoteRun = findStep(promoteJob, 'Promote published stable release to GitHub Latest').run as string;
  assert.ok(promoteRun.includes('Only a stable release can be promoted to GitHub Latest.'), 'promotion must refuse non-stable channels');
  assert.ok(promoteRun.includes('must not be prerelease'), 'promotion must refuse prerelease-flagged releases');
  assert.ok(
    metadataRun.includes('[ "$PROMOTE" = "true" ] && [ "$CHANNEL" != "stable" ]'),
    'promote_stable must be refused for non-stable channels'
  );

  const releaseWorkflowText = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  assert.ok(!releaseWorkflowText.includes('nightly'), '#503: release.yml must not contain any nightly publish path');
  const verifierText = fs.readFileSync(path.join(__dirname, '../scripts/verify-release-assets.cjs'), 'utf8');
  assert.ok(!verifierText.includes('nightly'), '#503: the draft-release verifier must not accept nightly manifests');
  assert.deepEqual(releaseVerifier.expectedManifestNames('beta'),
    ['beta.yml', 'beta-mac.yml', 'beta-linux.yml', 'beta-linux-arm64.yml'],
    'beta drafts must be verified against the beta-prefixed updater manifests');


  const macArtifact = build?.mac?.artifactName;
  assert.ok(typeof macArtifact === 'string' && macArtifact.includes('${arch}') && macArtifact.includes('mac') && !/\s/.test(macArtifact.replace(/\$\{[^}]+\}/g, '')), `mac artifact template must be safe: ${JSON.stringify(macArtifact)}`);
  const winArtifact = build?.win?.artifactName;
  assert.ok(typeof winArtifact === 'string' && winArtifact.includes('${arch}') && winArtifact.includes('win') && !/\s/.test(winArtifact.replace(/\$\{[^}]+\}/g, '')), `win artifact template must be safe: ${JSON.stringify(winArtifact)}`);

  const matrixWorkflow = loadWorkflow('nightly-release.yml');
  const matrixTriggers = matrixWorkflow.on || matrixWorkflow['true'];
  assert.deepEqual(matrixTriggers.push.branches, ['main']);
  assert.ok(matrixTriggers.workflow_dispatch !== undefined);
  assert.equal(matrixTriggers.pull_request, undefined);
  assert.equal(matrixWorkflow.concurrency['cancel-in-progress'], false);
  const matrixJob = matrixWorkflow.jobs['build-matrix'];
  assert.equal(matrixJob.name, 'build-${{ matrix.name }}');
  assert.deepEqual(
    matrixJob.strategy.matrix.include.map((entry: any) => entry.name).sort(),
    ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64'].sort()
  );
  const matrixUpload = findStep(matrixJob, 'Upload build artifacts');
  assert.equal(matrixUpload.with.name, 'flocafe-build-${{ matrix.name }}');

  const ciWorkflow = loadWorkflow('ci.yml');
  const e2eJob = ciWorkflow.jobs['e2e-playwright'];
  const releaseRegression = findStep(e2eJob, 'Run renderer and printer regression suites');
  assertShellStep(e2eJob, 'Run renderer and printer regression suites');
  assert.equal(releaseRegression.env.REQUIRE_VISUAL_EVIDENCE, '1');
  assert.equal(releaseRegression.env.EVIDENCE_DIR, '${{ runner.temp }}/flocafe-release-regressions');
  const evidenceUpload = (e2eJob.steps || []).find((step: any) => step.with?.name === 'release-regression-evidence');
  assert.ok(evidenceUpload, 'CI must upload release regression evidence');
  assert.equal(evidenceUpload.with.path, '${{ runner.temp }}/flocafe-release-regressions/');

  console.log('✅ Release config + workflow integrity checks passed');
}

run();
