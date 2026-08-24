#!/usr/bin/env node

/**
 * Contract guard for the #468/#512 installed-artifact workflow.
 *
 * This repository must not create a second runtime matrix. The candidate gate
 * only dispatches the durable matrix after that workflow advertises inputs for
 * the exact candidate tag, candidate-manifest asset ID, and candidate digest.
 */

const REQUIRED_INPUTS = [
  'candidate_tag',
  'candidate_manifest_asset_id',
  'candidate_manifest_sha256',
];

function assertMatrixContract(workflowText) {
  if (typeof workflowText !== 'string' || workflowText.trim() === '') throw new Error('runtime matrix workflow text is empty');
  if (!/workflow_dispatch\s*:/m.test(workflowText)) throw new Error('runtime matrix must expose workflow_dispatch for release-gate invocation');
  for (const input of REQUIRED_INPUTS) {
    const pattern = new RegExp(`(?:^|\\n)\\s+${input}:\\s*(?:\\n|$)`, 'm');
    if (!pattern.test(workflowText)) {
      throw new Error(`runtime matrix integration boundary is not ready: #512 must add workflow_dispatch input ${input}`);
    }
  }
  if (!/candidate_manifest_sha256/.test(workflowText)) {
    throw new Error('runtime matrix must validate candidate_manifest_sha256 before installing an artifact');
  }
  if (!/candidate_manifest_asset_id/.test(workflowText)) {
    throw new Error('runtime matrix must validate candidate_manifest_asset_id before installing an artifact');
  }
  return true;
}

function buildDispatchInputs({ fromVersion, candidateTag, candidateManifestAssetId, candidateManifestSha256 }) {
  if (!fromVersion || !candidateTag || !candidateManifestAssetId || !candidateManifestSha256) {
    throw new Error('matrix dispatch requires source version, candidate tag, candidate manifest asset ID, and candidate SHA-256');
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(fromVersion)) throw new Error('invalid matrix source version');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(candidateTag)) throw new Error('invalid matrix candidate tag');
  if (!/^\d+$/.test(String(candidateManifestAssetId))) throw new Error('invalid candidate manifest asset ID');
  if (!/^[0-9a-f]{64}$/i.test(candidateManifestSha256)) throw new Error('invalid candidate manifest SHA-256');
  return {
    from_version: fromVersion,
    to_version: candidateTag,
    candidate_tag: candidateTag,
    candidate_manifest_asset_id: String(candidateManifestAssetId),
    candidate_manifest_sha256: candidateManifestSha256.toLowerCase(),
  };
}

module.exports = { REQUIRED_INPUTS, assertMatrixContract, buildDispatchInputs };
