import { Request } from 'express';

/**
 * Matches a safe Host header (hostname, IPv4, or IPv6 with optional port).
 * Malformed headers fall back to 'self' to prevent directive smuggling.
 */
const SAFE_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/;

/**
 * Builds Content-Security-Policy header, deriving connect-src from the Host header
 * so LAN companion devices can connect over HTTP and WebSocket alongside 'self'.
 */
export function buildCspHeader(req: Request): string {
  const host = req.get('Host');
  const connectSrc = host && SAFE_HOST.test(host)
    ? `'self' http://${host} ws://${host} wss://${host}`
    : "'self'";
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
