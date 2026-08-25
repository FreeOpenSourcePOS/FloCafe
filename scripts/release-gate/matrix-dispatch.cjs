#!/usr/bin/env node

const fs = require('node:fs');
const { assertMatrixContract, buildDispatchInputs, createDispatchId } = require('./matrix-contract.cjs');

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
}

function apiHeaders() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2026-03-10',
    'Content-Type': 'application/json',
  };
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...apiHeaders(), ...(options.headers || {}) } });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}) for ${url}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`);
  return body;
}

function assertCorrelatedRun(run, { workflowId, ref, dispatchId }) {
  if (!run || run.workflow_id !== workflowId || run.event !== 'workflow_dispatch' || run.head_branch !== ref) {
    throw new Error('discovered matrix run does not match the dispatched workflow, event, or ref');
  }
  if (typeof run.display_title !== 'string' || !run.display_title.includes(dispatchId)) {
    throw new Error('discovered matrix run is missing the unique dispatch correlation');
  }
}

async function dispatchAndWait({ repo, workflow, ref = 'main', inputs, timeoutMs = 45 * 60 * 1000, pollMs = 15000 }) {
  const apiBase = `https://api.github.com/repos/${repo}`;
  const dispatchId = inputs && inputs.matrix_dispatch_id;
  if (!dispatchId) throw new Error('matrix dispatch inputs must include matrix_dispatch_id');
  const startedAt = Date.now();
  const workflowInfo = await api(`${apiBase}/actions/workflows/${encodeURIComponent(workflow)}`);
  await api(`${apiBase}/actions/workflows/${workflowInfo.id}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  });

  const discoveryDeadline = Date.now() + 90_000;
  let run = null;
  while (!run && Date.now() < discoveryDeadline) {
    const runs = await api(`${apiBase}/actions/workflows/${workflowInfo.id}/runs?event=workflow_dispatch&per_page=20`);
    const matches = (runs.workflow_runs || [])
      .filter((candidate) => candidate.head_branch === ref && Date.parse(candidate.created_at) >= startedAt - 5000)
      .filter((candidate) => typeof candidate.display_title === 'string' && candidate.display_title.includes(dispatchId));
    if (matches.length > 1) throw new Error(`multiple matrix runs matched dispatch correlation ${dispatchId}`);
    run = matches[0] || null;
    if (!run) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!run) throw new Error(`dispatched ${workflow} but could not find its run on ${ref}`);
  assertCorrelatedRun(run, { workflowId: workflowInfo.id, ref, dispatchId });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await api(`${apiBase}/actions/runs/${run.id}`);
    assertCorrelatedRun(current, { workflowId: workflowInfo.id, ref, dispatchId });
    if (current.status === 'completed') {
      if (current.conclusion !== 'success') throw new Error(`installed-artifact matrix run ${run.id} completed with ${current.conclusion}`);
      console.log(`installed-artifact matrix run ${run.id} passed for exact candidate inputs`);
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`installed-artifact matrix run ${run.id} did not complete before the timeout`);
}

async function main() {
  const argv = process.argv.slice(2);
  const repo = arg(argv, '--repo');
  const workflow = arg(argv, '--workflow', 'upgrade-matrix.yml');
  const workflowFile = arg(argv, '--workflow-file');
  if (!repo || !workflowFile) throw new Error('--repo and --workflow-file are required');
  assertMatrixContract(fs.readFileSync(workflowFile, 'utf8'));
  const inputs = buildDispatchInputs({
    fromVersion: arg(argv, '--from-version'),
    candidateTag: arg(argv, '--candidate-tag'),
    candidateCommit: arg(argv, '--candidate-commit'),
    candidateManifestAssetId: arg(argv, '--candidate-manifest-asset-id'),
    candidateManifestSha256: arg(argv, '--candidate-manifest-sha256'),
    dispatchId: createDispatchId(),
  });
  await dispatchAndWait({ repo, workflow, inputs });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { assertCorrelatedRun, dispatchAndWait };
