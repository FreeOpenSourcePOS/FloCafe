import type * as http from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';

/**
 * A shutdown operation is allowed to drain normally, but a broken resource
 * must not hold the process forever. The timeout is deliberately long enough
 * for ordinary requests while still providing an observable emergency bound.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export function createShutdownCancellationError(label: string): Error & { code: string } {
  const error = new Error(`${label} startup cancelled during shutdown`) as Error & { code: string };
  error.code = 'ERR_SHUTDOWN_ABORTED';
  return error;
}

type ClosableHttpServer = http.Server & {
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

type HttpRequestState = {
  controller: AbortController;
  work: Set<Promise<unknown>>;
  released: boolean;
  owner: HttpServerState;
};

type HttpServerState = {
  requests: Set<HttpRequestState>;
  closed: boolean;
};

const httpServerStates = new WeakMap<http.Server, HttpServerState>();
const trackedHttpServerStates = new Set<HttpServerState>();
const httpRequestStates = new WeakMap<object, HttpRequestState>();
const shuttingDownHttpServers = new Set<HttpServerState>();

export function installHttpShutdownTracking(server: http.Server): HttpServerState {
  const existing = httpServerStates.get(server);
  if (existing) return existing;

  const state: HttpServerState = { requests: new Set(), closed: false };
  httpServerStates.set(server, state);
  trackedHttpServerStates.add(state);
  server.prependListener('request', (request, response) => {
    const requestState: HttpRequestState = { controller: new AbortController(), work: new Set(), released: false, owner: state };
    state.requests.add(requestState);
    httpRequestStates.set(request, requestState);
    const release = (): void => {
      requestState.released = true;
      if (requestState.work.size === 0) state.requests.delete(requestState);
    };
    response.once('finish', release);
    response.once('close', release);
  });
  return state;
}

export function getHttpRequestSignal(request: object): AbortSignal | undefined {
  return httpRequestStates.get(request)?.controller.signal;
}

export function trackHttpRequestWork<T>(request: object, operation: Promise<T>): Promise<T> {
  const requestState = httpRequestStates.get(request);
  if (!requestState) return operation;
  requestState.work.add(operation);
  void operation.finally(() => {
    requestState.work.delete(operation);
    if (requestState.released && requestState.work.size === 0) {
      requestState.owner.requests.delete(requestState);
      if (requestState.owner.requests.size === 0) {
        shuttingDownHttpServers.delete(requestState.owner);
        if (requestState.owner.closed) trackedHttpServerStates.delete(requestState.owner);
      }
    }
  }).catch(() => {});
  return operation;
}

async function waitForHttpRequestWork(state: HttpServerState): Promise<void> {
  while (true) {
    const work = [...state.requests].flatMap((request) => [...request.work]);
    if (work.length === 0) return;
    await Promise.allSettled(work);
  }
}

function abortHttpRequests(state: HttpServerState): void {
  for (const request of state.requests) request.controller.abort();
}

export type ShutdownStep = {
  name: string;
  run: () => void | Promise<void>;
  blocksDatabase?: boolean;
  databaseClose?: boolean;
};

export type ShutdownCoordinatorOptions = {
  onFatalTimeout?: (error: unknown) => void;
};

function isAlreadyClosedError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ERR_SERVER_NOT_RUNNING' || code === 'ERR_SOCKET_CLOSED';
}

function createTimeoutError(label: string, timeoutMs: number): Error & { code: string } {
  const error = new Error(`${label} shutdown timed out after ${timeoutMs}ms`) as Error & { code: string };
  error.code = 'ERR_SHUTDOWN_TIMEOUT';
  return error;
}

export function isShutdownTimeout(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 'ERR_SHUTDOWN_TIMEOUT') return true;
  return error instanceof AggregateError && error.errors.some((nested) => isShutdownTimeout(nested));
}

async function withShutdownTimeout<T>(
  operation: Promise<T>,
  label: string,
  forceClose: () => void,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const timeoutError = createTimeoutError(label, timeoutMs);
      try {
        forceClose();
      } catch (error) {
        reject(new AggregateError([timeoutError, error], `${label} forced shutdown failed`));
        return;
      }
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Stop accepting HTTP connections and wait for active requests to finish. */
export async function closeHttpServer(server: http.Server, label: string, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  const closableServer = server as ClosableHttpServer;
  const requestState = installHttpShutdownTracking(server);
  shuttingDownHttpServers.add(requestState);
  const closeListenerPromise = new Promise<void>((resolve, reject) => {
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
  const closePromise = Promise.all([closeListenerPromise, waitForHttpRequestWork(requestState)]).then(() => undefined);

  try {
    await withShutdownTimeout(closePromise, label, () => {
      abortHttpRequests(requestState);
      closableServer.closeAllConnections?.();
    }, timeoutMs);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ERR_SHUTDOWN_TIMEOUT') throw error;
    try {
      await withShutdownTimeout(waitForHttpRequestWork(requestState), `${label} handler`, () => {
        abortHttpRequests(requestState);
        closableServer.closeAllConnections?.();
      }, timeoutMs);
    } catch (drainError) {
      throw new AggregateError([error, drainError], `${label} shutdown failed`);
    }
    throw error;
  } finally {
    requestState.closed = true;
    if (requestState.requests.size === 0) shuttingDownHttpServers.delete(requestState);
    if (requestState.requests.size === 0) trackedHttpServerStates.delete(requestState);
  }
}

export async function waitForHttpShutdownWork(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  const states = [...shuttingDownHttpServers];
  try {
    await withShutdownTimeout(
      Promise.all(states.map((state) => waitForHttpRequestWork(state))).then(() => undefined),
      'HTTP handler cleanup',
      () => states.forEach(abortHttpRequests),
      timeoutMs,
    );
  } finally {
    for (const state of states) {
      if (state.requests.size === 0) shuttingDownHttpServers.delete(state);
    }
  }
}

export function cancelHttpShutdownWork(): void {
  for (const state of trackedHttpServerStates) abortHttpRequests(state);
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

function drainWebSocketClients(wss: WebSocketServer, onError: (error: unknown) => void): Promise<void> {
  const clients = [...wss.clients];
  return Promise.all(clients.map((client) => new Promise<void>((resolve) => {
    if (client.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    let settled = false;
    const onClientError = (error: unknown): void => {
      onError(error);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      client.off('close', finish);
      client.off('error', onClientError);
      resolve();
    };
    client.once('close', finish);
    client.once('error', onClientError);
    try {
      if (client.readyState === WebSocket.OPEN) client.close(1001, 'Server shutting down');
      else client.terminate();
    } catch (error) {
      onError(error);
      finish();
    }
  }))).then(() => undefined);
}

/** Close WebSocket clients/server and wait for the ws close callback. */
export function closeWebSocketServer(wss: WebSocketServer, label: string, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  let clientCloseError: unknown;
  const clientsPromise = drainWebSocketClients(wss, (error) => {
    clientCloseError ??= error;
  });

  const serverPromise = new Promise<void>((resolve, reject) => {
    try {
      wss.close((error?: Error) => {
        if (error && !isAlreadyClosedError(error)) {
          reject(error);
        } else {
          resolve();
        }
      });
    } catch (error) {
      if (isAlreadyClosedError(error)) {
        resolve();
      } else {
        reject(error);
      }
    }
  });
  const closePromise = Promise.all([serverPromise, clientsPromise]).then(() => {
    if (clientCloseError) throw clientCloseError;
  });

  return withShutdownTimeout(closePromise, label, () => terminateWebSocketClients(wss), timeoutMs);
}

/** Close WebSocket resources and listener, waiting for each to settle. */
export async function closeServerResources(
  server: http.Server | null,
  wss: WebSocketServer | null,
  label: string,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const errors: unknown[] = [];
  const closePromises: Promise<void>[] = [];

  if (server) {
    try {
      closePromises.push(closeHttpServer(server, `${label} HTTP`, timeoutMs));
    } catch (error) {
      errors.push(error);
    }
  }

  if (wss) {
    try {
      closePromises.push(closeWebSocketServer(wss, `${label} WebSocket`, timeoutMs));
    } catch (error) {
      errors.push(error);
    }
  }

  const results = await Promise.allSettled(closePromises);
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `${label} shutdown failed`);
  }
}

/** Run cleanup steps in order until a fatal timeout boundary is reached. */
export async function runShutdownSteps(
  steps: readonly ShutdownStep[],
  options: ShutdownCoordinatorOptions = {},
): Promise<void> {
  const errors: unknown[] = [];
  let databaseBlocked = false;
  for (const step of steps) {
    if (step.databaseClose && databaseBlocked) continue;
    try {
      const stepPromise = Promise.resolve().then(() => step.run());
      await withShutdownTimeout(stepPromise, step.name, () => {}, SHUTDOWN_TIMEOUT_MS);
    } catch (error) {
      errors.push(error);
      console.error(`[Shutdown] ${step.name} failed:`, error);
      if (step.blocksDatabase) databaseBlocked = true;
      if (isShutdownTimeout(error)) {
        options.onFatalTimeout?.(error);
        throw error;
      }
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
export function createShutdownCoordinator(
  getSteps: () => readonly ShutdownStep[],
  options: ShutdownCoordinatorOptions = {},
): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    if (!shutdownPromise) {
      shutdownPromise = runShutdownSteps(getSteps(), options);
    }
    return shutdownPromise;
  };
}

export type ShutdownEvent = {
  preventDefault: () => void;
};

type ShutdownEventListener = (...args: never[]) => unknown;
type ShutdownAppEvent = 'before-quit' | 'will-quit';
type ShutdownProcessEvent = 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection';

export type ShutdownEntrypointApp = {
  on: (event: ShutdownAppEvent, listener: ShutdownEventListener) => unknown;
  quit: () => void;
  exit: (code?: number) => void;
};

export type ShutdownEntrypointProcess = {
  on: (event: ShutdownProcessEvent, listener: ShutdownEventListener) => unknown;
  exit: (code?: number) => void;
};

export type ShutdownEntrypointOptions = {
  app: ShutdownEntrypointApp;
  process: ShutdownEntrypointProcess;
  cleanup: () => Promise<void>;
  setQuitting: () => void;
  onShutdownRequested?: () => void;
  destroyWindow: () => void;
  isInstallingUpdate?: () => boolean;
  reportFailure?: (context: 'quit' | 'signal', error: unknown) => void;
  getSignalExitCode?: () => number;
  getQuitExitCode?: () => number;
};

export function createShutdownEntrypoints({
  app,
  process,
  cleanup,
  setQuitting,
  onShutdownRequested = () => {},
  destroyWindow,
  isInstallingUpdate = () => false,
  reportFailure = () => {},
  getSignalExitCode = () => 0,
  getQuitExitCode = () => 0,
}: ShutdownEntrypointOptions): {
  runCleanup: () => Promise<void>;
  isShutdownRequested: () => boolean;
  shutdownSignal: AbortSignal;
} {
  let cleanupPromise: Promise<void> | null = null;
  let cleanupFinished = false;
  let quitAfterCleanupRequested = false;
  let shutdownRequested = false;
  let signalExitRequested = false;
  const shutdownController = new AbortController();

  const beginShutdown = (): void => {
    if (!shutdownRequested) {
      shutdownRequested = true;
      onShutdownRequested();
      shutdownController.abort();
    }
    cancelHttpShutdownWork();
  };

  const requestShutdown = (): void => {
    beginShutdown();
    setQuitting();
  };

  const runCleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      beginShutdown();
      cleanupPromise = Promise.resolve().then(cleanup);
      cleanupPromise.then(
        () => { cleanupFinished = true; },
        () => { cleanupFinished = true; },
      );
    }
    return cleanupPromise;
  };

  const quitAfterCleanup = (): void => {
    if (quitAfterCleanupRequested) return;
    quitAfterCleanupRequested = true;
    requestShutdown();
    void runCleanup().then(
      () => {
        const exitCode = getQuitExitCode();
        destroyWindow();
        if (isInstallingUpdate()) return;
        if (exitCode === 0) app.quit();
        else app.exit(exitCode);
      },
      (error) => {
        reportFailure('quit', error);
        if (!isInstallingUpdate()) {
          app.exit(1);
        }
      },
    );
  };

  app.on('before-quit', () => {
    requestShutdown();
  });

  app.on('will-quit', (event: ShutdownEvent) => {
    if (cleanupFinished) {
      destroyWindow();
      return;
    }
    event.preventDefault();
    quitAfterCleanup();
  });

  const exitAfterCleanup = (): void => {
    if (signalExitRequested) {
      void runCleanup();
      return;
    }
    signalExitRequested = true;
    requestShutdown();
    void runCleanup().then(
      () => {
        if (isInstallingUpdate()) return;
        process.exit(getSignalExitCode());
      },
      (error) => {
        reportFailure('signal', error);
        if (!isInstallingUpdate()) {
          process.exit(1);
        }
      },
    );
  };

  process.on('SIGTERM', exitAfterCleanup);
  process.on('SIGINT', exitAfterCleanup);

  return { runCleanup, isShutdownRequested: () => shutdownRequested, shutdownSignal: shutdownController.signal };
}

export function createExitCodeAwareShutdown(
  cleanup: () => Promise<number>,
  options: {
    onShutdownRequested?: () => void;
    onFatalTimeout?: (error: unknown) => void;
  } = {},
): (exitCode?: number) => Promise<number> {
  let shutdownPromise: Promise<number> | null = null;
  let requestedExitCode = 0;

  return (exitCode = 0): Promise<number> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (!shutdownPromise) {
      options.onShutdownRequested?.();
      cancelHttpShutdownWork();
      shutdownPromise = (async () => {
        try {
          const cleanupExitCode = await cleanup();
          return Math.max(cleanupExitCode, requestedExitCode);
        } catch (error) {
          if (isShutdownTimeout(error)) options.onFatalTimeout?.(error);
          throw error;
        }
      })();
    }
    return shutdownPromise;
  };
}
