#!/usr/bin/env node
// Checks developer documentation for broken relative links, index gaps, and
// development-process material that docs/ is not meant to preserve.
// Zero dependencies: Node built-ins only, matching scripts/ci house style.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX = path.join(DOCS, 'README.md');

// Skipped everywhere: generated trees, vendored output, and machine-owned
// changelogs whose links are not authored by hand.
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.next', 'out', '.git']);
const IGNORED_ROOT_MD = new Set(['CHANGELOG.md']);

// Policy patterns that only development-process material matches. Anything
// listed in a file's `docs:policy-allow` front-matter list is exempt.
const POLICY_RULES = [
  {
    id: 'phase-numbering',
    pattern: /\bPhase\s+\d+\b/,
    allow: ['decisions/', 'maintainers/', 'guides/'],
  },
  {
    id: 'implementation-plan',
    pattern: /\b(implementation (plan|sequence)|order of work|rolling out in)\b/i,
    allow: [],
  },
  {
    id: 'research-record',
    pattern: /\b(research report|this (study|doc) (compares|evaluated)|vendor research study)\b/i,
    allow: [],
  },
  {
    id: 'handoff',
    pattern: /\bhand-?off\b/i,
    allow: ['maintainers/'],
  },
  {
    id: 'challenge-review',
    pattern: /\bchallenge review\b/i,
    allow: [],
  },
  {
    id: 'branch-name',
    // Lookbehind keeps URL paths (`.../docs/tutorials/...`) out; the lookahead
    // keeps repository paths (`docs/images/flo-cafe-pos.webp`) out.
    pattern: /(?<![/\w.-])\b(feat|fix|docs|refactor|chore|fm)\/[a-z0-9-]+(?![\w-]*[/.])/,
    allow: ['guides/adding-a-language.md', 'guides/adding-a-tax-pack.md'],
  },
  {
    id: 'workflow-run-link',
    pattern: /\/actions\/runs\/\d+/,
    allow: [],
  },
  {
    id: 'verification-transcript',
    pattern: /\bNOT-RUN\b|\bverdict:\s*(PASS|FAIL)\b/i,
    allow: ['maintainers/'],
  },
  {
    id: 'dated-status-banner',
    pattern: /^\*\*Status:/m,
    allow: ['decisions/'],
  },
];

// "Describe the present." Sentence-anchored past narration with nothing
// checkable next to it is the failure mode this migration removes. Anchoring
// keeps legitimate mid-sentence state descriptions ("a payload that no longer
// validates") out of the report.
const PRESENT_TENSE_RULE = {
  id: 'past-tense-without-verification',
  pattern: /(^|[.;!?]\s+)(previously|formerly|used to|no longer|now uses|now instead)\b/i,
};

const args = new Set(process.argv.slice(2));
const checks = [];
if (args.size === 0 || args.has('--links')) checks.push('links');
if (args.size === 0 || args.has('--index')) checks.push('index');
if (args.size === 0 || args.has('--policy')) checks.push('policy');

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function rel(abs) {
  return toPosix(path.relative(ROOT, abs));
}

function listMarkdown(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...listMarkdown(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function docFiles() {
  return listMarkdown(DOCS);
}

function rootFiles() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !IGNORED_ROOT_MD.has(e.name))
    .map((e) => path.join(ROOT, e.name));
}

// Strips fenced code blocks and inline code so policy rules read prose only.
function proseLines(file) {
  const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  let fence = null;
  raw.forEach((line, i) => {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      out.push({ line: i + 1, text: '' });
      return;
    }
    if (fence !== null) {
      out.push({ line: i + 1, text: '' });
      return;
    }
    out.push({ line: i + 1, text: line.replace(/`[^`]*`/g, '``') });
  });
  return out;
}

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isExternal(target) {
  return /^(https?:|mailto:|tel:|#|\/)/i.test(target);
}

function checkLinks() {
  const errors = [];
  let checked = 0;
  for (const file of [...docFiles(), ...rootFiles()]) {
    const raw = fs.readFileSync(file, 'utf8');
    let match;
    LINK_RE.lastIndex = 0;
    while ((match = LINK_RE.exec(raw)) !== null) {
      let target = match[1];
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      if (isExternal(target)) continue;
      const bare = target.split('#')[0].split('?')[0];
      if (!bare) continue;
      checked += 1;
      const resolved = path.resolve(path.dirname(file), bare);
      if (!fs.existsSync(resolved)) {
        const line = raw.slice(0, match.index).split(/\r?\n/).length;
        errors.push(`${rel(file)}:${line} -> ${target}`);
      }
    }
  }
  return { name: 'relative links', errors, detail: `${checked} checked` };
}

function indexTargets(indexText) {
  const targets = new Set();
  let match;
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(indexText)) !== null) {
    let target = match[1];
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (isExternal(target)) continue;
    targets.add(target.split('#')[0]);
  }
  return targets;
}

function checkIndex() {
  const errors = [];
  const files = docFiles().filter((f) => f !== INDEX);
  if (!fs.existsSync(INDEX)) {
    return { name: 'index completeness', errors: ['docs/README.md is missing'], detail: `${files.length} pages` };
  }
  const linked = indexTargets(fs.readFileSync(INDEX, 'utf8'));
  for (const file of files) {
    const target = toPosix(path.relative(DOCS, file));
    if (!linked.has(target)) errors.push(`${target} is not linked from docs/README.md`);
  }
  for (const target of linked) {
    if (!fs.existsSync(path.join(DOCS, target))) {
      errors.push(`docs/README.md links to ${target}, which does not exist`);
    }
  }
  return { name: 'index completeness', errors, detail: `${files.length} pages, ${linked.size} index links` };
}

// Front-matter escape hatch: a page that legitimately needs a pattern (an ADR
// citing the issue it supersedes, a guide showing a branch name) lists it as
//   <!-- docs:policy-allow: phase-numbering, dated-status-banner -->
function policyAllowList(file, prose) {
  const allow = new Set();
  for (const entry of prose) {
    const m = /<!--\s*docs:policy-allow:\s*([a-z-]+(?:\s*,\s*[a-z-]+)*)\s*-->/.exec(entry.raw);
    if (m) for (const id of m[1].split(',')) allow.add(id.trim());
  }
  const relPath = toPosix(path.relative(ROOT, file));
  for (const rule of POLICY_RULES) {
    for (const prefix of rule.allow) {
      if (relPath === prefix || relPath.startsWith(prefix) || (prefix.includes('/') === false && relPath === prefix)) {
        allow.add(rule.id);
      }
    }
  }
  return allow;
}

function checkPolicy() {
  const errors = [];
  const files = [...docFiles(), ...rootFiles()];
  for (const file of files) {
    const relPath = toPosix(path.relative(ROOT, file));
    const entries = proseLines(file);
    const allow = policyAllowList(
      file,
      entries.map((e) => ({ raw: e.text }))
    );
    for (const rule of POLICY_RULES) {
      if (allow.has(rule.id)) continue;
      for (const entry of entries) {
        if (entry.text && rule.pattern.test(entry.text)) {
          errors.push(`${relPath}:${entry.line} ${rule.id}: ${entry.text.trim().slice(0, 120)}`);
        }
      }
    }
    if (!allow.has(PRESENT_TENSE_RULE.id)) {
      for (const entry of entries) {
        if (!entry.text || !PRESENT_TENSE_RULE.pattern.test(entry.text)) continue;
        if (entry.text.includes('`') && /`[^`]*`/.test(entry.text)) continue;
        errors.push(`${relPath}:${entry.line} ${PRESENT_TENSE_RULE.id}: ${entry.text.trim().slice(0, 120)}`);
      }
    }
  }
  return { name: 'process-material policy', errors, detail: `${files.length} pages` };
}

const RUNNERS = { links: checkLinks, index: checkIndex, policy: checkPolicy };

let failed = false;
let warned = false;
for (const name of checks) {
  const result = RUNNERS[name]();
  if (result.errors.length === 0) {
    console.log(`Docs ${result.name} OK: ${result.detail}.`);
    continue;
  }
  const header = `Docs ${result.name} FAILED (${result.errors.length}):`;
  // Policy output is a ratchet: it is reported but does not gate until the
  // corpus is clean. Link and index output always gates.
  if (name === 'policy') {
    console.warn(`${header}`);
    for (const line of result.errors) console.warn(`  ${line}`);
    warned = true;
    continue;
  }
  console.error(`${header}`);
  for (const line of result.errors) console.error(`  ${line}`);
  console.error('\nFix the paths above rather than loosening the check.');
  failed = true;
}

if (failed) process.exit(1);
if (warned) {
  console.log('\nPolicy findings above are warnings: they are reported, not gated.');
}
