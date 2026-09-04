#!/usr/bin/env node

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMMIT = /^[0-9a-f]{40,64}$/i;

function requiredArg(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`missing required argument ${name}`);
  return args[index + 1];
}

function optionalArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] || fallback);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    repo: requiredArg(args, '--repo'),
    tag: requiredArg(args, '--tag'),
    commit: requiredArg(args, '--commit').toLowerCase(),
    mainRef: optionalArg(args, '--main-ref', 'main'),
    requireMain: !args.includes('--allow-off-main'),
  };
  const parts = options.repo.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9.-]+$/.test(part))) {
    throw new Error(`invalid repository ${options.repo}`);
  }
  if (!SEMVER.test(options.tag)) throw new Error(`invalid release tag ${options.tag}`);
  if (!COMMIT.test(options.commit)) throw new Error(`invalid release commit ${options.commit}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(options.mainRef)) throw new Error(`invalid main ref ${options.mainRef}`);
  return options;
}

function authHeaders() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2026-03-10',
  };
}

async function githubJson(url) {
  const response = await fetch(url, { headers: authHeaders() });
  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

function decodeJsonContent(file, description) {
  if (!file || file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new Error(`${description} did not return base64 file content`);
  }
  try {
    return JSON.parse(Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${error.message}`);
  }
}

async function resolveSignedTag(apiBase, tag, request = githubJson) {
  const ref = await request(`${apiBase}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref?.object?.type !== 'tag') {
    throw new Error(`release tag ${tag} must be an annotated signed tag, not a lightweight tag`);
  }
  const tagObject = await request(`${apiBase}/git/tags/${encodeURIComponent(ref.object.sha)}`);
  if (tagObject?.object?.type !== 'commit' || !COMMIT.test(tagObject.object.sha || '')) {
    throw new Error(`release tag ${tag} does not resolve directly to a commit`);
  }
  if (tagObject.verification?.verified !== true) {
    throw new Error(`release tag ${tag} is not cryptographically verified (reason: ${tagObject.verification?.reason || 'unknown'})`);
  }
  return tagObject.object.sha.toLowerCase();
}

async function validateReleaseRef({ repo, tag, commit, mainRef = 'main', requireMain = true, request = githubJson }) {
  const apiBase = `https://api.github.com/repos/${repo}`;
  const expectedCommit = commit.toLowerCase();
  const resolvedCommit = await resolveSignedTag(apiBase, tag, request);
  if (resolvedCommit !== expectedCommit) {
    throw new Error(`release tag ${tag} resolves to ${resolvedCommit}, not the workflow commit ${expectedCommit}`);
  }

  const commitObject = await request(`${apiBase}/commits/${resolvedCommit}`);
  if (commitObject.commit?.verification?.verified !== true) {
    throw new Error(`release commit ${resolvedCommit} is not cryptographically verified (reason: ${commitObject.commit?.verification?.reason || 'unknown'})`);
  }

  const taggedPackage = decodeJsonContent(
    await request(`${apiBase}/contents/package.json?ref=${encodeURIComponent(tag)}`),
    `package.json at tag ${tag}`,
  );
  if (taggedPackage.version !== tag) {
    throw new Error(`package.json at tag ${tag} reports version ${taggedPackage.version}, not ${tag}`);
  }

  if (!requireMain) {
    return { commit: resolvedCommit, tag, mainRef, packageVersion: taggedPackage.version };
  }

  const mainRefObject = await request(`${apiBase}/git/ref/heads/${encodeURIComponent(mainRef)}`);
  const mainCommit = mainRefObject?.object?.sha;
  if (!COMMIT.test(mainCommit || '')) throw new Error(`main ref ${mainRef} did not resolve to a commit`);
  const comparison = await request(`${apiBase}/compare/${resolvedCommit}...${mainCommit}`);
  if (comparison.behind_by !== 0) {
    throw new Error(`release commit ${resolvedCommit} is not in ${mainRef} history (behind_by=${comparison.behind_by})`);
  }

  const mainPackage = decodeJsonContent(
    await request(`${apiBase}/contents/package.json?ref=${encodeURIComponent(mainRef)}`),
    `package.json at ${mainRef}`,
  );
  if (mainPackage.version !== tag) {
    throw new Error(`package.json at ${mainRef} reports version ${mainPackage.version}, not release ${tag}`);
  }

  return { commit: resolvedCommit, tag, mainRef, packageVersion: taggedPackage.version };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await validateReleaseRef(options);
  console.log(`release provenance verified: ${result.tag} at ${result.commit} (${result.mainRef})`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { decodeJsonContent, resolveSignedTag, validateReleaseRef };
