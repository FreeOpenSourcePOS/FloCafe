import type * as http from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';

/**
 * A shutdown operation is allowed to drain normally, but a broken resource
 * must not hold the process forever. The timeout is deliberately long enough
 * for ordinary requests while still providing an observable emergency bound.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

type ClosableHttpServer = http.Server & {
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

export type ShutdownStep = {
  name: string;
  run: () => void | Promise<void>;
};

function isAlreadyClosedError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ERR_SERVER_NOT_RUNNING' || code === 'ERR_SOCKET_CLOSED';
}

function createTimeoutError(label: string): Error & { code: string } {
  const error = new Error(`${label} shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`) as Error & { code: string };
  error.code = 'ERR_SHUTDOWN_TIMEOUT';
  return error;
}

async function withShutdownTimeout<T>(
  operation: Promise<T>,
  label: string,
  forceClose: () => void,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const timeoutError = createTimeoutError(label);
      try {
        forceClose();
      } catch (error) {
        reject(new AggregateError([timeoutError, error], `${label} forced shutdown failed`));
        return;
      }
      reject(timeoutError);
    }, SHUTDOWN_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Stop accepting HTTP connections and wait for active requests to finish. */
export function closeHttpServer(server: http.Server, label: string): Promise<void> {
  const closableServer = server as ClosableHttpServer;
  const closePromise = new Promise<void>((resolve, reject) => {
    // A server that failed before listen has no work to drain. Avoid calling
    // close() in that state because Node reports ERR_SERVER_NOT_RUNNING.
    if (!closableServer.listening) {
      resolve();
      return;
    }

    try {
      closableServer.close((error?: Error) => {
        if (error && !isAlreadyClosedError(error)) {
          reject(error);
        } else {
          resolve();
        }
      });
      // Node closes idle keep-alive sockets as part of close() on modern
      // runtimes. Call the explicit compatibility hook as well so older
      // supported runtimes do not hold shutdown open on idle clients.
      closableServer.closeIdleConnections?.();
    } catch (error) {
      if (isAlreadyClosedError(error)) resolve();
      else reject(error);
    }
  });

  return withShutdownTimeout(closePromise, label, () => {
    // This is only reached after the normal drain deadline. Active requests
    // may be interrupted, but the bounded failure is returned to the caller.
    closableServer.closeAllConnections?.();
  });
}

function terminateWebSocketClients(wss: WebSocketServer): void {
  for (const client of wss.clients) {
    try {
      client.terminate();
    } catch {
      // closeWebSocketServer reports the server-level failure. A client that
      // cannot be terminated cannot be allowed to keep the process alive.
    }
  }
}

/** Close WebSocket clients/server and wait for the ws close callback. */
export function closeWebSocketServer(wss: WebSocketServer, label: string): Promise<void> {
  let clientCloseError: unknown;
  for (const client of wss.clients) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutting down');
      } else if (client.readyState === WebSocket.CONNECTING) {
        client.terminate();
      }
    } catch (error) {
      // Continue closing every client, then preserve this error for the
      // caller instead of turning cleanup into fire-and-forget work.
      clientCloseError ??= error;
    }
  }

  const closePromise = new Promise<void>((resolve, reject) => {
    try {
      wss.close((error?: Error) => {
        if (error && !isAlreadyClosedError(error)) {
          reject(error);
        } else if (clientCloseError) {
          reject(clientCloseError);
        } else {
          resolve();
        }
      });
    } catch (error) {
      if (isAlreadyClosedError(error)) {
        if (clientCloseError) reject(clientCloseError);
        else resolve();
      } else {
        reject(error);
      }
    }
  });

  return withShutdownTimeout(closePromise, label, () => terminateWebSocketClients(wss));
}

/** Close WebSocket resources and listener, waiting for each to settle. */
export async function closeServerResources(
  server: http.Server | null,
  wss: WebSocketServer | null,
  label: string,
): Promise<void> {
  const errors: unknown[] = [];

  // Upgraded WebSocket connections are owned by the HTTP listener but are not
  // drained by server.close(). Close them first so they cannot keep the HTTP
  // close callback pending forever. Continue to the listener even after a
  // bounded WebSocket failure so one broken client cannot strand cleanup.
  if (wss) {
    try {
      await closeWebSocketServer(wss, `${label} WebSocket`);
    } catch (error) {
      errors.push(error);
    }
  }

  if (server) {
    try {
      await closeHttpServer(server, `${label} HTTP`);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `${label} shutdown failed`);
  }
}

/** Run all cleanup steps in order while still attempting later steps. */
export async function runShutdownSteps(steps: readonly ShutdownStep[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      errors.push(error);
      console.error(`[Shutdown] ${step.name} failed:`, error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Shutdown failed');
  }
}

/**
 * Create an idempotent shutdown operation. Concurrent callers share the same
 * promise, so signal, tray, and Electron quit paths cannot race cleanup.
 */
export function createShutdownCoordinator(getSteps: () => readonly ShutdownStep[]): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    if (!shutdownPromise) {
      shutdownPromise = runShutdownSteps(getSteps());
    }
    return shutdownPromise;
  };
}
