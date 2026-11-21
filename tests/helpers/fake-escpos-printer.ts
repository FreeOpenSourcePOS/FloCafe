// Loopback ESC/POS status printer for tests: answers DLE EOT n from a simulated
// printer state. Reply table from CrossEscPosEmulator (MIT), StatusByteBuilder.cs.
import * as net from 'net';

export type FakePaperState = 'ok' | 'near_end' | 'out';
export type FakeErrorState = 'none' | 'recoverable' | 'unrecoverable';

export interface FakePrinterState {
  online?: boolean;
  coverOpen?: boolean;
  paper?: FakePaperState;
  error?: FakeErrorState;
}

export interface FakeEscposPrinterOptions {
  state?: FakePrinterState;
  /** Accept connections but never answer. */
  silent?: boolean;
  /** Answer with a byte that fails the validity rule. */
  garbage?: boolean;
  /** Reject any second concurrent connection, like budget W5500/lwIP port-9100 printers. */
  singleConnection?: boolean;
}

export interface FakeEscposPrinter {
  port: number;
  /** Every byte received, in order. */
  received: number[];
  /** Bytes kept because the printer was ready (offline, cover open or paper out drops them). */
  printed: number[];
  connections: number;
  openConnections: number;
  maxConcurrentConnections: number;
  rejectedConnections: number;
  close(): Promise<void>;
}

const DLE = 0x10;
const EOT = 0x04;
const BASE = 0x12;

function buildReplies(state: FakePrinterState): Record<number, number> {
  const online = state.online ?? true;
  const coverOpen = state.coverOpen ?? false;
  const paper = state.paper ?? 'ok';
  const error = state.error ?? 'none';
  return {
    1: BASE | (online ? 0 : 0x08),
    2: BASE | (coverOpen ? 0x04 : 0) | (paper === 'out' ? 0x20 : 0) | (error !== 'none' ? 0x40 : 0),
    3: BASE | (error === 'unrecoverable' ? 0x20 : error === 'recoverable' ? 0x40 : 0),
    4: BASE | (paper === 'out' ? 0x0c | 0x60 : paper === 'near_end' ? 0x0c : 0),
  };
}

export function start(options: FakeEscposPrinterOptions = {}): Promise<FakeEscposPrinter> {
  const state = options.state ?? {};
  const replies = buildReplies(state);
  const ready =
    (state.online ?? true) && !(state.coverOpen ?? false) && (state.paper ?? 'ok') !== 'out';
  const received: number[] = [];
  const printed: number[] = [];
  const sockets = new Set<net.Socket>();
  let connections = 0;
  let maxConcurrentConnections = 0;
  let rejectedConnections = 0;

  const server = net.createServer((socket) => {
    if (options.singleConnection && sockets.size >= 1) {
      rejectedConnections++;
      socket.destroy();
      return;
    }
    connections++;
    sockets.add(socket);
    if (sockets.size > maxConcurrentConnections) {
      maxConcurrentConnections = sockets.size;
    }
    const removeSocket = () => sockets.delete(socket);
    socket.once('end', removeSocket);
    socket.once('close', removeSocket);
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      for (const byte of chunk) received.push(byte);
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        if (buffer[0] === DLE && buffer[1] === EOT && buffer.length >= 3) {
          const n = buffer[2];
          buffer = buffer.subarray(3);
          if (!options.silent) {
            socket.write(Buffer.from([options.garbage ? 0xff : (replies[n] ?? BASE)]));
          }
          continue;
        }
        // A DLE or DLE EOT split across TCP reads waits for the rest of the command.
        if (buffer[0] === DLE && buffer.length < 3 && (buffer.length === 1 || buffer[1] === EOT))
          break;
        const byte = buffer[0];
        buffer = buffer.subarray(1);
        if (!options.silent && ready) printed.push(byte);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        get received() {
          return received;
        },
        get printed() {
          return printed;
        },
        get connections() {
          return connections;
        },
        get openConnections() {
          return sockets.size;
        },
        get maxConcurrentConnections() {
          return maxConcurrentConnections;
        },
        get rejectedConnections() {
          return rejectedConnections;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
