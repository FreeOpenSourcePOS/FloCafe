#!/usr/bin/env node

/**
 * Contract guard for the #468/#512 installed-artifact workflow.
 *
 * This repository must not create a second runtime matrix. The candidate gate
 * only dispatches the durable matrix after that workflow advertises inputs for
 * the exact candidate tag, candidate-manifest asset ID, candidate digest, and
 * a unique dispatch correlation value.
 */

const crypto = require('node:crypto');
const YAML = require('js-yaml');

const REQUIRED_INPUTS = [
  'candidate_tag',
  'candidate_manifest_asset_id',
  'candidate_manifest_sha256',
  'matrix_dispatch_id',
];
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DISPATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWorkflow(workflowText) {
  if (typeof workflowText !== 'string' || workflowText.trim() === '') throw new Error('runtime matrix workflow text is empty');
  let workflow;
  try {
    workflow = YAML.load(workflowText);
  } catch (error) {
    throw new Error(`runtime matrix workflow is not valid YAML: ${error.message}`);
  }
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new Error('runtime matrix workflow must define jobs');
  return workflow;
}

function workflowTrigger(workflow) {
  return workflow.on || workflow.true;
}

function inputReferences(value, references) {
  if (typeof value === 'string') {
    for (const input of REQUIRED_INPUTS) {
      if (value.includes(`inputs.${input}`)) references.add(input);
    }
    return;
  }
  if (Array.isArray(value)) return;
  if (!isRecord(value)) return;
  for (const entry of Object.values(value)) inputReferences(entry, references);
}

function jobInputReferences(job) {
  const references = new Set();
  inputReferences(job.env, references);
  for (const step of job.steps) {
    if (!isRecord(step)) continue;
    inputReferences(step.env, references);
    inputReferences(step.with, references);
  }
  return references;
}

function assertMatrixContract(workflowText) {
  const workflow = parseWorkflow(workflowText);
  const trigger = workflowTrigger(workflow);
  if (!isRecord(trigger) || !isRecord(trigger.workflow_dispatch) || !isRecord(trigger.workflow_dispatch.inputs)) {
    throw new Error('runtime matrix must expose workflow_dispatch inputs for release-gate invocation');
  }
  for (const input of REQUIRED_INPUTS) {
    const definition = trigger.workflow_dispatch.inputs[input];
    if (!isRecord(definition) || definition.required !== true || (definition.type !== undefined && definition.type !== 'string')) {
      throw new Error(`runtime matrix integration boundary is not ready: #512 must add required workflow_dispatch input ${input}`);
    }
  }
  if (typeof workflow['run-name'] !== 'string' || !workflow['run-name'].includes('${{ inputs.matrix_dispatch_id }}')) {
    throw new Error('runtime matrix must include matrix_dispatch_id in run-name for unambiguous dispatch correlation');
  }

  const referencedJobs = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    const references = jobInputReferences(job);
    if (REQUIRED_INPUTS.every((input) => references.has(input))) referencedJobs.push(jobId);
  }
  if (referencedJobs.length === 0) {
    throw new Error('runtime matrix must validate the exact candidate inputs in an executable job');
  }
  return true;
}

function buildDispatchInputs({ fromVersion, candidateTag, candidateManifestAssetId, candidateManifestSha256, dispatchId }) {
  if (!fromVersion || !candidateTag || !candidateManifestAssetId || !candidateManifestSha256 || !dispatchId) {
    throw new Error('matrix dispatch requires source version, candidate tag, candidate manifest asset ID, candidate SHA-256, and dispatch ID');
  }
  if (!SEMVER.test(fromVersion)) throw new Error('invalid matrix source version');
  if (!SEMVER.test(candidateTag)) throw new Error('invalid matrix candidate tag');
  if (!/^\d+$/.test(String(candidateManifestAssetId))) throw new Error('invalid candidate manifest asset ID');
  if (!/^[0-9a-f]{64}$/i.test(candidateManifestSha256)) throw new Error('invalid candidate manifest SHA-256');
  if (!DISPATCH_ID.test(dispatchId)) throw new Error('invalid matrix dispatch ID');
  return {
    from_version: fromVersion,
    to_version: candidateTag,
    candidate_tag: candidateTag,
    candidate_manifest_asset_id: String(candidateManifestAssetId),
    candidate_manifest_sha256: candidateManifestSha256.toLowerCase(),
    matrix_dispatch_id: dispatchId,
  };
}

function createDispatchId() {
  return crypto.randomUUID();
}

module.exports = { REQUIRED_INPUTS, assertMatrixContract, buildDispatchInputs, createDispatchId, parseWorkflow };
