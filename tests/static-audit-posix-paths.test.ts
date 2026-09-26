/**
 * Regression guard for the class of defect behind the Windows static-audit
 * failures: a host-native path compared against a forward-slash literal.
 * `path.relative` returns backslashes on Windows, so an unconverted comparison
 * missed every allowlist entry there. The audits failed on an intentionally
 * reviewed file in one suite and silently skipped a guard in another, both green
 * on macOS and Linux. Only the Windows CI job saw it.
 *
 * These cases are pure string checks, so they run - and fail - on every host.
 */
import { toPosixPath } from './helpers/posix-path';
import { isReviewedRolePolicyFile, allowedRolePolicyFiles } from './authorization-static-audit.test';

const { assertOrThrow, assertEqualOrThrow, getResults, resetCounters } = require('./helpers/test-setup');

resetCounters();

// The helper is the single normaliser every static audit depends on.
assertEqualOrThrow(toPosixPath('main\\routes\\bills.ts'), 'main/routes/bills.ts', 'a win32 path normalises to forward slashes');
assertEqualOrThrow(toPosixPath('main/routes/bills.ts'), 'main/routes/bills.ts', 'a posix path is already canonical and is left alone');
assertEqualOrThrow(toPosixPath('C:\\src\\FloCafe\\main\\kds-server.ts'), 'C:/src/FloCafe/main/kds-server.ts', 'a win32 absolute path normalises to forward slashes');
assertEqualOrThrow(toPosixPath('main\\services\\kds.ts\\..\\refund.ts'), 'main/services/kds.ts/../refund.ts', 'only separators change, never the path segments');

/**
 * Every audit that matches a filesystem path against a forward-slash allowlist
 * must accept that allowlist when handed a win32 path. An audit that omits the
 * normaliser fails this case on macOS and Linux too, which is the point: the
 * defect can no longer reach CI as a platform-only surprise.
 */
const pathAllowlistAudits: Array<{ name: string; matcher: (candidate: string) => boolean; allowlist: Iterable<string> }> = [
  {
    name: 'authorization-static-audit direct role checks',
    matcher: isReviewedRolePolicyFile,
    allowlist: allowedRolePolicyFiles,
  },
];

for (const audit of pathAllowlistAudits) {
  const entries = [...audit.allowlist];
  assertOrThrow(entries.length > 0, `${audit.name} has an allowlist to check`);

  for (const entry of entries) {
    assertOrThrow(entry.includes('/') && !entry.includes('\\'), `${audit.name} writes its allowlist in forward slashes: ${entry}`);
    assertOrThrow(audit.matcher(entry), `${audit.name} accepts its own allowlist entry ${entry}`);
    assertOrThrow(
      audit.matcher(entry.replace(/\//g, '\\')),
      `${audit.name} accepts the win32 form of its own allowlist entry ${entry}`,
    );
  }

  // A path that is genuinely not allowlisted stays rejected, so the audit is not
  // weakened into passing everything.
  assertOrThrow(!audit.matcher('main/routes/not-allowlisted.ts'), `${audit.name} still rejects an unlisted file`);
  assertOrThrow(!audit.matcher('main\\routes\\not-allowlisted.ts'), `${audit.name} still rejects an unlisted win32 path`);
}

const { passed, failed, total } = getResults();
console.log(`Static audit path normalisation: ${passed}/${total} assertions passed`);
if (failed > 0) {
  console.error(`Static audit path normalisation FAILED: ${failed} of ${total} assertions failed`);
  process.exit(1);
}
