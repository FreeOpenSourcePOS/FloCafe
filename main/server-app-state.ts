const DEFAULT_SERVER_APP_PORT = parseInt(process.env.SERVER_APP_PORT || '3003', 10);
let activeServerAppPort = DEFAULT_SERVER_APP_PORT;

export function getDefaultServerAppPort(): number {
  return DEFAULT_SERVER_APP_PORT;
}

export function getServerAppPort(): number {
  return activeServerAppPort;
}

export function setServerAppPort(port: number): void {
  activeServerAppPort = port;
}
