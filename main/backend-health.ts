export interface BackendPorts {
  server: number;
  kds: number;
  serverApp: number;
}

/** Confirms all three owned HTTP services answer on /api/health for real liveness. */
export async function probeBackendHealth(ports: BackendPorts, timeoutMs = 1500): Promise<boolean> {
  const endpoints = [
    `http://127.0.0.1:${ports.server}/api/health`,
    `http://127.0.0.1:${ports.kds}/api/health`,
    `http://127.0.0.1:${ports.serverApp}/api/health`,
  ];

  try {
    const responses = await Promise.all(
      endpoints.map((url) => fetch(url, { signal: AbortSignal.timeout(timeoutMs) })),
    );
    return responses.every((response) => response.ok);
  } catch {
    return false;
  }
}
