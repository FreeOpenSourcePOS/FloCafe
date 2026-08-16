import { buildCspHeader } from '../main/csp';

async function run() {
  console.log('Testing dynamic CSP header construction (issue #303)...');

  const assert = (condition: boolean, msg: string) => {
    if (!condition) {
      throw new Error(`Assertion failed: ${msg}`);
    }
  };

  const makeReq = (host?: string) => ({ get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined) } as any);

  // 1. LAN IP origin must be whitelisted in connect-src (HTTP + WebSocket).
  const lan = buildCspHeader(makeReq('10.0.0.37:3001'));
  assert(lan.includes("connect-src 'self' http://10.0.0.37:3001"), `connect-src should include the LAN HTTP origin; got: ${lan}`);
  assert(lan.includes('ws://10.0.0.37:3001'), `connect-src should include the LAN WS origin; got: ${lan}`);
  assert(lan.includes('wss://10.0.0.37:3001'), `connect-src should include the LAN WSS origin; got: ${lan}`);

  // 2. The Electron renderer origin (localhost) keeps working.
  const localhost = buildCspHeader(makeReq('localhost:3001'));
  assert(localhost.includes("connect-src 'self' http://localhost:3001"), `connect-src should include localhost; got: ${localhost}`);
  assert(localhost.includes('ws://localhost:3001'), `connect-src should include localhost WS; got: ${localhost}`);

  // 3. Different ports (KDS standalone, Server App) resolve against their own host.
  const kds = buildCspHeader(makeReq('192.168.1.50:3002'));
  assert(kds.includes('http://192.168.1.50:3002') && kds.includes('ws://192.168.1.50:3002'), `KDS standalone host should be whitelisted; got: ${kds}`);
  const serverApp = buildCspHeader(makeReq('flo.local:3003'));
  assert(serverApp.includes('http://flo.local:3003'), `mDNS host should be whitelisted; got: ${serverApp}`);

  // 4. IPv6 literal (bracketed) is handled without breaking the directive.
  const ipv6 = buildCspHeader(makeReq('[::1]:3001'));
  assert(ipv6.includes('http://[::1]:3001'), `IPv6 literal should be whitelisted; got: ${ipv6}`);

  // 5. A forged Host header must NOT smuggle extra directives — fall back to 'self' only.
  const forged = buildCspHeader(makeReq("evil.com; script-src 'unsafe-inline' *"));
  assert(!forged.includes('evil.com'), `forged host must be rejected; got: ${forged}`);
  assert(forged.includes("connect-src 'self'"), `forged host should fall back to 'self' only; got: ${forged}`);

  // 6. Missing Host header → 'self' only.
  const missing = buildCspHeader(makeReq(undefined));
  assert(missing.includes("connect-src 'self'"), `missing host should fall back to 'self' only; got: ${missing}`);

  // 7. Existing hardening directives are preserved.
  for (const header of [lan, localhost, kds, serverApp, ipv6, missing]) {
    assert(header.includes("frame-ancestors 'none'"), `frame-ancestors 'none' must be present; got: ${header}`);
    assert(header.includes("script-src 'self' 'unsafe-inline'"), `script-src must be preserved; got: ${header}`);
    assert(header.includes("default-src 'self'"), `default-src 'self' must be present; got: ${header}`);
    assert(!header.includes('localhost:3000'), `vestigial localhost:3000 dev entry should be gone; got: ${header}`);
  }

  console.log('✅ All dynamic CSP header tests passed!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
