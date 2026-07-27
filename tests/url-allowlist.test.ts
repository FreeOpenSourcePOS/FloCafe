import { isAllowedLocalWindowUrl } from '../main/security/url-allowlist';

function assertEqual(actual: boolean, expected: boolean, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const port = 3001;
const localIp = '192.168.1.25';

assertEqual(isAllowedLocalWindowUrl(`http://localhost:${port}/kds`, port, localIp), true, 'localhost origin allowed');
assertEqual(isAllowedLocalWindowUrl(`http://127.0.0.1:${port}/kds`, port, localIp), true, 'IPv4 loopback origin allowed');
assertEqual(isAllowedLocalWindowUrl(`http://[::1]:${port}/kds`, port, localIp), true, 'IPv6 loopback origin allowed');
assertEqual(isAllowedLocalWindowUrl(`http://${localIp}:${port}/kds`, port, localIp), true, 'configured local IP origin allowed');

assertEqual(isAllowedLocalWindowUrl('http://attacker.com:3001/kds', port, localIp), false, 'attacker origin denied');
assertEqual(isAllowedLocalWindowUrl('http://localhost:3001.attacker.com/kds', port, localIp), false, 'lookalike host denied');
assertEqual(isAllowedLocalWindowUrl('http://localhost:3001-malicious.org/kds', port, localIp), false, 'lookalike port denied');
assertEqual(isAllowedLocalWindowUrl(`http://localhost:${port + 1}/kds`, port, localIp), false, 'wrong port denied');
assertEqual(isAllowedLocalWindowUrl(`https://localhost:${port}/kds`, port, localIp), false, 'wrong protocol denied');
assertEqual(isAllowedLocalWindowUrl('not a URL', port, localIp), false, 'malformed URL denied');
assertEqual(isAllowedLocalWindowUrl(`http://localhost:${port}@attacker.com/kds`, port, localIp), false, 'userinfo lookalike denied');
assertEqual(isAllowedLocalWindowUrl(`http://192.168.1.26:${port}/kds`, port, localIp), false, 'unconfigured local IP denied');

console.log('URL allowlist tests passed');
