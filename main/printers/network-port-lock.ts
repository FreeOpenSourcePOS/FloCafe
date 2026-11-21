// Per-endpoint FIFO mutex for raw TCP printer connections (print jobs, status probes, and discovery).

const endpointChains = new Map<string, Promise<void>>();

export function pendingNetworkEndpointCount(): number {
  return endpointChains.size;
}

export function normalizeNetworkHost(host: string): string {
  const trimmed = host.trim();
  const unwrapped =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1).trim() : trimmed;
  return unwrapped.toLowerCase();
}

export function networkEndpointKey(host: string, port: number): string {
  return `${normalizeNetworkHost(host)}:${port}`;
}

/**
 * Serializes network printer operations targeting the same host:port in FIFO order.
 * If `signal` aborts while waiting in the queue, `fn` is skipped without stalling later waiters.
 */
export async function withNetworkPortLock<T>(
  host: string,
  port: number,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new Error('aborted');
  }

  const key = networkEndpointKey(host, port);
  const prev = endpointChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  let prevSettled = false;
  const tail = prev.then(() => {
    prevSettled = true;
    return current;
  });
  endpointChains.set(key, tail);

  try {
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        prev.then(
          () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
          () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
        );
      });
    } else {
      await prev;
    }

    return await fn();
  } finally {
    release();
    if (prevSettled) {
      if (endpointChains.get(key) === tail) {
        endpointChains.delete(key);
      }
    } else {
      void tail.then(() => {
        if (endpointChains.get(key) === tail) {
          endpointChains.delete(key);
        }
      });
    }
  }
}
