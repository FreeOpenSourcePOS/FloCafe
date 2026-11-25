import http from 'http';
import https from 'https';
import type { Duplex } from 'stream';
import { closeHttpServer, installHttpShutdownTracking } from '../../shutdown';
import { isPermittedLanIPv4 } from './x509';

export interface TlsCredentials {
  key: string;
  cert: string;
}

export interface HttpsFrontOptions {
  /** Human label used in logs and shutdown errors. */
  label: string;
  /** The live plain-HTTP server whose request and upgrade handlers this front reuses. */
  getHttpServer: () => http.Server | null;
  /** Ports to try in order; the first free one wins. `0` binds an ephemeral port. */
  candidatePorts: number[];
  bindHost?: string;
  credentials: TlsCredentials;
}

export interface HttpsFront {
  readonly label: string;
  start(): Promise<number>;
  stop(): Promise<void>;
  setCredentials(credentials: TlsCredentials): void;
  getPort(): number | null;
}

const HOSTNAME_ALLOWLIST = new Set(['localhost', 'flo.local', '[::1]']);

/**
 * Accepts only the names the leaf certificate can cover: localhost, flo.local, and private IPv4
 * literals. Anything else (including attacker-controlled DNS names pointed at this machine) is refused.
 */
export function isAllowedHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const match = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(hostHeader);
  if (!match) return false;
  const hostname = match[1].toLowerCase();
  if (HOSTNAME_ALLOWLIST.has(hostname)) return true;
  return isPermittedLanIPv4(hostname);
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

/**
 * A TLS listener that terminates HTTPS in-process and hands the decrypted request to the existing
 * HTTP server's handlers. No proxy hop exists, so `req.socket.remoteAddress` is the real LAN client
 * and loopback-only decisions (initial setup, maintenance handoff) cannot be reached remotely.
 */
export function createHttpsFront(options: HttpsFrontOptions): HttpsFront {
  const { label, bindHost = '0.0.0.0' } = options;
  let credentials = options.credentials;
  let server: https.Server | null = null;
  let boundPort: number | null = null;
  const upgradedSockets = new Set<Duplex>();

  const dispatchRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (!isAllowedHostHeader(req.headers.host)) {
      res.writeHead(421, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'Unexpected Host header' }));
      return;
    }
    const target = options.getHttpServer();
    if (!target) {
      res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'Service unavailable' }));
      return;
    }
    target.emit('request', req, res);
  };

  const dispatchUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!isAllowedHostHeader(req.headers.host)) {
      rejectUpgrade(socket, 421, 'Misdirected Request');
      return;
    }
    const target = options.getHttpServer();
    if (!target) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    target.emit('upgrade', req, socket, head);
  };

  const listenOn = (candidate: number, instance: https.Server): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        instance.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        instance.off('error', onError);
        resolve();
      };
      instance.once('error', onError);
      instance.once('listening', onListening);
      instance.listen(candidate, bindHost);
    });

  return {
    label,

    async start(): Promise<number> {
      if (server) return boundPort as number;
      let lastError: unknown = null;
      for (const candidate of options.candidatePorts) {
        const instance = https.createServer(
          { ...credentials, minVersion: 'TLSv1.2' },
          dispatchRequest,
        );
        installHttpShutdownTracking(instance);
        instance.on('upgrade', dispatchUpgrade);
        // A failed TLS handshake is the client's problem (for example an untrusted CA); never crash on it.
        instance.on('tlsClientError', () => {});
        try {
          await listenOn(candidate, instance);
        } catch (error) {
          lastError = error;
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EADDRINUSE' || code === 'EACCES') continue;
          throw error;
        }
        server = instance;
        const address = instance.address();
        boundPort = address && typeof address !== 'string' ? address.port : candidate;
        return boundPort;
      }
      throw lastError ?? new Error(`${label}: no HTTPS port available`);
    },

    async stop(): Promise<void> {
      const closing = server;
      server = null;
      boundPort = null;
      if (!closing) return;
      // Upgraded sockets (KDS WebSockets) leave the HTTP server's connection list, so close them explicitly.
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
      await closeHttpServer(closing, `${label} HTTPS`);
    },

    setCredentials(next: TlsCredentials): void {
      credentials = next;
      server?.setSecureContext({ ...next });
    },

    getPort(): number | null {
      return boundPort;
    },
  };
}
