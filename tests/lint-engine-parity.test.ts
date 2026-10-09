import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const backendOxlint = path.join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint');
const frontendOxlint = path.join(frontendDir, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint');

type Diagnostic = {
  code: string;
  severity: string;
  filename: string;
  line: number | null;
  message: string;
  help?: string;
};

function runOxlint(binary: string, cwd: string, args: string[]) {
  const result = spawnSync(binary, [...args, '--format', 'json'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.ok(!result.error, `oxlint must be runnable at ${binary}: ${result.error?.message}`);
  let report: { diagnostics?: Diagnostic[] };
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`oxlint did not report JSON for ${args.join(' ')} (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  const diagnostics = (report.diagnostics || []).map((d) => ({
    ...d,
    line: d.line ?? (d as unknown as { labels?: { span: { line: number } }[] }).labels?.[0]?.span?.line ?? null,
  }));
  return { status: result.status, stdout: result.stdout, diagnostics };
}

function fixtures(files: Record<string, string>, run: () => void) {
  const created: string[] = [];
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(rootDir, relative);
      assert.ok(!fs.existsSync(absolute), `fixture ${relative} must not overwrite an existing file`);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      created.push(absolute);
    }
    run();
  } finally {
    for (const absolute of created) fs.rmSync(absolute, { force: true });
  }
}

const backendDiagnostics = (relativePaths: string[]) => {
  const { status, diagnostics } = runOxlint(backendOxlint, rootDir, relativePaths);
  return { status, diagnostics: diagnostics.filter((d) => relativePaths.includes(d.filename)) };
};

// ── Backend: the shared purity boundary ──────────────────────────────────────

console.log('Testing the shared/ pure-kernel import boundary...');

fixtures(
  {
    'shared/__lint_parity_forbidden.ts': "import fs from 'node:fs';\n\nexport function read(): string {\n  return String(fs);\n}\n",
    'shared/__lint_parity_pure.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    'shared/__lint_parity_relative.ts': "import { add } from './__lint_parity_pure';\n\nexport const total = add(1, 2);\n",
  },
  () => {
    const forbidden = backendDiagnostics(['shared/__lint_parity_forbidden.ts']);
    assert.strictEqual(forbidden.diagnostics.length, 1, 'the forbidden shared import must report exactly one diagnostic');
    assert.strictEqual(forbidden.diagnostics[0].code, 'eslint(no-restricted-imports)');
    assert.strictEqual(forbidden.diagnostics[0].severity, 'error', 'the shared import boundary stays an error');
    assert.match(
      `${forbidden.diagnostics[0].message} ${forbidden.diagnostics[0].help ?? ''}`,
      /pure kernel/,
      'the boundary must keep its explanatory message (Oxlint reports it as the diagnostic help)',
    );
    assert.strictEqual(forbidden.status, 1, 'a forbidden shared import must fail the run');

    const pure = backendDiagnostics(['shared/__lint_parity_pure.ts']);
    assert.strictEqual(pure.diagnostics.length, 0, 'a pure shared module must pass');
    assert.strictEqual(pure.status, 0, 'a pure shared module must exit zero');

    const relative = backendDiagnostics(['shared/__lint_parity_relative.ts']);
    assert.strictEqual(relative.diagnostics.length, 0, 'relative imports inside shared/ must stay allowed');
  },
);

// ── Backend: rule severity and option behavior per scope ─────────────────────

console.log('Testing backend rule severities and options...');

const anyFixture = 'export function anything(value: any): any {\n  return value;\n}\n';

fixtures(
  {
    'main/__lint_parity_any.ts': anyFixture,
    'main/__lint_parity_args.ts':
      'export function ignored(_unused: number): number {\n  return 1;\n}\n\nexport function flagged(unused: number): number {\n  return 1;\n}\n',
    'shared/__lint_parity_any.ts': anyFixture,
  },
  () => {
    const mainAny = backendDiagnostics(['main/__lint_parity_any.ts']);
    assert.strictEqual(mainAny.diagnostics.length, 2, 'both explicit anys in the fixture are reported');
    assert.ok(
      mainAny.diagnostics.every((d) => d.code === 'typescript(no-explicit-any)' && d.severity === 'warning'),
      'explicit any stays a warning under main/',
    );
    assert.strictEqual(mainAny.status, 0, 'warning-only runs must exit zero so the budget gate can read them');

    const sharedAny = backendDiagnostics(['shared/__lint_parity_any.ts']);
    assert.strictEqual(sharedAny.diagnostics.length, 2);
    assert.ok(
      sharedAny.diagnostics.every((d) => d.severity === 'error'),
      'explicit any stays an error under shared/',
    );
    assert.strictEqual(sharedAny.status, 1, 'an error-severity diagnostic must fail the run');

    const args = backendDiagnostics(['main/__lint_parity_args.ts']);
    assert.strictEqual(args.diagnostics.length, 1, 'only the non-underscore unused argument is reported');
    assert.strictEqual(args.diagnostics[0].code, 'eslint(no-unused-vars)');
    assert.strictEqual(args.diagnostics[0].line, 5, 'argsIgnorePattern must exempt the underscore-prefixed argument');
  },
);

// ── Frontend: hooks rules, suppressions, and the deliberate img exception ────

console.log('Testing frontend hooks rules, suppressions, and the img exception...');

fixtures(
  {
    'frontend/src/__lint_parity_hooks.tsx':
      "import { useEffect, useState } from 'react';\n\nexport function HooksFixture({ value }: { value: number }) {\n  const [state, setState] = useState(value);\n  useEffect(() => {\n    setState(value);\n  }, [value]);\n  return <div>{state}</div>;\n}\n",
    'frontend/src/__lint_parity_deps.tsx':
      "import { useEffect } from 'react';\n\nexport function DepsFixture({ value }: { value: number }) {\n  useEffect(() => {\n    void value;\n  }, []);\n  return <p />;\n}\n",
    'frontend/src/__lint_parity_deps_suppressed.tsx':
      "import { useEffect } from 'react';\n\nexport function DepsSuppressed({ value }: { value: number }) {\n  useEffect(() => {\n    void value;\n    // eslint-disable-next-line react-hooks/exhaustive-deps -- fixture suppression\n  }, []);\n  return <p />;\n}\n",
    'frontend/src/__lint_parity_img.tsx': 'export function ImgFixture() {\n  return <img src="/logo.png" alt="" />;\n}\n',
    'frontend/e2e/__lint_parity_e2e.spec.ts': 'export const violation: any = 1;\n',
  },
  () => {
    const run = (relative: string) => runOxlint(frontendOxlint, frontendDir, [relative]);

    const hooks = run('src/__lint_parity_hooks.tsx');
    assert.strictEqual(hooks.diagnostics.length, 1, 'the hooks fixture must report exactly one diagnostic');
    assert.strictEqual(hooks.diagnostics[0].code, 'react(set-state-in-effect)');
    assert.strictEqual(hooks.diagnostics[0].severity, 'error', 'a hooks violation stays an error');
    assert.strictEqual(hooks.status, 1, 'a hooks violation must fail frontend lint');

    const deps = run('src/__lint_parity_deps.tsx');
    assert.strictEqual(deps.diagnostics.length, 1, 'the missing-dependency fixture must warn');
    assert.strictEqual(deps.diagnostics[0].code, 'react-hooks(exhaustive-deps)');
    assert.strictEqual(deps.diagnostics[0].severity, 'warning');

    const suppressed = run('src/__lint_parity_deps_suppressed.tsx');
    assert.strictEqual(
      suppressed.diagnostics.length,
      0,
      "an existing `eslint-disable-next-line react-hooks/exhaustive-deps` comment must keep suppressing the rule",
    );

    const img = run('src/__lint_parity_img.tsx');
    assert.strictEqual(img.diagnostics.length, 0, 'the plain <img> exception must stay allowed in the static export');

    const e2e = run('e2e/__lint_parity_e2e.spec.ts');
    assert.strictEqual(e2e.diagnostics.length, 1, 'frontend e2e sources stay in the linted scope');
    assert.strictEqual(e2e.diagnostics[0].code, 'typescript(no-explicit-any)');
    assert.strictEqual(e2e.diagnostics[0].severity, 'error', 'frontend explicit any stays an error');
  },
);

// ── Frontend: file scope, ignores, and the documented declaration-file gap ───

console.log('Testing frontend file scope and ignore behavior...');

const generatedFixture = 'frontend/.next/__lint_parity_generated.ts';
fixtures({ [generatedFixture]: 'export const generated: any = 1;\n' }, () => {
  const listed = spawnSync(frontendOxlint, ['.', '--debug=files'], {
    cwd: frontendDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).stdout;
  const files = listed
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter((line) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(line));
  assert.ok(files.length > 250, `frontend lint must cover the renderer, e2e, and config sources (saw ${files.length})`);
  assert.ok(files.includes('next.config.ts'), 'frontend config files stay linted');
  assert.ok(files.includes('playwright.config.ts'), 'frontend test config files stay linted');
  assert.ok(files.some((file) => file.startsWith('e2e/')), 'frontend e2e specs stay linted');
  assert.ok(!files.includes(generatedFixture.replace(/^frontend\//, '')), 'generated .next/ output stays ignored');
  assert.ok(
    !files.includes('src/types/receipt-printer-encoder.d.ts'),
    'declaration files stay excluded: Oxlint reports a false TS(2309) for the ambient module declaration tsc accepts',
  );
});

// ── The warning budget gate cannot pass on errors, crashes, or garbage ───────

console.log('Testing the lint warning budget gate...');

const budgetFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lint-budget-'));
try {
  const fixtureScripts = path.join(budgetFixture, 'scripts', 'ci');
  const fixtureBin = path.join(budgetFixture, 'bin');
  const fakeNpxScript = path.join(fixtureBin, 'fake-npx.cjs');
  const fakeNpxPath = path.join(fixtureBin, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixtureBin, { recursive: true });
  fs.mkdirSync(path.join(budgetFixture, 'frontend'), { recursive: true });
  fs.copyFileSync(path.join(rootDir, 'scripts', 'ci', 'check-lint-budget.cjs'), path.join(fixtureScripts, 'check-lint-budget.cjs'));
  fs.writeFileSync(path.join(fixtureScripts, 'lint-budget.json'), JSON.stringify({ backend: 2, frontend: 1 }));

  const fakeNpxSource = `'use strict';
const scope = process.argv.includes('main/') ? 'FLO_FAKE_BACKEND' : 'FLO_FAKE_FRONTEND';
const mode = process.env[scope] || 'ok';
const diagnostics = [];
const bump = (count, severity, code) => { for (let i = 0; i < count; i++) diagnostics.push({ severity, code, filename: 'fixture.ts', message: code }); };
if (mode.startsWith('warn:')) {
  const total = Number(mode.slice(5));
  bump(Math.ceil(total / 2), 'warning', 'eslint(no-explicit-any)');
  bump(Math.floor(total / 2), 'warning', 'next-js(no-location-assign-relative-destination)');
  process.exitCode = 0;
} else if (mode === 'error') {
  bump(1, 'warning', 'eslint(no-explicit-any)');
  bump(1, 'error', 'typescript(no-explicit-any)');
  process.exitCode = 1;
} else if (mode === 'error-zero-exit') {
  bump(1, 'error', 'typescript(no-explicit-any)');
  process.exitCode = 0;
} else if (mode === 'malformed') {
  process.stdout.write('Failed to parse oxlint configuration file.\\n');
  process.exitCode = 0;
} else if (mode === 'crash') {
  process.exitCode = 137;
} else if (mode === 'no-output') {
  process.exitCode = 127;
}
if (mode !== 'malformed' && mode !== 'no-output') {
  process.stdout.write(JSON.stringify({ diagnostics }));
}
`;
  fs.writeFileSync(fakeNpxScript, fakeNpxSource);
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeNpxPath, `@echo off\r\n"${process.execPath}" "${fakeNpxScript}" %*\r\n`);
  } else {
    fs.writeFileSync(fakeNpxPath, `#!/usr/bin/env node\n${fakeNpxSource}`, { mode: 0o755 });
  }

  const runBudget = (backend: string, frontend: string) =>
    spawnSync(process.execPath, [path.join(fixtureScripts, 'check-lint-budget.cjs')], {
      encoding: 'utf8',
      cwd: budgetFixture,
      env: {
        ...process.env,
        PATH: `${fixtureBin}${path.delimiter}${process.env.PATH || ''}`,
        FLO_FAKE_BACKEND: backend,
        FLO_FAKE_FRONTEND: frontend,
      },
    });

  const atBoundary = runBudget('warn:2', 'warn:1');
  assert.strictEqual(atBoundary.status, 0, `warnings at the budget must pass: ${atBoundary.stderr}`);
  assert.match(atBoundary.stdout, /backend: 2 warnings \(budget: 2\)/, 'warnings from native and JS-plugin rules must both be counted');

  const overBoundary = runBudget('warn:3', 'warn:1');
  assert.strictEqual(overBoundary.status, 1, 'warnings over budget must fail');
  assert.match(overBoundary.stderr, /Lint warning budget exceeded for backend: 3 warnings \(budget: 2\)/);

  const frontendOver = runBudget('warn:1', 'warn:2');
  assert.strictEqual(frontendOver.status, 1, 'the two scopes keep separate budgets');
  assert.match(frontendOver.stderr, /Lint warning budget exceeded for frontend: 2 warnings \(budget: 1\)/);

  const withError = runBudget('error', 'warn:1');
  assert.strictEqual(withError.status, 1, 'a lint error must fail the budget gate');
  assert.match(withError.stderr, /Lint errors in backend: 1 error-severity diagnostics/);

  const errorWithoutExitCode = runBudget('error-zero-exit', 'warn:1');
  assert.strictEqual(errorWithoutExitCode.status, 1, 'error diagnostics must fail even when the linter exits zero');

  const malformed = runBudget('malformed', 'warn:1');
  assert.strictEqual(malformed.status, 1, 'a malformed report must fail instead of counting as zero warnings');
  assert.match(malformed.stderr, /did not report valid JSON for backend/);

  const crashed = runBudget('crash', 'warn:1');
  assert.strictEqual(crashed.status, 1, 'an unexpected linter exit must fail even with a parsable report');
  assert.match(crashed.stderr, /exited 137 for backend/);

  const silent = runBudget('no-output', 'warn:1');
  assert.strictEqual(silent.status, 1, 'a linter that produces nothing must fail');

  const realBudget = spawnSync('npm', ['run', 'lint:budget'], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.strictEqual(realBudget.status, 0, `the repository's own lint budget must pass: ${realBudget.stderr}`);
} finally {
  fs.rmSync(budgetFixture, { recursive: true, force: true });
}

console.log('Lint engine parity verified.');
