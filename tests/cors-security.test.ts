import { isAllowedPrivateIp, rateLimit, staticRouteRateLimit } from '../main/middleware/security';
import express from 'express';
import request from 'supertest';

async function run() {
  console.log('Testing CORS IP Validation...');
  
  const assert = (condition: boolean, msg: string) => {
    if (!condition) {
      throw new Error(`Assertion failed: ${msg}`);
    }
  };

  // 1. Localhost
  assert(isAllowedPrivateIp('127.0.0.1') === true, 'Should allow IPv4 loopback');
  assert(isAllowedPrivateIp('::1') === true, 'Should allow IPv6 loopback');

  // 2. Private LAN IPs
  assert(isAllowedPrivateIp('192.168.1.100') === true, 'Should allow 192.168.x.x');
  assert(isAllowedPrivateIp('10.0.0.50') === true, 'Should allow 10.x.x.x');
  assert(isAllowedPrivateIp('172.16.0.1') === true, 'Should allow 172.16.x.x');
  assert(isAllowedPrivateIp('172.31.255.255') === true, 'Should allow 172.31.x.x');

  // 3. Tailscale CGNAT IPs
  assert(isAllowedPrivateIp('100.64.0.1') === true, 'Should allow lower bound Tailscale');
  assert(isAllowedPrivateIp('100.127.255.255') === true, 'Should allow upper bound Tailscale');
  assert(isAllowedPrivateIp('100.100.100.100') === true, 'Should allow middle Tailscale');

  // 4. Disallowed IPs (Public and Out of bounds)
  assert(isAllowedPrivateIp('8.8.8.8') === false, 'Should reject public IP');
  assert(isAllowedPrivateIp('100.63.255.255') === false, 'Should reject out of bound CGNAT (low)');
  assert(isAllowedPrivateIp('100.128.0.0') === false, 'Should reject out of bound CGNAT (high)');
  assert(isAllowedPrivateIp('172.15.255.255') === false, 'Should reject out of bound Class B (low)');
  assert(isAllowedPrivateIp('172.32.0.0') === false, 'Should reject out of bound Class B (high)');
  assert(isAllowedPrivateIp('192.169.0.1') === false, 'Should reject out of bound Class C');

  // 5. Malformed/Spoofed
  assert(isAllowedPrivateIp('10.evil.com') === false, 'Should reject spoofed domains');
  assert(isAllowedPrivateIp('100.64.0') === false, 'Should reject incomplete IP');
  assert(isAllowedPrivateIp('localhost') === false, 'localhost string itself is not an IP');

  // 6. Rate Limiter Bypass Tests
  console.log('Testing Rate Limiter Bypass...');
  
  const createRateLimitedApp = (maxRequests: number, ipOverride?: string, extraOptions?: Record<string, any>) => {
    const app = express();
    if (ipOverride) {
      app.use((req, res, next) => {
        Object.defineProperty(req, 'ip', {
          get: () => ipOverride,
          configurable: true
        });
        next();
      });
    }
    app.use(rateLimit({ windowMs: 60 * 1000, max: maxRequests, ...(extraOptions || {}) }));
    app.get('/test', (req, res) => {
      res.status(200).json({ ok: true });
    });
    return app;
  };

  // Test that public IPs get rate limited
  const publicApp = createRateLimitedApp(2, '8.8.8.8');
  let res = await request(publicApp).get('/test');
  assert(res.status === 200, 'Public IP first request should be OK');
  res = await request(publicApp).get('/test');
  assert(res.status === 200, 'Public IP second request should be OK');
  res = await request(publicApp).get('/test');
  assert(res.status === 429, 'Public IP third request should be rate limited');

  // Test that private/local IPs do NOT get rate limited
  const privateApp = createRateLimitedApp(2, '192.168.1.100');
  for (let i = 0; i < 5; i++) {
    const resPrivate = await request(privateApp).get('/test');
    assert(resPrivate.status === 200, `Private IP request ${i + 1} should bypass rate limiting`);
  }

  // Test IPv6 loopback
  const loopbackV6App = createRateLimitedApp(2, '::1');
  for (let i = 0; i < 5; i++) {
    const resPrivate = await request(loopbackV6App).get('/test');
    assert(resPrivate.status === 200, `IPv6 loopback request ${i + 1} should bypass rate limiting`);
  }

  // Test IPv4-mapped IPv6 address (::ffff:127.0.0.1)
  const mappedV4App = createRateLimitedApp(2, '::ffff:127.0.0.1');
  for (let i = 0; i < 5; i++) {
    const resPrivate = await request(mappedV4App).get('/test');
    assert(resPrivate.status === 200, `IPv4-mapped IPv6 request ${i + 1} should bypass rate limiting`);
  }

  // Test that private IPs ARE rate-limited when bypassPrivateIp:false (auth endpoints, vuln-0003)
  console.log('Testing Auth Rate Limit (bypassPrivateIp: false)...');
  const authApp = createRateLimitedApp(2, '192.168.1.100', { bypassPrivateIp: false });
  let authRes = await request(authApp).get('/test');
  assert(authRes.status === 200, 'Auth: private IP first request OK');
  authRes = await request(authApp).get('/test');
  assert(authRes.status === 200, 'Auth: private IP second request OK');
  authRes = await request(authApp).get('/test');
  assert(authRes.status === 429, 'Auth: private IP third request rate-limited (vuln-0003)');

  // Loopback should also be rate-limited when bypassPrivateIp:false
  const authLoopbackApp = createRateLimitedApp(2, '127.0.0.1', { bypassPrivateIp: false });
  authRes = await request(authLoopbackApp).get('/test');
  assert(authRes.status === 200, 'Auth: loopback first request OK');
  authRes = await request(authLoopbackApp).get('/test');
  assert(authRes.status === 200, 'Auth: loopback second request OK');
  authRes = await request(authLoopbackApp).get('/test');
  assert(authRes.status === 429, 'Auth: loopback third request rate-limited when bypass disabled (vuln-0003)');

  // 7. Equivalent IP forms share one rate-limit bucket (GHSA-wp3q-hc3p-v36c)
  console.log('Testing equivalent IP-form bucket sharing...');

  // A limiter whose client IP is taken per-request from a header, so one app
  // instance sees different address forms (simulates proxy-derived addresses).
  const createRotatingIpApp = (maxRequests: number, extraOptions?: Record<string, any>) => {
    const app = express();
    app.use((req, _res, next) => {
      const headerIp = req.get('x-test-ip');
      if (headerIp) {
        Object.defineProperty(req, 'ip', { get: () => headerIp, configurable: true });
      }
      next();
    });
    app.use(rateLimit({ windowMs: 60 * 1000, max: maxRequests, ...(extraOptions || {}) }));
    app.get('/test', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  };

  // Public IPv4 and its IPv4-mapped IPv6 form must share a single budget:
  // two allowed requests total, not two per form.
  const sharedBucketApp = createRotatingIpApp(2);
  let sharedRes = await request(sharedBucketApp).get('/test').set('x-test-ip', '8.8.8.8');
  assert(sharedRes.status === 200, 'shared bucket: plain IPv4 first request OK');
  sharedRes = await request(sharedBucketApp).get('/test').set('x-test-ip', '::ffff:8.8.8.8');
  assert(sharedRes.status === 200, 'shared bucket: mapped IPv6 second request OK');
  sharedRes = await request(sharedBucketApp).get('/test').set('x-test-ip', '8.8.8.8');
  assert(sharedRes.status === 429, 'shared bucket: third request across equivalent forms throttled (429)');

  // Uppercase-mapped form must canonicalize to the same bucket as lowercase/plain.
  const caseBucketApp = createRotatingIpApp(1);
  let caseRes = await request(caseBucketApp).get('/test').set('x-test-ip', '::FFFF:8.8.8.8');
  assert(caseRes.status === 200, 'case bucket: uppercase mapped first request OK');
  caseRes = await request(caseBucketApp).get('/test').set('x-test-ip', '8.8.8.8');
  assert(caseRes.status === 429, 'case bucket: plain IPv4 shares the same budget (429)');

  // IPv4-mapped private IPv6 must still be recognized as private and bypass.
  assert(isAllowedPrivateIp('::ffff:192.168.1.100') === true, 'Should allow mapped private IPv6');
  assert(isAllowedPrivateIp('::ffff:127.0.0.1') === true, 'Should allow mapped loopback IPv6');
  assert(isAllowedPrivateIp('::ffff:8.8.8.8') === false, 'Should reject mapped public IPv6');

  // Malformed / non-IP / reserved IPv6 must not bypass and must not crash.
  assert(isAllowedPrivateIp('::ffff:999.999.999.999') === false, 'Should reject malformed mapped IPv6');
  assert(isAllowedPrivateIp('fe80::1') === false, 'Should reject link-local IPv6');
  assert(isAllowedPrivateIp('fc00::1') === false, 'Should reject unique-local IPv6');
  const malformedApp = createRotatingIpApp(1);
  let malformedRes = await request(malformedApp).get('/test').set('x-test-ip', 'not-an-ip');
  assert(malformedRes.status === 200, 'malformed: first request handled (not bypassed)');
  malformedRes = await request(malformedApp).get('/test').set('x-test-ip', 'not-an-ip');
  assert(malformedRes.status === 429, 'malformed: second request throttled (429)');

  // 8. Bounded rate limiter state cleanup (GHSA-wp3q-hc3p-v36c)
  console.log('Testing rate limiter bounded state cleanup...');
  const limiter = rateLimit({ windowMs: 10, max: 5 });
  const makeMockReqRes = (ip: string) => {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    const req: any = { ip, socket: { remoteAddress: ip } };
    const res: any = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status: (code: number) => {
        statusCode = code;
        return {
          json: (body: any) => ({ statusCode, body }),
        };
      },
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    return { req, res, next, getNext: () => nextCalled, getStatus: () => statusCode };
  };

  // Populate over 1000 distinct IP entries with a short expiry window
  for (let i = 0; i < 1005; i++) {
    const ip = `198.51.${Math.floor(i / 256)}.${i % 256}`;
    const ctx = makeMockReqRes(ip);
    limiter(ctx.req, ctx.res, ctx.next);
    assert(ctx.getNext() === true, `cleanup seed request ${i + 1} OK`);
  }
  // Wait for the window to expire
  await new Promise(resolve => setTimeout(resolve, 25));
  // The next request with a new IP triggers the table sweep (> 1000 items threshold)
  const sweepCtx = makeMockReqRes('203.0.113.1');
  limiter(sweepCtx.req, sweepCtx.res, sweepCtx.next);
  assert(sweepCtx.getNext() === true, 'cleanup: request after expiry triggers sweep and succeeds');

  // 9. Static/SPA route rate limiter (express-rate-limit + private-IP skip)
  console.log('Testing static route rate limiter...');
  const createStaticRouteApp = (limit: number) => {
    const app = express();
    app.use((req, _res, next) => {
      const headerIp = req.get('x-test-ip');
      if (headerIp) {
        Object.defineProperty(req, 'ip', { get: () => headerIp, configurable: true });
      }
      next();
    });
    app.use(staticRouteRateLimit({ windowMs: 60 * 1000, limit }));
    app.get('/*splat', (_req, res) => res.status(200).send('ok'));
    return app;
  };

  const staticPublicApp = createStaticRouteApp(2);
  let staticRes = await request(staticPublicApp).get('/page').set('x-test-ip', '8.8.8.8');
  assert(staticRes.status === 200, 'static: public IP first request OK');
  staticRes = await request(staticPublicApp).get('/page').set('x-test-ip', '8.8.8.8');
  assert(staticRes.status === 200, 'static: public IP second request OK');
  staticRes = await request(staticPublicApp).get('/page').set('x-test-ip', '8.8.8.8');
  assert(staticRes.status === 429, 'static: public IP third request throttled (429)');

  const staticPrivateApp = createStaticRouteApp(2);
  for (let i = 0; i < 5; i++) {
    staticRes = await request(staticPrivateApp).get('/page').set('x-test-ip', '192.168.1.100');
    assert(staticRes.status === 200, `static: private IP request ${i + 1} bypasses rate limiting`);
  }

  console.log('✅ All CORS IP Validation & Rate Limiter tests passed!');

}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
