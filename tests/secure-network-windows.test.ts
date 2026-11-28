import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FIREWALL_LOCAL_PORTS,
  FIREWALL_RULE_NAME,
  buildAddRuleArgs,
  buildDeleteRuleArgs,
  buildElevatedAddRuleScript,
  buildFirewallRepairScript,
  buildShowRuleArgs,
  parseNetworkProfile,
  parseRulePresent,
} from '../main/security/lan-tls/windows-firewall';

const root = path.join(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

function portAllowed(port: number): boolean {
  return FIREWALL_LOCAL_PORTS.split(',').some((part) => {
    const [from, to] = part.split('-').map(Number);
    return port >= from && port <= (to ?? from);
  });
}

console.log('Secure Network Windows integration suite');

// Firewall command construction.
const exe = 'C:\\Program Files\\Flo Cafe\\Flo Cafe.exe';
const add = buildAddRuleArgs(exe);
assert.deepEqual(add.slice(0, 4), ['advfirewall', 'firewall', 'add', 'rule']);
for (const expected of [
  `name=${FIREWALL_RULE_NAME}`,
  'dir=in',
  'action=allow',
  `program=${exe}`,
  'protocol=TCP',
  'profile=private',
  'remoteip=localsubnet',
]) {
  assert.ok(add.includes(expected), `add rule includes ${expected}`);
}
assert.ok(
  !add.some((arg) => /profile=(any|public|domain)/.test(arg)),
  'the rule never covers Public or Domain profiles',
);
assert.ok(
  !add.some((arg) => /remoteip=(any|\*)/i.test(arg)),
  'the rule is never open to every remote address',
);
assert.ok(!add.some((arg) => arg === 'localport=any'), 'ports are enumerated, not open');
assert.deepEqual(
  buildDeleteRuleArgs(),
  ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE_NAME}`],
  "delete is by this feature's rule name only",
);
assert.deepEqual(buildShowRuleArgs().slice(-1), [`name=${FIREWALL_RULE_NAME}`]);

// Every port the HTTPS ladders can land on is covered, and 3001-3003 HTTP ports are not widened.
assert.ok(portAllowed(443), 'port 443 is covered');
// The HTTPS ladders are fixed (443, then 3441-3470), so custom HTTP ports never leave a listener outside the rule.
const wiring0 = read('main/services/secure-network-wiring.ts');
assert.ok(
  !/ladder\(get|get\w+Port\(\)\s*\+/.test(wiring0),
  'HTTPS candidates do not derive from the HTTP ports',
);
const preferredMain = Number(/PREFERRED_MAIN_HTTPS_PORT = (\d+)/.exec(wiring0)![1]);
const ladderStart = Number(/MAIN_LADDER_START = (\d+)/.exec(wiring0)![1]);
const ladderLength = Number(/LADDER_LENGTH = (\d+)/.exec(wiring0)![1]);
assert.ok(portAllowed(preferredMain), 'the preferred main port is covered');
for (let i = 0; i < 3 * ladderLength; i++) {
  assert.ok(portAllowed(ladderStart + i), `HTTPS ladder port ${ladderStart + i} is covered`);
}
assert.ok(!portAllowed(9100), 'the printer port 9100 is never opened');
assert.ok(
  !portAllowed(3001) && !portAllowed(3002) && !portAllowed(3003),
  'HTTP ports are not part of this rule',
);

// Parsing.
assert.equal(
  parseRulePresent(`Rule Name:                            ${FIREWALL_RULE_NAME}\r\n----`, 0),
  true,
);
assert.equal(
  parseRulePresent(`Regelname:                           ${FIREWALL_RULE_NAME}\r\n----`, 0),
  true,
  'a localized field label still counts as present',
);
assert.equal(parseRulePresent('Es stimmt keine Regel mit den Kriterien überein.', 1), false);
assert.equal(parseRulePresent('No rules match the specified criteria.', 1), false);
assert.equal(
  parseRulePresent(`Rule Name: ${FIREWALL_RULE_NAME}`, 1),
  false,
  'a failing netsh never reports a rule',
);
assert.equal(parseNetworkProfile('Private\r\n'), 'private');
assert.equal(
  parseNetworkProfile('Private\r\nPublic\r\n'),
  'public',
  'any Public network is reported',
);
assert.equal(parseNetworkProfile('DomainAuthenticated'), 'domain');
assert.equal(
  parseNetworkProfile('Private\r\nDomainAuthenticated\r\n'),
  'domain',
  'Domain takes precedence over Private because the Private-only firewall rule does not cover Domain',
);
assert.equal(
  parseNetworkProfile('DomainAuthenticated\r\nPrivate\r\n'),
  'domain',
  'mixed Domain and Private profiles preserve the Domain warning regardless of order',
);
assert.equal(
  parseNetworkProfile('DomainAuthenticated\r\nPublic\r\n'),
  'public',
  'Public remains highest precedence when paired with Domain',
);
assert.equal(parseNetworkProfile(''), 'unknown');

// Elevated fix: one elevated process, delete then add, exit code propagated, quoting via encoding.
const inner = buildFirewallRepairScript(exe);
assert.ok(
  inner.indexOf("'delete'") < inner.indexOf("'add'"),
  'delete precedes add so upgrades never duplicate the rule',
);
assert.ok(inner.includes(`'program=${exe}'`), 'a path with spaces is a single argument');
assert.ok(inner.endsWith('exit $LASTEXITCODE'), 'the add result decides success');
const outer = buildElevatedAddRuleScript(exe);
assert.equal((outer.match(/-Verb RunAs/g) ?? []).length, 1, 'exactly one UAC prompt');
assert.ok(
  outer.startsWith("$ErrorActionPreference = 'Stop'; "),
  'UAC cancellation or elevation errors stop execution instead of continuing silently',
);
assert.ok(
  outer.includes('if (-not $p) { exit 1 }; exit $p.ExitCode'),
  'a canceled UAC prompt with null process exits non-zero instead of 0',
);
assert.ok(
  outer.includes('-PassThru') && outer.endsWith('exit $p.ExitCode'),
  'the elevated exit code is propagated',
);
const encoded = /'-EncodedCommand','([^']+)'/.exec(outer)![1];
assert.equal(
  Buffer.from(encoded, 'base64').toString('utf16le'),
  inner,
  'the elevated command is the inner script',
);

// NSIS include mirrors the runtime rule and removes only that rule.
const nsis = read('build/installer.nsh');
assert.ok(nsis.includes(`name="${FIREWALL_RULE_NAME}"`));
assert.ok(
  nsis.includes(`localport=${FIREWALL_LOCAL_PORTS}`),
  'installer and runtime agree on ports',
);
assert.ok(nsis.includes('profile=private') && nsis.includes('remoteip=localsubnet'));
assert.match(
  nsis,
  /!macro customInstall[\s\S]*delete rule[\s\S]*add rule[\s\S]*!macroend/,
  'install is delete-then-add',
);
assert.match(
  nsis,
  /!macro customUnInstall[\s\S]*delete rule name="FloCafe Secure Network"[\s\S]*!macroend/,
  'uninstall removes the rule by name',
);
assert.ok(
  !/certutil|Cert:|delete rule name=all/i.test(nsis),
  'the installer never touches certificate stores or other rules',
);
const pkg = JSON.parse(read('package.json'));
assert.equal(
  pkg.build.nsis.include,
  'build/installer.nsh',
  'the NSIS include is wired into the build',
);
assert.ok(
  !JSON.stringify(pkg.build.appx).includes('installer.nsh'),
  'APPX does not use NSIS scripts',
);

// Lifecycle ordering in the main process.
const index = read('main/index.ts');
const startSecure = index.indexOf('await startSecureNetwork(republishMdns)');
assert.ok(
  startSecure > index.indexOf('await startServerApp()'),
  'HTTPS starts after the three HTTP listeners are bound',
);
assert.ok(
  startSecure < index.indexOf('        startMdns();'),
  'HTTPS starts before mDNS so the advertisement can include it',
);
const shutdownSteps = index.slice(index.indexOf('const cleanupCoordinator'));
const stopSecure = shutdownSteps.indexOf("name: 'Secure Network'");
assert.ok(stopSecure > 0, 'shutdown has a Secure Network step');
assert.ok(
  stopSecure < shutdownSteps.indexOf("name: 'Server App'"),
  'HTTPS stops before the Server App',
);
assert.ok(
  stopSecure < shutdownSteps.indexOf("name: 'Main server'"),
  'HTTPS stops before the main server',
);
assert.ok(
  stopSecure < shutdownSteps.indexOf("name: 'KDS server'"),
  'HTTPS stops before the KDS server',
);
assert.match(
  index,
  /await startSecureNetwork\(republishMdns\);\s*\n\s*if \(isShutdownRequested\(\)\) return;/,
  'a quit during HTTPS startup unwinds',
);

// Optional feature: its startup can never fail POS startup.
const wiring = read('main/services/secure-network-wiring.ts');
assert.match(
  wiring,
  /export async function startSecureNetwork[\s\S]*try \{[\s\S]*catch/,
  'startSecureNetwork swallows errors',
);

// Certificate validation is never disabled anywhere in the main process.
for (const file of ['main/index.ts', 'main/ipc.ts', 'main/security/lan-tls/https-front.ts']) {
  const text = read(file);
  assert.ok(
    !/ignore-certificate-errors|NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*:\s*false|setCertificateVerifyProc/.test(
      text,
    ),
    `${file} does not weaken certificate validation`,
  );
  assert.ok(!/['"]certificate-error['"]/.test(text), `${file} has no certificate-error override`);
}

// The HTTPS fronts add no HSTS or upgrade-insecure-requests, so plain HTTP keeps working.
const csp = read('main/csp.ts');
assert.ok(
  !/upgrade-insecure-requests/.test(csp) &&
    !/Strict-Transport-Security/i.test(read('main/security/lan-tls/https-front.ts')),
);

console.log('Secure Network Windows integration suite passed');
