import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

function readReleaseNotes(): string {
  const candidates = [
    '/tmp/release-notes.md',
    path.join(process.env.LOCALAPPDATA || '', 'Temp/release-notes.md'),
    path.join(process.env.TEMP || '', 'release-notes.md'),
    path.join(process.env.TMP || '', 'release-notes.md'),
    path.join(os.tmpdir(), 'release-notes.md'),
    'C:/Program Files/Git/tmp/release-notes.md',
    'C:/tmp/release-notes.md',
    'D:/tmp/release-notes.md',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
  }
  return '';
}

function assertShellStep(job: any, name: string): void {
  const step = findStep(job, name);
  assert.equal(typeof step.run, 'string', `workflow step "${name}" must execute a shell script`);
}

function renderWorkflowScript(script: string, expressions: Record<string, string>): string {
  return script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
    const key = expression.trim();
    assert.ok(Object.hasOwn(expressions, key), `workflow test has no value for expression ${key}`);
    return expressions[key];
  });
}

function executeWorkflowStep(step: any, options: {
  env?: Record<string, string>;
  expressions?: Record<string, string>;
  fakeNodeVersion?: string;
  fakeCommands?: Record<string, string>;
} = {}): { status: number | null; stdout: string; stderr: string; outputs: Record<string, string>; log: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flocafe-release-config-'));
  const binDir = path.join(tempDir, 'bin');
  const outputPath = path.join(tempDir, 'github-output');
  const logPath = path.join(tempDir, 'commands.log');
  fs.mkdirSync(binDir);
  try {
    if (options.fakeNodeVersion !== undefined) {
      const fakeNode = path.join(binDir, 'node');
      fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' '${options.fakeNodeVersion}'\n`);
      fs.chmodSync(fakeNode, 0o755);
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, 'node.cmd'), `@sh "%~dp0\\node" %*\n`);
      }
    }
    for (const [name, script] of Object.entries(options.fakeCommands || {})) {
      const commandPath = path.join(binDir, name);
      fs.writeFileSync(commandPath, script);
      fs.chmodSync(commandPath, 0o755);
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@sh "%~dp0\\${name}" %*\n`);
      }
    }

    // GitHub Actions runs these steps under bash on every OS, including the
    // windows-latest matrix lane. Resolve bash from PATH there (Git Bash is
    // installed and already on PATH for the repo's own run-test.sh wrapper);
    // a hardcoded /bin/bash only exists on POSIX systems.
    const bashExecutable = process.platform === 'win32' ? 'bash' : '/bin/bash';
    const result = childProcess.spawnSync(
      bashExecutable,
      ['-e', '-u', '-o', 'pipefail', '-c', renderWorkflowScript(step.run as string, options.expressions || {})],
      {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          ...options.env,
          GITHUB_OUTPUT: outputPath,
          RELEASE_TEST_LOG: logPath,
          RUNNER_TEMP: tempDir,
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        },
        encoding: 'utf8',
      }
    );
    const outputs: Record<string, string> = {};
    if (fs.existsSync(outputPath)) {
      for (const line of fs.readFileSync(outputPath, 'utf8').split('\n')) {
        const separator = line.indexOf('=');
        if (separator > 0) outputs[line.slice(0, separator)] = line.slice(separator + 1);
      }
    }
    return {
      status: result.status,
      stdout: result.stdout || '',
      // When the process cannot be spawned at all (e.g. ENOENT), stderr is
      // null; surface the spawn error so assertion messages stay diagnostic.
      stderr: result.stderr || String(result.error || ''),
      outputs,
      log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const fakeGh = `#!/bin/sh
printf '%s\\n' "$*" >> "$RELEASE_TEST_LOG"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then exit 1; fi
if [ "$1" = "api" ] && [ "\${3:-}" = "--jq" ]; then printf '42\\n'; exit 0; fi
if [ "$1" = "api" ] && [ "\${2:-}" != "--method" ]; then printf '{"draft":false,"prerelease":false,"id":42}\\n'; fi
`;

const fakeJq = `#!/bin/sh
case "$*" in
  *draft*) printf 'false\\n' ;;
  *prerelease*) printf 'false\\n' ;;
  *id*) printf '42\\n' ;;
  *) exit 1 ;;
esac
`;

const captureNodeArgs = `#!/bin/sh
printf 'node %s\\n' "$*" >> "$RELEASE_TEST_LOG"
`;

const fakeGit = `#!/bin/sh
if [ "$1" = "tag" ]; then
  printf '2.8.0\\n3.2.0\\n3.2.3\\n3.3.0\\ntax-pack-1.0.0\\n'
  exit 0
fi
exit 0
`;

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
  const masWorkflow = loadWorkflow('publish-mas.yml');
  const masTriggers = masWorkflow.on || masWorkflow['true'];
  const masJob = masWorkflow.jobs['publish-mas'];
  assert.equal(masTriggers.workflow_dispatch.inputs.release_tag.required, true);
  assert.equal(masTriggers.workflow_dispatch.inputs.release_tag.type, 'string');
  const masCheckouts = masJob.steps.filter((step: any) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(masCheckouts[0]?.with?.ref, 'main', 'MAS provenance must use current main verifier code');
  assert.equal(masCheckouts[1]?.with?.ref, '${{ github.sha }}', 'MAS build must use the validated event commit');
  assert.equal(masCheckouts[0]?.with?.['persist-credentials'], false, 'MAS verifier checkout must not persist credentials');
  assert.equal(masCheckouts[1]?.with?.['persist-credentials'], false, 'MAS build checkout must not persist credentials');
  const masProvenance = findStep(masJob, 'Validate MAS release provenance');
  assertShellStep(masJob, 'Validate MAS release provenance');
  assert.equal(masProvenance.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(masProvenance.env.RELEASE_TAG, '${{ inputs.release_tag }}');
  const masProvenanceExecution = executeWorkflowStep(masProvenance, {
    env: { RELEASE_REF_NAME: '3.4.0', RELEASE_REF_TYPE: 'tag', RELEASE_TAG: '3.4.0' },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe', 'github.sha': 'a'.repeat(40) },
    fakeCommands: { node: captureNodeArgs },
  });
  assert.equal(masProvenanceExecution.status, 0, masProvenanceExecution.stderr);
  assert.equal(
    masProvenanceExecution.log.trim(),
    `node scripts/release-gate/validate-release-ref.cjs --repo FreeOpenSourcePOS/FloCafe --tag 3.4.0 --commit ${'a'.repeat(40)} --main-ref main`,
  );
  const masBranchExecution = executeWorkflowStep(masProvenance, {
    env: { RELEASE_REF_NAME: 'main', RELEASE_REF_TYPE: 'branch', RELEASE_TAG: '3.4.0' },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe', 'github.sha': 'a'.repeat(40) },
    fakeCommands: { node: captureNodeArgs },
  });
  assert.notEqual(masBranchExecution.status, 0, 'MAS publishing must reject non-tag workflow refs');
  assert.match(masBranchExecution.stdout, /must run from the selected release tag/);
  const createRelease = jobs['create-release'];
  for (const jobName of ['create-release', 'release-linux', 'release-mac', 'release-windows', 'verify-release', 'publish-release']) {
    const checkout = jobs[jobName].steps.find((step: any) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.ref, '${{ github.sha }}', `${jobName} must use the validated event commit`);
  }
  const metadata = findStep(createRelease, 'Determine release metadata');
  const validateTag = findStep(createRelease, 'Validate release tag');
  const validateProvenance = findStep(createRelease, 'Validate release provenance');
  assertShellStep(createRelease, 'Determine release metadata');
  assertShellStep(createRelease, 'Validate release tag');
  assertShellStep(createRelease, 'Validate release provenance');
  assertShellStep(createRelease, 'Create GitHub draft release (if not exists)');
  assert.equal(metadata.env.RELEASE_REF_NAME, '${{ github.ref_name }}');
  assert.equal(validateTag.env.RELEASE_TAG, '${{ steps.release-metadata.outputs.tag }}');
  assert.equal(validateProvenance.if, "steps.release-metadata.outputs.promotion_only != 'true'");
  assert.equal(validateProvenance.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(validateProvenance.env.RELEASE_TAG, '${{ steps.release-metadata.outputs.tag }}');
  const validateProvenanceExecution = executeWorkflowStep(validateProvenance, {
    env: { RELEASE_TAG: '3.4.0' },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe', 'github.sha': 'a'.repeat(40) },
    fakeCommands: { node: captureNodeArgs },
  });
  assert.equal(validateProvenanceExecution.status, 0, validateProvenanceExecution.stderr);
  assert.equal(
    validateProvenanceExecution.log.trim(),
    `node scripts/release-gate/validate-release-ref.cjs --repo FreeOpenSourcePOS/FloCafe --tag 3.4.0 --commit ${'a'.repeat(40)} --main-ref main`,
  );
  assert.deepEqual(Object.keys(createRelease.outputs).sort(), ['channel', 'make_latest', 'manifest_prefix', 'prerelease', 'promotion_only', 'version']);
  assert.deepEqual(triggers.workflow_dispatch.inputs.channel.options, ['stable', 'beta'],
    'nightly releases are rejected (#503): stable and beta are the only channels');
  assert.equal(triggers.workflow_dispatch.inputs.channel.type, 'choice');
  assert.equal(triggers.workflow_dispatch.inputs.release_tag.required, true);
  assert.equal(triggers.workflow_dispatch.inputs.release_tag.type, 'string');
  assert.equal(triggers.workflow_dispatch.inputs.promote_stable.type, 'boolean');
  assert.equal(triggers.workflow_dispatch.inputs.candidate_manifest_asset_id.required, false);
  assert.equal(triggers.workflow_dispatch.inputs.candidate_manifest_sha256.required, false);

  for (const scriptName of ['release:linux', 'release:mac', 'release:win']) {
    assert.match(pkg.scripts?.[scriptName], /--publish never$/, `${scriptName} must not publish outside the release workflow`);
  }

  const uploadNotes = findStep(createRelease, 'Upload release notes artifact');
  assert.equal(uploadNotes.uses, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
  assert.equal(uploadNotes.with?.name, 'release-notes');
  assert.equal(uploadNotes.with?.path, '/tmp/release-notes.md');
  assert.equal(uploadNotes.with?.['retention-days'], 30);
  assert.equal(uploadNotes.with?.overwrite, true);
  assert.equal(uploadNotes.if, "steps.release-metadata.outputs.promotion_only != 'true'");

  const linuxJob = jobs['release-linux'];
  const downloadNotes = findStep(linuxJob, 'Download release notes artifact');
  assert.equal(downloadNotes.uses, 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c');
  assert.equal(downloadNotes.with?.name, 'release-notes');
  assert.equal(downloadNotes.with?.path, '/tmp');
  assert.equal(downloadNotes['continue-on-error'], undefined, 'Download release notes artifact must strictly require artifact to guarantee note parity');
  const linuxBuild = findStep(linuxJob, 'Build Linux artifacts');
  assertShellStep(linuxJob, 'Build Linux artifacts');
  assert.equal(linuxBuild.env.FLO_LINUX_ARCH, '${{ matrix.arch }}', 'Linux release names must use the safe matrix architecture labels');
  assertShellStep(linuxJob, 'Verify Linux release assets');
  assertShellStep(linuxJob, 'Upload Linux assets to GitHub release');
  assertShellStep(linuxJob, 'Prepend AppStream release entry');
  const snapPublish = findStep(linuxJob, 'Publish snap to the matching Snap Store channel');
  assertShellStep(linuxJob, 'Publish snap to the matching Snap Store channel');
  assert.equal(snapPublish.env.GH_TOKEN, '${{ github.token }}', 'Snap evidence upload must have GitHub API credentials');
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
  const windowsStepNames = new Set((winJob.steps || []).map((step: any) => step.name));
  assert.equal(windowsStepNames.has('Setup Microsoft Store Developer CLI'), false, 'Microsoft Store setup must remain manual');
  assert.equal(windowsStepNames.has('Publish Windows AppX packages to Microsoft Store'), false, 'Microsoft Store submission must not run automatically');

  const verifyJob = jobs['verify-release'];
  const verifierDependencies = findStep(verifyJob, 'Install verifier dependencies');
  assert.equal(verifierDependencies.run, 'npm ci --ignore-scripts --no-audit --no-fund');
  const publishJob = jobs['publish-release'];
  assert.deepEqual(verifyJob.needs, ['create-release', 'release-linux', 'release-mac', 'release-windows']);
  assert.deepEqual(publishJob.needs, ['create-release', 'release-linux', 'release-mac', 'release-windows', 'verify-release']);
  assertShellStep(verifyJob, 'Download and verify every release manifest and referenced artifact');
  const verifyAssetsStep = findStep(verifyJob, 'Download and verify every release manifest and referenced artifact');
  assert.equal(verifyAssetsStep.env.GH_TOKEN, '${{ github.token }}');
  const betaVerify = executeWorkflowStep(verifyAssetsStep, {
    env: {
      RELEASE_TAG: '3.3.1-beta.1',
      RELEASE_CHANNEL: 'beta',
    },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe', 'needs.create-release.outputs.manifest_prefix': 'beta', 'github.sha': 'a'.repeat(40) },
    fakeCommands: { gh: fakeGh, node: captureNodeArgs },
  });
  assert.equal(betaVerify.status, 0, betaVerify.stderr);
  assert.doesNotMatch(betaVerify.log, /--require-snap-evidence/, 'beta Snap permission degradation must not require stable evidence');
  const stableVerify = executeWorkflowStep(verifyAssetsStep, {
    env: {
      RELEASE_TAG: '3.3.0',
      RELEASE_CHANNEL: 'stable',
    },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe', 'needs.create-release.outputs.manifest_prefix': 'latest', 'github.sha': 'b'.repeat(40) },
    fakeCommands: { gh: fakeGh, node: captureNodeArgs },
  });
  assert.equal(stableVerify.status, 0, stableVerify.stderr);
  assert.match(stableVerify.log, /--require-snap-evidence/, 'stable verification must require both Snap markers');
  const missingCandidateManifestId = executeWorkflowStep(verifyAssetsStep, {
    env: {
      RELEASE_TAG: '3.3.0',
      RELEASE_CHANNEL: 'stable',
    },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe', 'needs.create-release.outputs.manifest_prefix': 'latest', 'github.sha': 'b'.repeat(40) },
    fakeCommands: { gh: '#!/bin/sh\nexit 0\n' },
  });
  assert.notEqual(missingCandidateManifestId.status, 0);
  assert.match(missingCandidateManifestId.stdout, /candidate-manifest\.json asset ID is missing/);
  assertShellStep(publishJob, 'Publish draft without changing GitHub Latest by default');
  assert.equal(findStep(publishJob, 'Publish draft without changing GitHub Latest by default').env.GH_TOKEN, '${{ github.token }}');
  const promoteJob = jobs['promote-release'];
  assert.equal(promoteJob.needs, 'create-release');
  assert.equal(promoteJob.if, "needs.create-release.outputs.promotion_only == 'true'");
  const promoteCheckout = promoteJob.steps.find((step: any) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(promoteCheckout?.with?.ref, 'main', 'historical promotion must use current main verifier code');
  const validatePromotedProvenance = findStep(promoteJob, 'Validate historical promotion binding');
  assertShellStep(promoteJob, 'Validate historical promotion binding');
  assert.equal(validatePromotedProvenance.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(validatePromotedProvenance.env.RELEASE_TAG, '${{ needs.create-release.outputs.version }}');
  const validatePromotedProvenanceExecution = executeWorkflowStep(validatePromotedProvenance, {
    env: { RELEASE_TAG: '3.3.0' },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe', 'github.sha': 'b'.repeat(40) },
    fakeCommands: { node: captureNodeArgs },
  });
  assert.equal(validatePromotedProvenanceExecution.status, 0, validatePromotedProvenanceExecution.stderr);
  assert.equal(
    validatePromotedProvenanceExecution.log.trim(),
    `node scripts/release-gate/validate-release-ref.cjs --repo FreeOpenSourcePOS/FloCafe --tag 3.3.0 --commit ${'b'.repeat(40)} --allow-off-main --allow-historical-promotion`,
  );
  const promoteVerifierDependencies = findStep(promoteJob, 'Install verifier dependencies');
  const promoteVerifier = findStep(promoteJob, 'Verify stable Snap publication and permanent evidence');
  const promoteBoundaryRun = promoteJob.steps
    .filter((step: any) => step.name === promoteVerifierDependencies.name || step.name === promoteVerifier.name)
    .map((step: any) => step.run)
    .join('\n');
  const promoteBoundary = executeWorkflowStep(
    { run: promoteBoundaryRun },
    {
      env: { RELEASE_TAG: '3.3.0' },
      expressions: {
        'github.repository': 'FreeOpenSourcePOS/FloCafe',
        'inputs.candidate_manifest_asset_id': '299',
        'inputs.candidate_manifest_sha256': 'a'.repeat(64),
      },
      fakeCommands: {
        npm: `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$RELEASE_TEST_LOG"
`,
        node: `#!/bin/sh
if printf '%s\\n' "$*" | grep -q 'verify-stable-promotion.cjs'; then
  grep -q '^npm ci --ignore-scripts --no-audit --no-fund$' "$RELEASE_TEST_LOG" || exit 1
fi
printf 'node %s\\n' "$*" >> "$RELEASE_TEST_LOG"
`,
      },
    }
  );
  assert.equal(promoteBoundary.status, 0, promoteBoundary.stderr);
  assertShellStep(promoteJob, 'Promote published stable release to GitHub Latest');

  const candidateWorkflow = loadWorkflow('release-candidate-gate.yml');
  const candidateTriggers = candidateWorkflow.on || candidateWorkflow['true'];
  assert.ok(candidateTriggers.workflow_dispatch, 'candidate gate must be manual and must not publish on pushes');
  assert.equal(candidateTriggers.push, undefined);
  const candidateInputs = candidateTriggers.workflow_dispatch.inputs;
  for (const input of ['candidate_tag', 'candidate_commit', 'candidate_manifest_sha256', 'candidate_manifest_asset_id', 'stable_tag', 'from_version']) {
    assert.equal(candidateInputs[input].required, true, `${input} must be exact and required`);
  }
  assert.equal(candidateInputs.run_installed_matrix.type, 'boolean');
  const candidateEvidenceJob = candidateWorkflow.jobs['retain-candidate-evidence'];
  assert.deepEqual(candidateEvidenceJob.needs, ['verify-candidate', 'installed-artifact-matrix', 'matrix-not-run-boundary']);
  assert.equal(candidateEvidenceJob.if, "always() && needs.verify-candidate.result == 'success'");
  const candidateEvidenceUpload = findStep(candidateEvidenceJob, 'Retain sanitized evidence for 90 days');
  assert.equal(candidateEvidenceUpload.with['retention-days'], 90);
  const candidateEvidenceStep = findStep(candidateEvidenceJob, 'Build final sanitized evidence bundle');
  for (const [matrixResult, expectedStatus] of [['success', 'PASS'], ['skipped', 'NOT-RUN'], ['cancelled', 'FAIL']] as const) {
    const matrixEvidence = executeWorkflowStep(candidateEvidenceStep, {
      env: {
        RELEASE_REPOSITORY: 'FreeOpenSourcePOS/FloCafe',
        CANDIDATE_TAG: '3.3.1-beta.1',
        MATRIX_RESULT: matrixResult,
      },
      fakeCommands: { gh: fakeGh, node: captureNodeArgs },
    });
    assert.equal(matrixEvidence.status, 0, matrixEvidence.stderr);
    assert.match(matrixEvidence.log, new RegExp(`--matrix-status ${expectedStatus}`));
  }
  const candidateVerifyStep = findStep(candidateWorkflow.jobs['verify-candidate'], 'Verify exact candidate manifest, tag, commit, and bytes');
  const shellInjection = 'safe"; echo injected >&2; #';
  const safeCandidateVerification = executeWorkflowStep(candidateVerifyStep, {
    env: {
      RELEASE_REPOSITORY: 'FreeOpenSourcePOS/FloCafe',
      CANDIDATE_TAG: shellInjection,
      CANDIDATE_COMMIT: 'a'.repeat(40),
      CANDIDATE_MANIFEST_SHA256: 'b'.repeat(64),
      CANDIDATE_MANIFEST_ASSET_ID: '113',
    },
    fakeNodeVersion: '3.3.1-beta.1',
  });
  assert.equal(safeCandidateVerification.status, 0, safeCandidateVerification.stderr);
  assert.doesNotMatch(safeCandidateVerification.stderr, /injected/);
  const candidateMatrixJob = candidateWorkflow.jobs['installed-artifact-matrix'];
  assert.equal(candidateMatrixJob.if, 'inputs.run_installed_matrix == true');
  assert.equal(candidateWorkflow.jobs['matrix-not-run-boundary'].if, 'inputs.run_installed_matrix != true');
  assert.equal(findStep(candidateMatrixJob, 'Require the #512 runtime-matrix integration contract').env.GH_TOKEN, '${{ github.token }}');

  const metadataStable = executeWorkflowStep(metadata, {
    env: {
      RELEASE_EVENT_NAME: 'push',
      RELEASE_REF_NAME: '3.3.0',
      RELEASE_TAG_INPUT: '',
    },
    expressions: { 'inputs.channel': '', 'inputs.promote_stable': 'false' },
    fakeNodeVersion: '3.3.0',
  });
  assert.equal(metadataStable.status, 0, metadataStable.stderr);
  assert.deepEqual(metadataStable.outputs, {
    version: '3.3.0',
    tag: '3.3.0',
    channel: 'stable',
    manifest_prefix: 'latest',
    prerelease: 'false',
    make_latest: 'false',
    promotion_only: 'false',
  });

  const metadataBeta = executeWorkflowStep(metadata, {
    env: {
      RELEASE_EVENT_NAME: 'workflow_dispatch',
      RELEASE_REF_NAME: '3.3.1-beta.1',
      RELEASE_TAG_INPUT: '3.3.1-beta.1',
    },
    expressions: { 'inputs.channel': 'beta', 'inputs.promote_stable': 'false' },
    fakeNodeVersion: '3.3.1-beta.1',
  });
  assert.equal(metadataBeta.status, 0, metadataBeta.stderr);
  assert.deepEqual(metadataBeta.outputs, {
    version: '3.3.1-beta.1',
    tag: '3.3.1-beta.1',
    channel: 'beta',
    manifest_prefix: 'beta',
    prerelease: 'true',
    make_latest: 'false',
    promotion_only: 'false',
  });

  const metadataNightly = executeWorkflowStep(metadata, {
    env: {
      RELEASE_EVENT_NAME: 'push',
      RELEASE_REF_NAME: '3.3.1-nightly.1',
      RELEASE_TAG_INPUT: '',
    },
    expressions: { 'inputs.channel': '', 'inputs.promote_stable': 'false' },
    fakeNodeVersion: '3.3.1-nightly.1',
  });
  assert.notEqual(metadataNightly.status, 0, 'unsupported prerelease tags must be rejected');

  const metadataPromotion = executeWorkflowStep(metadata, {
    env: {
      RELEASE_EVENT_NAME: 'workflow_dispatch',
      RELEASE_REF_NAME: '3.3.0',
      RELEASE_TAG_INPUT: '3.3.0',
    },
    expressions: { 'inputs.channel': 'stable', 'inputs.promote_stable': 'true' },
    fakeNodeVersion: '3.3.0',
  });
  assert.equal(metadataPromotion.status, 0, metadataPromotion.stderr);
  assert.equal(metadataPromotion.outputs.make_latest, 'true');
  assert.equal(metadataPromotion.outputs.promotion_only, 'true');

  const metadataBetaPromotion = executeWorkflowStep(metadata, {
    env: {
      RELEASE_EVENT_NAME: 'workflow_dispatch',
      RELEASE_REF_NAME: '3.3.1-beta.1',
      RELEASE_TAG_INPUT: '3.3.1-beta.1',
    },
    expressions: { 'inputs.channel': 'beta', 'inputs.promote_stable': 'true' },
    fakeNodeVersion: '3.3.1-beta.1',
  });
  assert.notEqual(metadataBetaPromotion.status, 0, 'beta releases must not be promoted automatically');

  const draftReleaseStep = findStep(createRelease, 'Create GitHub draft release (if not exists)');
  const draftStable = executeWorkflowStep(draftReleaseStep, {
    env: { RELEASE_TAG: '3.3.0', RELEASE_VERSION: '3.3.0', RELEASE_CHANNEL: 'stable' },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe' },
    fakeCommands: { gh: fakeGh, git: fakeGit },
  });
  assert.equal(draftStable.status, 0, draftStable.stderr);
  assert.match(draftStable.log, /release create 3\.3\.0/);
  assert.match(draftStable.log, /--latest=false/);
  assert.doesNotMatch(draftStable.log, /--prerelease/);
  assert.ok(
    readReleaseNotes().includes('compare/3.2.3...3.3.0'),
    'draft release notes must contain comparison link to predecessor tag'
  );

  const draftBeta = executeWorkflowStep(draftReleaseStep, {
    env: { RELEASE_TAG: '3.3.1-beta.1', RELEASE_VERSION: '3.3.0', RELEASE_CHANNEL: 'beta' },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe' },
    fakeCommands: { gh: fakeGh, git: fakeGit },
  });
  assert.equal(draftBeta.status, 0, draftBeta.stderr);
  assert.match(draftBeta.log, /--latest=false/);
  assert.match(draftBeta.log, /--prerelease/);

  const fakeGhExistingDraft = `#!/bin/sh
printf '%s\n' "$*" >> "$RELEASE_TEST_LOG"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  case "$*" in
    *--json*isDraft*) printf 'true\n'; exit 0 ;;
    *--json*body*) printf 'Existing draft release notes for 3.3.0\n'; exit 0 ;;
    *) exit 0 ;;
  esac
fi
exit 1
`;
  const draftExisting = executeWorkflowStep(draftReleaseStep, {
    env: { RELEASE_TAG: '3.3.0', RELEASE_VERSION: '3.3.0', RELEASE_CHANNEL: 'stable' },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe' },
    fakeCommands: { gh: fakeGhExistingDraft, git: fakeGit },
  });
  assert.equal(draftExisting.status, 0, draftExisting.stderr);
  assert.match(draftExisting.stdout, /Draft release 3\.3\.0 already exists, extracting existing release notes/);
  assert.doesNotMatch(draftExisting.log, /release create/);
  assert.ok(
    readReleaseNotes().includes('Existing draft release notes for 3.3.0'),
    'existing draft rerun must extract existing release notes directly from GitHub release body'
  );

  const fakeGhEmptyDraft = `#!/bin/sh
printf '%s\n' "$*" >> "$RELEASE_TEST_LOG"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  case "$*" in
    *--json*isDraft*) printf 'true\n'; exit 0 ;;
    *--json*body*) printf '   \\n\\t  \\n'; exit 0 ;;
    *) exit 0 ;;
  esac
fi
exit 1
`;
  const draftEmpty = executeWorkflowStep(draftReleaseStep, {
    env: { RELEASE_TAG: '3.3.0', RELEASE_VERSION: '3.3.0', RELEASE_CHANNEL: 'stable' },
    expressions: { 'github.repository': 'FreeOpenSourcePOS/FloCafe' },
    fakeCommands: { gh: fakeGhEmptyDraft, git: fakeGit },
  });
  assert.notEqual(draftEmpty.status, 0, 'existing draft with empty or whitespace-only body must be rejected');
  assert.match(draftEmpty.stdout, /Existing draft release 3\.3\.0 has an empty body/);

  const publishStep = findStep(publishJob, 'Publish draft without changing GitHub Latest by default');
  const publishStable = executeWorkflowStep(publishStep, {
    expressions: {
      'needs.create-release.outputs.version': '3.3.0',
      'needs.create-release.outputs.prerelease': 'false',
      'needs.create-release.outputs.make_latest': 'false',
      'needs.create-release.outputs.channel': 'stable',
      'github.repository': 'FreeOpenSourcePOS/FloCafe',
      'github.sha': 'a'.repeat(40),
    },
    fakeNodeVersion: '3.3.0',
    fakeCommands: { gh: fakeGh },
  });
  assert.equal(publishStable.status, 0, publishStable.stderr);
  assert.match(publishStable.log, /-F draft=false -F prerelease=false -f make_latest=false/);
  assert.doesNotMatch(
    publishStable.log,
    /-F make_latest=false/,
    'GitHub make_latest is a string enum and must not be encoded as a JSON boolean',
  );
  assert.doesNotMatch(publishStable.log, /make_latest=true/);

  const publishBeta = executeWorkflowStep(publishStep, {
    expressions: {
      'needs.create-release.outputs.version': '3.3.1-beta.1',
      'needs.create-release.outputs.prerelease': 'true',
      'needs.create-release.outputs.make_latest': 'false',
      'needs.create-release.outputs.channel': 'beta',
      'github.repository': 'FreeOpenSourcePOS/FloCafe',
      'github.sha': 'a'.repeat(40),
    },
    fakeNodeVersion: '3.3.1-beta.1',
    fakeCommands: { gh: fakeGh },
  });
  assert.equal(publishBeta.status, 0, publishBeta.stderr);
  assert.match(publishBeta.log, /-F draft=false -F prerelease=true -f make_latest=false/);
  assert.doesNotMatch(
    publishBeta.log,
    /-F make_latest=false/,
    'GitHub make_latest is a string enum and must not be encoded as a JSON boolean',
  );
  assert.doesNotMatch(publishBeta.log, /make_latest=true/);

  const promoteStep = findStep(promoteJob, 'Promote published stable release to GitHub Latest');
  const promoteStable = executeWorkflowStep(promoteStep, {
    env: { RELEASE_TAG: '3.3.0', RELEASE_CHANNEL: 'stable' },
    expressions: {
      'github.repository': 'FreeOpenSourcePOS/FloCafe',
      'needs.create-release.outputs.version': '3.3.0',
      'needs.create-release.outputs.channel': 'stable',
    },
    fakeCommands: { gh: fakeGh, jq: fakeJq },
  });
  assert.equal(promoteStable.status, 0, promoteStable.stderr);
  assert.match(promoteStable.log, /-f make_latest=true/);
  assert.doesNotMatch(
    promoteStable.log,
    /-F make_latest=true/,
    'GitHub make_latest is a string enum and must not be encoded as a JSON boolean',
  );

  const promoteBeta = executeWorkflowStep(promoteStep, {
    env: { RELEASE_TAG: '3.3.1-beta.1', RELEASE_CHANNEL: 'beta' },
    expressions: {
      'github.repository': 'FreeOpenSourcePOS/FloCafe',
      'needs.create-release.outputs.version': '3.3.1-beta.1',
      'needs.create-release.outputs.channel': 'beta',
    },
    fakeCommands: { gh: fakeGh, jq: fakeJq },
  });
  assert.notEqual(promoteBeta.status, 0, 'beta releases must be refused by the promotion job');

  const verifierRejectsNightly = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, '../scripts/verify-release-assets.cjs'), '--repo', 'FreeOpenSourcePOS/FloCafe', '--tag', '3.3.1-nightly.1', '--channel', 'nightly'],
    { encoding: 'utf8' }
  );
  assert.notEqual(verifierRejectsNightly.status, 0, 'the asset verifier must reject nightly channels');
  assert.match(verifierRejectsNightly.stderr, /unsupported release channel/);
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

  const metaFilePath = path.join(__dirname, '../assets/com.flo.desktop.metainfo.xml');
  const originalMetaContent = fs.readFileSync(metaFilePath, 'utf8');
  const testNotesPath = path.join(os.tmpdir(), `flocafe-release-notes-${Date.now()}.md`);
  try {
    fs.writeFileSync(testNotesPath, 'Features & fixes:\n- Added <parity> & metadata synchronization');
    const updateResult = childProcess.spawnSync(
      process.execPath,
      [path.join(__dirname, '../scripts/update-metainfo.js')],
      {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          RELEASE_NOTES_FILE: testNotesPath,
        },
        encoding: 'utf8',
      }
    );
    assert.equal(updateResult.status, 0, updateResult.stderr);
    const updatedMetaContent = fs.readFileSync(metaFilePath, 'utf8');
    assert.ok(
      updatedMetaContent.includes(`<release version="${pkg.version}"`),
      'update-metainfo.js must prepend release entry for current package version'
    );
    assert.ok(
      updatedMetaContent.includes('&lt;parity&gt; &amp; metadata synchronization'),
      'update-metainfo.js must escape XML entities and preserve release notes text'
    );
  } finally {
    fs.writeFileSync(metaFilePath, originalMetaContent);
    if (fs.existsSync(testNotesPath)) fs.unlinkSync(testNotesPath);
  }

  console.log('✅ Release config + workflow integrity checks passed');
}

run();
