import assert from 'node:assert/strict';
import os from 'node:os';
import { getAllLocalIPs, getLocalIP, rankLocalIPv4 } from '../main/server-state';

type Ifaces = ReturnType<typeof os.networkInterfaces>;
const v4 = (address: string) => ({ address, family: 'IPv4', internal: false }) as os.NetworkInterfaceInfo;

function withInterfaces(table: Ifaces, fn: () => void): void {
  const original = os.networkInterfaces;
  (os as any).networkInterfaces = () => table;
  try {
    fn();
  } finally {
    (os as any).networkInterfaces = original;
  }
}

assert.ok(rankLocalIPv4('en0', '192.168.1.20') > rankLocalIPv4('docker0', '172.17.0.1'));
assert.ok(rankLocalIPv4('Wi-Fi', '10.0.0.5') > rankLocalIPv4('vEthernet (WSL)', '172.28.0.1'));
assert.ok(rankLocalIPv4('eth0', '192.168.0.9') > rankLocalIPv4('tailscale0', '100.101.102.103'));
assert.ok(rankLocalIPv4('Ethernet', '192.168.1.5') > rankLocalIPv4('Ethernet 2', '100.64.0.2'));

withInterfaces(
  {
    docker0: [v4('172.17.0.1')],
    'vEthernet (WSL)': [v4('172.28.16.1')],
    tailscale0: [v4('100.100.1.2')],
    wlan0: [v4('192.168.1.42')],
  } as Ifaces,
  () => {
    assert.equal(getLocalIP(), '192.168.1.42');
    assert.equal(getAllLocalIPs()[0], '192.168.1.42');
    assert.equal(getAllLocalIPs().length, 4);
  },
);

withInterfaces({ docker0: [v4('172.17.0.1')] } as Ifaces, () => {
  assert.equal(getLocalIP(), '172.17.0.1', 'a virtual adapter is still used when it is the only one');
});

withInterfaces({} as Ifaces, () => {
  assert.equal(getLocalIP(), '127.0.0.1');
});

console.log('pos-info-network-ranking tests passed');
