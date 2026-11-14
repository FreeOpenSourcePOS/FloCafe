// Epson ESC/POS real-time status (DLE EOT n) over a TCP socket.
// Bit tables: Epson ESC/POS manual; validity rule and device-status masks
// mirror python-escpos (RT_MASK_LOWPAPER = 30, RT_MASK_NOPAPER = 114).

import * as net from 'net';
import { withNetworkPortLock } from './network-port-lock';

export type StatusQuery = 1 | 2 | 3 | 4;

/** n = 1 printer, 2 off-line cause, 3 error cause, 4 paper roll sensor. */
export const DLE_EOT: Record<StatusQuery, Buffer> = {
  1: Buffer.from([0x10, 0x04, 0x01]),
  2: Buffer.from([0x10, 0x04, 0x02]),
  3: Buffer.from([0x10, 0x04, 0x03]),
  4: Buffer.from([0x10, 0x04, 0x04]),
};

/** A real status byte has bits 7 and 0 clear and bits 4 and 1 set. */
export function isValidStatusByte(b: number): boolean {
  return (b & 0x81) === 0 && (b & 0x12) === 0x12;
}

export interface PrinterStatus {
  online: boolean;
}

/** n = 1: bit 3 set means off-line. */
export function decodePrinterStatus(b: number): PrinterStatus {
  return { online: (b & 0x08) === 0 };
}

export interface OfflineCause {
  coverOpen: boolean;
  feedByButton: boolean;
  stoppedByPaperEnd: boolean;
  error: boolean;
}

/** n = 2: bits 2 cover open, 3 fed by button, 5 stopped by paper end, 6 error. */
export function decodeOfflineCause(b: number): OfflineCause {
  return {
    coverOpen: (b & 0x04) !== 0,
    feedByButton: (b & 0x08) !== 0,
    stoppedByPaperEnd: (b & 0x20) !== 0,
    error: (b & 0x40) !== 0,
  };
}

export interface ErrorCause {
  cutterError: boolean;
  unrecoverableError: boolean;
  autoRecoverableError: boolean;
}

/** n = 3: bits 3 auto-cutter, 5 unrecoverable, 6 auto-recoverable error. */
export function decodeErrorCause(b: number): ErrorCause {
  return {
    cutterError: (b & 0x08) !== 0,
    unrecoverableError: (b & 0x20) !== 0,
    autoRecoverableError: (b & 0x40) !== 0,
  };
}

export interface PaperSensor {
  paperNearEnd: boolean;
  paperOut: boolean;
}

/** n = 4: bits 2-3 near end, bits 5-6 paper out. */
export function decodePaperSensor(b: number): PaperSensor {
  return { paperNearEnd: (b & 0x0c) === 0x0c, paperOut: (b & 0x60) === 0x60 };
}

export type PrinterError = 'recoverable' | 'unrecoverable' | 'cutter';

export interface PrinterStatusResult {
  /** TCP connect succeeded. */
  reachable: boolean;
  /** At least one valid status byte came back. */
  answered: boolean;
  online?: boolean;
  coverOpen?: boolean;
  paperOut?: boolean;
  paperNearEnd?: boolean;
  error?: PrinterError;
}

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type ReadStatusByte = (timeoutMs: number) => Promise<number | null>;

export function openSocket(
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        socket.removeListener('error', finish);
        socket.on('error', () => {});
        resolve(socket);
      }
    };
    const onAbort = () => finish(new Error('aborted'));
    const timer = setTimeout(() => finish(new Error('connect timeout')), timeoutMs);
    timer.unref?.();
    socket.once('error', finish);
    socket.once('connect', () => finish());
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }
  });
}

/** Keeps one read in flight at a time; invalid bytes are dropped, not trusted. */
function makeReader(socket: net.Socket): ReadStatusByte {
  const buffered: number[] = [];
  let waiter: ((b: number | null) => void) | null = null;

  const flush = () => {
    while (waiter && buffered.length) {
      const b = buffered.shift() as number;
      if (isValidStatusByte(b)) waiter(b);
    }
  };
  const giveUp = () => {
    if (waiter) waiter(null);
  };
  socket.on('data', (chunk: Buffer) => {
    // A status answer is one byte; a peer that streams data must not grow memory.
    for (const b of chunk) {
      if (buffered.length >= 64) buffered.shift();
      buffered.push(b);
    }
    flush();
  });
  socket.on('close', giveUp);
  socket.on('end', giveUp);

  return (timeoutMs: number) =>
    new Promise<number | null>((resolve) => {
      let done = false;
      const settle = (b: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (waiter === settle) waiter = null;
        resolve(b);
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      timer.unref?.();
      waiter = settle;
      flush();
    });
}

/** One connection, up to four status queries. Never throws. */
export async function probeNetworkPrinterStatus(
  host: string,
  port: number,
  options: ProbeOptions = {},
): Promise<PrinterStatusResult> {
  const timeoutMs = options.timeoutMs ?? 800;
  const result: PrinterStatusResult = { reachable: false, answered: false };

  try {
    return await withNetworkPortLock(
      host,
      port,
      async () => {
        let socket: net.Socket;
        try {
          socket = await openSocket(host, port, timeoutMs, options.signal);
        } catch {
          return result;
        }
        result.reachable = true;

        let socketClosed = false;
        socket.once('close', () => {
          socketClosed = true;
        });
        const onAbort = () => socket.destroy();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const readStatus = makeReader(socket);

        const ask = async (n: StatusQuery): Promise<number | null> => {
          socket.write(DLE_EOT[n]);
          const b = await readStatus(timeoutMs);
          if (b !== null) result.answered = true;
          return b;
        };

        try {
          if (options.signal?.aborted) return result;
          const printer = await ask(1);
          // A clone that ignores DLE EOT stays silent; do not wait out the other queries.
          if (printer === null) return result;
          result.online = decodePrinterStatus(printer).online;

          const cause = await ask(2);
          let errorFlag = false;
          if (cause !== null) {
            const decoded = decodeOfflineCause(cause);
            result.coverOpen = decoded.coverOpen;
            errorFlag = decoded.error;
          }

          if (errorFlag) {
            const reason = await ask(3);
            if (reason !== null) {
              const decoded = decodeErrorCause(reason);
              result.error = decoded.unrecoverableError
                ? 'unrecoverable'
                : decoded.cutterError
                  ? 'cutter'
                  : decoded.autoRecoverableError
                    ? 'recoverable'
                    : undefined;
            }
          }

          const paper = await ask(4);
          if (paper !== null) {
            const decoded = decodePaperSensor(paper);
            result.paperNearEnd = decoded.paperNearEnd;
            result.paperOut = decoded.paperOut;
          }
        } catch {
          // The printer dropped the connection mid-way; report what we already have.
        } finally {
          options.signal?.removeEventListener('abort', onAbort);
          await new Promise<void>((resolve) => {
            if (socketClosed || socket.destroyed) {
              socket.destroy();
              resolve();
              return;
            }
            const done = () => {
              clearTimeout(closeTimer);
              resolve();
            };
            const closeTimer = setTimeout(done, 100);
            closeTimer.unref?.();
            socket.once('close', done);
            socket.destroy();
          });
        }
        return result;
      },
      options.signal,
    );
  } catch {
    return result;
  }
}

export type PrinterFailureCause =
  | 'paper_out'
  | 'cover_open'
  | 'printer_error'
  | 'offline'
  | 'unreachable';

/** One cause for the UI, worst first. null means no detected fault. */
export function statusToFailureCause(result: PrinterStatusResult): PrinterFailureCause | null {
  if (!result.reachable) return 'unreachable';
  if (result.paperOut) return 'paper_out';
  if (result.coverOpen) return 'cover_open';
  if (result.error) return 'printer_error';
  if (result.online === false) return 'offline';
  return null;
}
