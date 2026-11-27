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

const LADDER_LENGTH = 10;
const PREFERRED_MAIN_HTTPS_PORT = 443;
const MAIN_LADDER_START = 3441;

/** Fixed ranges inside the Windows firewall rule's ports, whatever the HTTP ports are configured to. */
function ladder(start: number): number[] {
  return Array.from({ length: LADDER_LENGTH }, (_, i) => start + i);
}

function productionSurfaces(): SurfaceDefinition[] {
  return [
    {
      id: 'main',
      label: 'POS',
      getHttpServer: getMainHttpServer,
      getHttpPort: getServerPort,
      getCandidatePorts: () => [PREFERRED_MAIN_HTTPS_PORT, ...ladder(MAIN_LADDER_START)],
      setHttpsPort,
    },
    {
      id: 'kds',
      label: 'Kitchen display',
      getHttpServer: getKdsHttpServer,
      getHttpPort: getKdsPort,
      getCandidatePorts: () => ladder(MAIN_LADDER_START + LADDER_LENGTH),
      setHttpsPort: setKdsHttpsPort,
    },
    {
      id: 'serverApp',
      label: 'Dining room',
      getHttpServer: getServerAppHttpServer,
      getHttpPort: getServerAppPort,
      getCandidatePorts: () => ladder(MAIN_LADDER_START + 2 * LADDER_LENGTH),
      setHttpsPort: setServerAppHttpsPort,
    },
  ];
}

/** Starts HTTPS for the LAN surfaces. Never throws: Secure Network is optional and must not block POS startup. */
export async function startSecureNetwork(onChange?: () => void): Promise<void> {
  try {
    const service = configureSecureNetwork({
      directory: defaultSecureNetworkDirectory(),
      storage: electronSecretStorage(),
      getLanIPs: getAllLocalIPs,
      surfaces: productionSurfaces(),
      getFirewallState: readWindowsFirewallState,
      onChange,
    });
    await service.start();
  } catch (error) {
    console.warn('[SecureNetwork] Could not start:', error);
  }
}

export async function stopSecureNetwork(): Promise<void> {
  await getSecureNetwork()?.stop();
}
