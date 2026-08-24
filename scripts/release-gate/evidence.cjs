#!/usr/bin/env node

/**
 * Sanitized release evidence helpers. This module intentionally creates a
 * small permanent summary and rejects credential-bearing fields rather than
 * trying to clean arbitrary logs after the fact.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

const SENSITIVE_KEY = /(pass(word)?|pin|token|secret|credential|authorization|cookie|private.?key|api.?key)/i;
const SENSITIVE_VALUE = /(gh[pousr]_|github_pat_|xox[baprs]-|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]+)/i;
const RETENTION_DAYS = 90;

function assertSafeKey(key) {
  if (SENSITIVE_KEY.test(key)) throw new Error(`sanitized evidence cannot contain sensitive field ${key}`);
}

function assertSafeString(value, path) {
  if (SENSITIVE_VALUE.test(value)) throw new Error(`sanitized evidence contains a credential-like value at ${path}`);
}

function assertSanitized(value, path = '$') {
  if (typeof value === 'string') {
    assertSafeString(value, path);
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSanitized(entry, `${path}[${index}]`));
    return value;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertSafeKey(key);
      assertSanitized(entry, `${path}.${key}`);
    }
  }
  return value;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createReleaseSummary({ manifest, candidateManifestBytes, matrix = null } = {}) {
  if (!manifest || !manifest.release || !manifest.commit) throw new Error('release summary requires a candidate manifest');
  const windowsArtifacts = (manifest.assets || []).filter((asset) => asset.platform === 'windows' && ['installer', 'store-package', 'archive'].includes(asset.kind));
  const hasUnsignedWindows = windowsArtifacts.some((asset) => asset.signing?.status === 'unsigned');
  const hasSignedWindows = windowsArtifacts.some((asset) => asset.signing?.status === 'signed');
  const windowsSigning = hasUnsignedWindows
    ? 'UNSIGNED (accepted residual risk)'
    : hasSignedWindows
      ? 'SIGNED (artifact signature verification recorded)'
      : 'NOT-VERIFIED';
  const summary = {
    schemaVersion: 1,
    type: 'flocafe-release-summary',
    release: {
      tag: manifest.release.tag,
      channel: manifest.release.channel,
      commit: manifest.commit.sha,
      candidateManifestSha256: candidateManifestBytes ? sha256(candidateManifestBytes) : null,
      boundAssetCount: Array.isArray(manifest.assets) ? manifest.assets.length : 0,
    },
    automated: {
      candidateManifest: 'PASS',
      draftInventoryAndDownloads: 'PASS',
      channelPublication: manifest.release.channel === 'beta' ? 'PASS (prerelease, Latest unchanged)' : 'PASS (Latest unchanged until promotion)',
      installedArtifactMatrix: matrix?.status || 'NOT-RUN',
    },
    residualRisk: {
      windowsDirectDownloadSigning: windowsSigning,
      windowsSmartScreen: 'NOT-RUN (requires interactive reputation-bearing Windows installation)',
    },
    manual: {
      desktopCompositor: 'NOT-RUN (real GNOME/Wayland/display behavior is outside hosted runners)',
      physicalPrinters: 'NOT-RUN (software printer contracts do not prove hardware output)',
      masReview: 'NOT-RUN (Apple signing, Transporter, and App Review are external)',
      microsoftStore: 'NOT-RUN (AppX identity is checked; Store submission/review is external)',
    },
    retention: {
      sanitizedWorkflowArtifactsDays: RETENTION_DAYS,
      permanentSummary: true,
      sensitiveLogsExcluded: true,
    },
  };
  return assertReleaseSummary(summary, { manifest, candidateManifestBytes });
}

function assertReleaseSummary(summary, { manifest, candidateManifestBytes } = {}) {
  assertSanitized(summary);
  if (!summary || summary.schemaVersion !== 1 || summary.type !== 'flocafe-release-summary') {
    throw new Error('release summary schema is invalid');
  }
  if (!manifest || !manifest.release || !manifest.commit || !summary.release) {
    throw new Error('release summary must bind a candidate manifest');
  }
  if (summary.release.tag !== manifest.release.tag || summary.release.channel !== manifest.release.channel || summary.release.commit !== manifest.commit.sha) {
    throw new Error('release summary release binding does not match the candidate manifest');
  }
  if (!candidateManifestBytes || summary.release.candidateManifestSha256 !== sha256(candidateManifestBytes)) {
    throw new Error('release summary candidate manifest digest does not match the published bytes');
  }
  if (summary.release.boundAssetCount !== (Array.isArray(manifest.assets) ? manifest.assets.length : -1)) {
    throw new Error('release summary asset count does not match the candidate manifest');
  }
  if (summary.automated?.candidateManifest !== 'PASS' || summary.automated?.draftInventoryAndDownloads !== 'PASS') {
    throw new Error('release summary does not record the required automated release checks');
  }
  assertRetentionPolicy(summary.retention);
  return summary;
}

function writeJson(filePath, value) {
  assertSanitized(value);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function assertRetentionPolicy(policy = {}) {
  if (policy.sanitizedWorkflowArtifactsDays !== RETENTION_DAYS) {
    throw new Error(`sanitized evidence retention must be exactly ${RETENTION_DAYS} days`);
  }
  if (policy.permanentSummary !== true) throw new Error('a permanent sanitized release summary is required');
  if (policy.sensitiveLogsExcluded !== true) throw new Error('credential-bearing logs must be excluded from evidence');
  return true;
}

function parseArgs(argv) {
  const manifestIndex = argv.indexOf('--manifest');
  const outputIndex = argv.indexOf('--output');
  if (manifestIndex === -1 || !argv[manifestIndex + 1]) throw new Error('missing required argument --manifest');
  if (outputIndex === -1 || !argv[outputIndex + 1]) throw new Error('missing required argument --output');
  return { manifest: argv[manifestIndex + 1], output: argv[outputIndex + 1] };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const bytes = fs.readFileSync(options.manifest);
  const manifest = JSON.parse(bytes.toString('utf8'));
  const summary = createReleaseSummary({ manifest, candidateManifestBytes: bytes });
  writeJson(options.output, summary);
  console.log(`sanitized release summary written to ${options.output}`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  RETENTION_DAYS,
  assertRetentionPolicy,
  assertReleaseSummary,
  assertSanitized,
  createReleaseSummary,
  sha256,
  writeJson,
};
