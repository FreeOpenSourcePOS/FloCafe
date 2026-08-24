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
  'from_version',
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

function inputBinding(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^\$\{\{\s*inputs\.([a-z0-9_]+)\s*\}\}$/);
  return match ? match[1] : null;
}

function executableRun(run) {
  if (typeof run !== 'string') return '';
  return run.split(/\r?\n/).filter((line) => !line.trim().startsWith('#')).join('\n');
}

function usesEnvironment(run, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\$${escaped}(?![A-Za-z0-9_])`),
    new RegExp(`\\$\\{${escaped}\\}`),
    new RegExp(`\\$env:${escaped}(?![A-Za-z0-9_])`, 'i'),
    new RegExp(`%${escaped}%`, 'i'),
  ].some((reference) => reference.test(run));
}

function executableInputReferences(job) {
  const addBindings = (scope, bindings) => {
    if (!isRecord(scope)) return;
    for (const [name, value] of Object.entries(scope)) {
      const input = inputBinding(value);
      if (input) bindings.set(name, input);
    }
  };
  const jobBindings = new Map();
  addBindings(job.env, jobBindings);
  const referencesByStep = [];
  for (const step of job.steps) {
    if (!isRecord(step)) continue;
    const bindings = new Map(jobBindings);
    addBindings(step.env, bindings);
    const run = executableRun(step.run);
    const references = new Set();
    for (const match of run.matchAll(/\$\{\{\s*inputs\.([a-z0-9_]+)\s*\}\}/g)) references.add(match[1]);
    for (const [name, input] of bindings.entries()) {
      if (usesEnvironment(run, name)) references.add(input);
    }
    referencesByStep.push(references);
  }
  return referencesByStep;
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
    const referencesByStep = executableInputReferences(job);
    if (referencesByStep.some((references) => REQUIRED_INPUTS.every((input) => references.has(input)))) referencedJobs.push(jobId);
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
