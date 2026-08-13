export type StandaloneStartupOptions = {
  initializeDatabase: () => void | Promise<void>;
  prepare?: () => void | Promise<void>;
  startServer: () => Promise<void>;
  startKdsServer: () => Promise<void>;
  startServerApp?: () => Promise<void>;
  isShutdownRequested: () => boolean;
};

function throwIfShutdownRequested(isShutdownRequested: () => boolean): void {
  if (isShutdownRequested()) throw new Error('Standalone server startup cancelled during shutdown');
}

export async function startStandaloneServers({
  initializeDatabase,
  prepare,
  startServer,
  startKdsServer,
  startServerApp,
  isShutdownRequested,
}: StandaloneStartupOptions): Promise<void> {
  throwIfShutdownRequested(isShutdownRequested);
  await initializeDatabase();
  throwIfShutdownRequested(isShutdownRequested);
  await prepare?.();
  throwIfShutdownRequested(isShutdownRequested);
  await startServer();
  throwIfShutdownRequested(isShutdownRequested);
  await startKdsServer();
  throwIfShutdownRequested(isShutdownRequested);
  await startServerApp?.();
  throwIfShutdownRequested(isShutdownRequested);
}
