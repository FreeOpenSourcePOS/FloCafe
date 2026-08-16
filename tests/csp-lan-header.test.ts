import { buildCspHeader } from '../main/csp';

async function run() {
  console.log('Testing dynamic CSP header construction (issue #303)...');

  const assertEqual = (actual: string, expected: string, msg: string) => {
    if (actual !== expected) {
      throw new Error(`Assertion failed: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
    }
  };

  const makeReq = (host?: string) => ({ get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined) } as any);

  // The fixed directive block every policy shares.
  const prefix = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; ";
  const suffix = "; frame-ancestors 'none'";
  const expectedFor = (connectSrc: string) => `${prefix}connect-src ${connectSrc}${suffix}`;

  // 1. LAN IP origin must be whitelisted in connect-src (HTTP + WebSocket).
  assertEqual(
    buildCspHeader(makeReq('10.0.0.37:3001')),
    expectedFor("'self' http://10.0.0.37:3001 ws://10.0.0.37:3001 wss://10.0.0.37:3001"),
    'LAN host should be whitelisted for HTTP and WebSocket',
  );

  // 2. The Electron renderer origin (localhost) keeps working.
  assertEqual(
    buildCspHeader(makeReq('localhost:3001')),
    expectedFor("'self' http://localhost:3001 ws://localhost:3001 wss://localhost:3001"),
    'localhost should be whitelisted',
  );

  // 3. Different ports (KDS standalone, Server App) resolve against their own host.
  assertEqual(
    buildCspHeader(makeReq('192.168.1.50:3002')),
    expectedFor("'self' http://192.168.1.50:3002 ws://192.168.1.50:3002 wss://192.168.1.50:3002"),
    'KDS standalone host should be whitelisted',
  );
  assertEqual(
    buildCspHeader(makeReq('flo.local:3003')),
    expectedFor("'self' http://flo.local:3003 ws://flo.local:3003 wss://flo.local:3003"),
    'mDNS host should be whitelisted',
  );

  // 4. IPv6 literal (bracketed) is handled without breaking the directive.
  assertEqual(
    buildCspHeader(makeReq('[::1]:3001')),
    expectedFor("'self' http://[::1]:3001 ws://[::1]:3001 wss://[::1]:3001"),
    'IPv6 literal should be whitelisted',
  );

  // 5. A forged Host header must NOT smuggle extra directives — fall back to 'self' only.
  assertEqual(
    buildCspHeader(makeReq("evil.com; script-src 'unsafe-inline' *")),
    expectedFor("'self'"),
    'forged host must fall back to self only',
  );

  // 6. Missing Host header → 'self' only.
  assertEqual(
    buildCspHeader(makeReq(undefined)),
    expectedFor("'self'"),
    'missing host must fall back to self only',
  );

  console.log('✅ All dynamic CSP header tests passed!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
