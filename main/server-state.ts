import os from 'os';

const DEFAULT_PORT = parseInt(process.env.PORT || '3001', 10);
let activePort = DEFAULT_PORT;

export function getServerPort(): number {
  return activePort;
}

export function setServerPort(port: number): void {
  activePort = port;
}

/** Helper to check if an IPv4 address is active and valid (excludes loopback & 169.254.x.x link-local APIPA). */
function isValidLocalIPv4(alias: os.NetworkInterfaceInfo): boolean {
  const isIPv4 = alias.family === 'IPv4' || (alias.family as string | number) === 4;
  if (!isIPv4 || alias.internal) return false;
  const ip = alias.address;
  if (ip.startsWith('169.254.') || ip.startsWith('127.') || ip === '0.0.0.0') {
    return false;
  }
  return true;
}

/** Returns the first valid non-loopback IPv4 address on the machine. */
export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const alias of iface) {
      if (isValidLocalIPv4(alias)) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

/** Returns all valid non-loopback IPv4 addresses on the machine. */
export function getAllLocalIPs(): string[] {
  const ips: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const alias of iface) {
      if (isValidLocalIPv4(alias)) {
        ips.push(alias.address);
      }
    }
  }
  return ips.length > 0 ? ips : ['127.0.0.1'];
}
