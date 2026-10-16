import { Request } from 'express';
import { postHogConnectOrigin } from './services/posthog-config';

/** Matches a safe Host header to prevent directive smuggling. */
const SAFE_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/;

/** Builds CSP header, allowing LAN devices to connect via connect-src. */
export function buildCspHeader(req: Request): string {
  const host = req.get('Host');
  const pageSrc =
    host && SAFE_HOST.test(host) ? `'self' http://${host} ws://${host} wss://${host}` : "'self'";
  const postHogOrigin = postHogConnectOrigin();
  const connectSrc = postHogOrigin ? `${pageSrc} ${postHogOrigin}` : pageSrc;
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
  ].join('; ');
}
