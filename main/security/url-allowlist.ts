function originFor(hostname: string, port: number): string {
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
}

/**
 * Checks whether a URL is permitted to open in a new local Electron window.
 * Allows local server origins (localhost, loopback, configured local IP) as well
 * as blank windows (`about:blank`, `""`) used for web printing popups.
 */
export function isAllowedLocalWindowUrl(rawUrl: string, port: number, localIp?: string): boolean {
  if (rawUrl === 'about:blank' || rawUrl === '') return true;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return false;

    const allowedOrigins = new Set([
      originFor('localhost', port),
      originFor('127.0.0.1', port),
      originFor('::1', port),
      ...(localIp ? [originFor(localIp, port)] : []),
    ]);

    return allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
