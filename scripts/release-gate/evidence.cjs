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
const MATRIX_STATUSES = new Set(['PASS', 'FAIL', 'NOT-RUN']);
const SUMMARY_KEYS = ['schemaVersion', 'type', 'release', 'automated', 'residualRisk', 'manual', 'retention'];
const RELEASE_KEYS = ['tag', 'channel', 'commit', 'candidateManifestSha256', 'boundAssetCount'];
const AUTOMATED_KEYS = ['candidateManifest', 'draftInventoryAndDownloads', 'channelPublication', 'snapStorePublication', 'installedArtifactMatrix'];
const RESIDUAL_RISK_KEYS = ['windowsDirectDownloadSigning', 'windowsSmartScreen'];
const MANUAL_KEYS = ['desktopCompositor', 'physicalPrinters', 'masReview', 'microsoftStore'];
const RETENTION_KEYS = ['sanitizedWorkflowArtifactsDays', 'permanentSummary', 'sensitiveLogsExcluded'];

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

function assertExactKeys(value, expectedKeys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new Error(`${path} has an invalid schema`);
  }
}

function windowsSigningSummary(manifest) {
  const windowsArtifacts = (manifest.assets || []).filter((asset) => asset.platform === 'windows' && ['installer', 'store-package', 'archive'].includes(asset.kind));
  if (windowsArtifacts.some((asset) => asset.signing?.status === 'unsigned')) return 'UNSIGNED (accepted residual risk)';
  if (windowsArtifacts.some((asset) => asset.signing?.status === 'signed')) return 'SIGNED (artifact signature verification recorded)';
  return 'NOT-VERIFIED';
}

function snapStorePublicationSummary(manifest) {
  const markerCount = new Set((manifest.assets || [])
    .filter((asset) => /^snap-publication-(x64|arm64)\.json$/.test(asset.name))
    .map((asset) => asset.name)).size;
  if (markerCount === 2) return 'PASS (x64 and arm64 publication evidence recorded)';
  if (manifest.release.channel === 'beta') return 'NOT-RUN (beta Snap Store publication is optional or permission-limited)';
  return 'FAIL (stable Snap Store publication evidence is incomplete; promotion is blocked)';
}

function summaryContract(manifest, candidateManifestBytes, matrixStatus) {
  if (!MATRIX_STATUSES.has(matrixStatus)) throw new Error(`installed artifact matrix status must be PASS, FAIL, or NOT-RUN`);
  return {
    schemaVersion: 1,
    type: 'flocafe-release-summary',
    release: {
      tag: manifest.release.tag,
      channel: manifest.release.channel,
      commit: manifest.commit.sha,
      candidateManifestSha256: sha256(candidateManifestBytes),
      boundAssetCount: Array.isArray(manifest.assets) ? manifest.assets.length : 0,
    },
    automated: {
      candidateManifest: 'PASS',
      draftInventoryAndDownloads: 'PASS',
      channelPublication: manifest.release.channel === 'beta' ? 'PASS (prerelease, Latest unchanged)' : 'PASS (Latest unchanged until promotion)',
      snapStorePublication: snapStorePublicationSummary(manifest),
      installedArtifactMatrix: matrixStatus,
    },
    residualRisk: {
      windowsDirectDownloadSigning: windowsSigningSummary(manifest),
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
}

function createReleaseSummary({ manifest, candidateManifestBytes, matrix = null } = {}) {
  if (!manifest || !manifest.release || !manifest.commit) throw new Error('release summary requires a candidate manifest');
  const summary = summaryContract(manifest, candidateManifestBytes, matrix?.status || 'NOT-RUN');
  return assertReleaseSummary(summary, { manifest, candidateManifestBytes });
}

function assertReleaseSummary(summary, { manifest, candidateManifestBytes, matrix = null } = {}) {
  assertSanitized(summary);
  if (!manifest || !manifest.release || !manifest.commit || !summary.release) {
    throw new Error('release summary must bind a candidate manifest');
  }
  if (!candidateManifestBytes || summary.release.candidateManifestSha256 !== sha256(candidateManifestBytes)) {
    throw new Error('release summary candidate manifest digest does not match the published bytes');
  }
  const matrixStatus = matrix?.status || summary.automated?.installedArtifactMatrix;
  const expected = summaryContract(manifest, candidateManifestBytes, matrixStatus);
  assertExactKeys(summary, SUMMARY_KEYS, 'release summary');
  if (summary.schemaVersion !== expected.schemaVersion || summary.type !== expected.type) {
    throw new Error('release summary schema is invalid');
  }
  assertExactKeys(summary.release, RELEASE_KEYS, 'release summary release section');
  assertExactKeys(summary.automated, AUTOMATED_KEYS, 'release summary automated section');
  assertExactKeys(summary.residualRisk, RESIDUAL_RISK_KEYS, 'release summary residual-risk section');
  assertExactKeys(summary.manual, MANUAL_KEYS, 'release summary manual section');
  assertExactKeys(summary.retention, RETENTION_KEYS, 'release summary retention section');
  for (const section of ['release', 'automated', 'residualRisk', 'manual', 'retention']) {
    for (const key of Object.keys(expected[section])) {
      if (summary[section][key] !== expected[section][key]) {
        throw new Error(`release summary ${section} section does not match the immutable candidate manifest`);
      }
    }
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
  const matrixIndex = argv.indexOf('--matrix-status');
  const matrixStatus = matrixIndex === -1 ? 'NOT-RUN' : (argv[matrixIndex + 1] || '');
  if (!MATRIX_STATUSES.has(matrixStatus)) throw new Error('matrix status must be PASS, FAIL, or NOT-RUN');
  return { manifest: argv[manifestIndex + 1], output: argv[outputIndex + 1], matrixStatus };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const bytes = fs.readFileSync(options.manifest);
  const manifest = JSON.parse(bytes.toString('utf8'));
  const summary = createReleaseSummary({ manifest, candidateManifestBytes: bytes, matrix: { status: options.matrixStatus } });
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
