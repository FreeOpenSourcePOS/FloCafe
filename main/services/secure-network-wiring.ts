import { defaultSecureNetworkDirectory, electronSecretStorage } from '../security/lan-tls/ca-store';
import {
  configureSecureNetwork,
  getSecureNetwork,
  type SurfaceDefinition,
} from '../security/lan-tls/secure-network';
import { readWindowsFirewallState } from '../security/lan-tls/windows-firewall';
import { getHttpServer as getMainHttpServer } from '../server';
import { getHttpServer as getKdsHttpServer, getKdsPort } from '../kds-server';
import { getHttpServer as getServerAppHttpServer, getServerAppPort } from '../server-app';
import {
  getAllLocalIPs,
  getServerPort,
  setHttpsPort,
  setKdsHttpsPort,
  setServerAppHttpsPort,
} from '../server-state';

const HTTPS_PORT_OFFSET = 440;
const LADDER_LENGTH = 10;
const PREFERRED_MAIN_HTTPS_PORT = 443;

function ladder(httpPort: number): number[] {
  return Array.from({ length: LADDER_LENGTH }, (_, i) => httpPort + HTTPS_PORT_OFFSET + i);
}

function productionSurfaces(): SurfaceDefinition[] {
  return [
    {
      id: 'main',
      label: 'POS',
      getHttpServer: getMainHttpServer,
      getHttpPort: getServerPort,
      getCandidatePorts: () => [PREFERRED_MAIN_HTTPS_PORT, ...ladder(getServerPort())],
      setHttpsPort,
    },
    {
      id: 'kds',
      label: 'Kitchen display',
      getHttpServer: getKdsHttpServer,
      getHttpPort: getKdsPort,
      getCandidatePorts: () => ladder(getKdsPort()),
      setHttpsPort: setKdsHttpsPort,
    },
    {
      id: 'serverApp',
      label: 'Dining room',
      getHttpServer: getServerAppHttpServer,
      getHttpPort: getServerAppPort,
      getCandidatePorts: () => ladder(getServerAppPort()),
      setHttpsPort: setServerAppHttpsPort,
    },
  ];
}

/** Starts HTTPS for the LAN surfaces. Never throws: Secure Network is optional and must not block POS startup. */
export async function startSecureNetwork(): Promise<void> {
  try {
    const service = configureSecureNetwork({
      directory: defaultSecureNetworkDirectory(),
      storage: electronSecretStorage(),
      getLanIPs: getAllLocalIPs,
      surfaces: productionSurfaces(),
      getFirewallState: readWindowsFirewallState,
    });
    await service.start();
  } catch (error) {
    console.warn('[SecureNetwork] Could not start:', error);
  }
}

export async function stopSecureNetwork(): Promise<void> {
  await getSecureNetwork()?.stop();
}
