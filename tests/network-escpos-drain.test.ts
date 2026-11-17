/**
 * Behavioral loopback tests for ESC/POS TCP drain handshake in printViaNetwork().
 * Run: npm run test:network-escpos-drain
 */

import * as net from 'net';

import {
  DLE_EOT,
  probeNetworkPrinterStatus,
  statusToFailureCause,
} from '../main/printers/escpos-status';
import {
  NETWORK_PRINT_CHUNK_SIZE,
  NETWORK_PRINT_DRAIN_TIMEOUT_MS,
  printViaNetwork,
} from '../main/printers/thermal';

const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const GS_V_PARTIAL = Buffer.from([0x1d, 0x56, 0x42, 0x00]);
const GS_V_FULL = Buffer.from([0x1d, 0x56, 0x41, 0x00]);

interface DrainServerOptions {
  expectedPayloadBytes: number;
  replyDelayMs?: number;
  replyByte?: number;
  silent?: boolean;
  endImmediatelyAfterPayload?: boolean;
  singleConnection?: boolean;
  destroyAfterBytes?: number;
}

interface DrainServerHandle {
  port: number;
  connections: number;
  rejectedConnections: number;
  maxConcurrentConnections: number;
  receivedByConnection: Buffer[];
  finBeforeReplyOnPrint: boolean;
  clientEnded: Promise<void>;
  close(): Promise<void>;
}

async function startDrainTestServer(options: DrainServerOptions): Promise<DrainServerHandle> {
  const sockets = new Set<net.Socket>();
  const receivedByConnection: Buffer[] = [];
  let connections = 0;
  let rejectedConnections = 0;
  let maxConcurrentConnections = 0;
  let finBeforeReplyOnPrint = false;
  let resolveFirstEnd!: () => void;
  const clientEnded = new Promise<void>((resolve) => {
    resolveFirstEnd = resolve;
  });

  const server = net.createServer((socket) => {
    if (options.singleConnection && sockets.size >= 1) {
      rejectedConnections++;
      socket.destroy();
      return;
    }

    const connIdx = connections++;
    sockets.add(socket);
    if (sockets.size > maxConcurrentConnections) {
      maxConcurrentConnections = sockets.size;
    }

    let chunks: Buffer[] = [];
    let totalBytes = 0;
    let replied = false;
    let ended = false;
    let destroyedEarly = false;

    const cleanup = () => sockets.delete(socket);
    socket.once('close', cleanup);
    socket.on('error', () => {});

    socket.on('end', () => {
      if (connIdx === 0 && !replied) {
        finBeforeReplyOnPrint = true;
      }
      if (connIdx === 0) resolveFirstEnd();
    });

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      receivedByConnection[connIdx] = Buffer.concat(chunks);

      if (
        connIdx === 0 &&
        !destroyedEarly &&
        options.destroyAfterBytes !== undefined &&
        totalBytes >= options.destroyAfterBytes
      ) {
        destroyedEarly = true;
        socket.destroy();
        return;
      }

      if (connIdx > 0) {
        // Subsequent connections in serialization test act as a normal DLE EOT status responder.
        const buf = receivedByConnection[connIdx];
        if (buf.length >= 3 && buf[buf.length - 3] === 0x10 && buf[buf.length - 2] === 0x04) {
          socket.write(Buffer.from([0x12]));
        }
        return;
      }

      if (
        options.endImmediatelyAfterPayload &&
        !ended &&
        totalBytes >= options.expectedPayloadBytes
      ) {
        ended = true;
        socket.end();
        return;
      }

      if (options.silent) return;

      const full = receivedByConnection[connIdx];
      const expectedWithDrain = options.expectedPayloadBytes + DLE_EOT[1].length;
      if (!replied && full.length >= expectedWithDrain) {
        const delayMs = options.replyDelayMs ?? 0;
        const reply = Buffer.from([options.replyByte ?? 0x12]);
        const sendReply = () => {
          if (socket.destroyed || replied) return;
          replied = true;
          socket.write(reply);
        };
        if (delayMs > 0) {
          setTimeout(sendReply, delayMs);
        } else {
          sendReply();
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    get connections() {
      return connections;
    },
    get rejectedConnections() {
      return rejectedConnections;
    },
    get maxConcurrentConnections() {
      return maxConcurrentConnections;
    },
    receivedByConnection,
    get finBeforeReplyOnPrint() {
      return finBeforeReplyOnPrint;
    },
    clientEnded,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

async function testSinglePassSlowMcuHoldsSocketUntilStatusReply(): Promise<void> {
  const payload = Buffer.concat([Buffer.from('RECEIPT_LINE_1\nRECEIPT_TAIL\n'), GS_V_PARTIAL]);
  assertOrThrow(payload.length <= NETWORK_PRINT_CHUNK_SIZE, 'single-pass payload <= 4KB');

  const server = await startDrainTestServer({
    expectedPayloadBytes: payload.length,
    replyDelayMs: 60,
    replyByte: 0x12,
  });

  try {
    const startedAt = Date.now();
    const result = await printViaNetwork('127.0.0.1', server.port, payload);
    const elapsed = Date.now() - startedAt;

    assertEqualOrThrow(result.ok, true, 'single-pass slow MCU print succeeds');
    assertEqualOrThrow(
      server.finBeforeReplyOnPrint,
      false,
      'single-pass job keeps socket open until printer sends DLE EOT 1 reply',
    );
    assertOrThrow(
      elapsed >= 50 && elapsed < 350,
      `single-pass job resolves promptly after reply (${elapsed}ms)`,
    );

    await server.clientEnded;
    const received = server.receivedByConnection[0];
    assertEqualOrThrow(
      received.length,
      payload.length + DLE_EOT[1].length,
      'single-pass received payload plus DLE EOT 1',
    );
    assertOrThrow(
      received.subarray(0, payload.length).equals(payload),
      'single-pass receipt and trailing GS V 66 cutter bytes arrived intact',
    );
    assertOrThrow(
      received.subarray(payload.length).equals(DLE_EOT[1]),
      'single-pass DLE EOT 1 follows trailing cutter bytes',
    );
  } finally {
    await server.close();
  }
}

async function testMultiChunkSlowMcuHoldsSocketUntilStatusReply(): Promise<void> {
  const body = Buffer.alloc(10 * 1024, 0x41);
  const payload = Buffer.concat([body, GS_V_FULL]);
  assertOrThrow(payload.length > NETWORK_PRINT_CHUNK_SIZE, 'multi-chunk payload > 4KB');

  const server = await startDrainTestServer({
    expectedPayloadBytes: payload.length,
    replyDelayMs: 60,
    replyByte: 0x16,
  });

  try {
    const startedAt = Date.now();
    const result = await printViaNetwork('127.0.0.1', server.port, payload);
    const elapsed = Date.now() - startedAt;

    assertEqualOrThrow(result.ok, true, 'multi-chunk slow MCU print succeeds');
    assertEqualOrThrow(
      server.finBeforeReplyOnPrint,
      false,
      'multi-chunk job keeps socket open until printer sends DLE EOT 1 reply',
    );
    assertOrThrow(
      elapsed >= 50 && elapsed < 450,
      `multi-chunk job resolves promptly after reply (${elapsed}ms)`,
    );

    await server.clientEnded;
    const received = server.receivedByConnection[0];
    assertEqualOrThrow(
      received.length,
      payload.length + DLE_EOT[1].length,
      'multi-chunk received full payload plus DLE EOT 1',
    );
    assertOrThrow(
      received.subarray(0, payload.length).equals(payload),
      'multi-chunk payload and trailing GS V 65 cutter bytes arrived intact without interleaving',
    );
    assertOrThrow(
      received.subarray(payload.length).equals(DLE_EOT[1]),
      'multi-chunk DLE EOT 1 follows trailing cutter bytes',
    );
  } finally {
    await server.close();
  }
}

async function testSilentPrinterCompletesWithinBoundedTimeout(): Promise<void> {
  const payload = Buffer.concat([Buffer.from('SILENT_PRINTER_RECEIPT\n'), GS_V_PARTIAL]);
  const server = await startDrainTestServer({
    expectedPayloadBytes: payload.length,
    silent: true,
  });

  try {
    const startedAt = Date.now();
    const result = await printViaNetwork('127.0.0.1', server.port, payload);
    const elapsed = Date.now() - startedAt;

    assertEqualOrThrow(result.ok, true, 'silent printer still succeeds');
    assertOrThrow(
      elapsed >= NETWORK_PRINT_DRAIN_TIMEOUT_MS - 50 && elapsed < 2000,
      `silent printer completes within bounded ~${NETWORK_PRINT_DRAIN_TIMEOUT_MS}ms drain window (${elapsed}ms)`,
    );

    await server.clientEnded;
    const received = server.receivedByConnection[0];
    assertOrThrow(
      received.subarray(0, payload.length).equals(payload),
      'silent printer received full payload and cutter bytes',
    );
    assertOrThrow(
      received.subarray(payload.length).equals(DLE_EOT[1]),
      'silent printer received trailing DLE EOT 1 before FIN',
    );
  } finally {
    await server.close();
  }
}

async function testPrematureServerEndAfterPayloadResolvesCleanly(): Promise<void> {
  const payload = Buffer.concat([Buffer.from('EARLY_CLOSE_RECEIPT\n'), GS_V_PARTIAL]);
  const server = await startDrainTestServer({
    expectedPayloadBytes: payload.length,
    endImmediatelyAfterPayload: true,
  });

  try {
    const startedAt = Date.now();
    const result = await printViaNetwork('127.0.0.1', server.port, payload);
    const elapsed = Date.now() - startedAt;

    assertEqualOrThrow(result.ok, true, 'premature peer end after payload resolves ok: true');
    assertOrThrow(
      elapsed < 350,
      `premature peer end resolves cleanly without waiting for drain timeout (${elapsed}ms)`,
    );
  } finally {
    await server.close();
  }
}

async function testFailureAndAbortPreserved(): Promise<void> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const closedPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const refusedResult = await printViaNetwork('127.0.0.1', closedPort, Buffer.from('REFUSED\n'));
  assertEqualOrThrow(refusedResult.ok, false, 'connection refused still fails');

  // Server that resets the socket mid-payload (before drain phase) must still report failure.
  const largePayload = Buffer.alloc(9000, 0x42);
  const resetServer = await startDrainTestServer({
    expectedPayloadBytes: largePayload.length,
    destroyAfterBytes: 100,
  });
  try {
    const resetResult = await printViaNetwork('127.0.0.1', resetServer.port, largePayload);
    assertEqualOrThrow(resetResult.ok, false, 'mid-payload socket reset still fails');
  } finally {
    await resetServer.close();
  }

  // Abort during drain wait must cancel promptly without waiting for NETWORK_PRINT_DRAIN_TIMEOUT_MS.
  const silentPayload = Buffer.from('ABORT_DURING_DRAIN\n');
  const silentServer = await startDrainTestServer({
    expectedPayloadBytes: silentPayload.length,
    silent: true,
  });
  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 30);
    const abortResult = await printViaNetwork(
      '127.0.0.1',
      silentServer.port,
      silentPayload,
      controller.signal,
    );
    const elapsed = Date.now() - startedAt;
    assertEqualOrThrow(abortResult.ok, false, 'abort during drain wait returns ok: false');
    assertOrThrow(
      String(abortResult.detail || '').includes('Print cancelled during shutdown'),
      'abort during drain wait preserves shutdown cancellation detail',
    );
    assertOrThrow(elapsed < 300, `abort during drain cancels immediately (${elapsed}ms)`);
  } finally {
    await silentServer.close();
  }
}

async function testConcurrentProbeSerializedDuringDrainWait(): Promise<void> {
  const payload = Buffer.concat([Buffer.alloc(10 * 1024, 0x41), GS_V_PARTIAL]);
  const server = await startDrainTestServer({
    expectedPayloadBytes: payload.length,
    replyDelayMs: 80,
    replyByte: 0x12,
    singleConnection: true,
  });

  try {
    const printPromise = printViaNetwork('127.0.0.1', server.port, payload);
    // Start status probe while print is mid-chunk / draining so it exercises withNetworkPortLock.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const probePromise = probeNetworkPrinterStatus('127.0.0.1', server.port, { timeoutMs: 800 });

    const [printResult, probeResult] = await Promise.all([printPromise, probePromise]);

    assertEqualOrThrow(printResult.ok, true, 'serialized multi-chunk drain print succeeds');
    assertEqualOrThrow(probeResult.reachable, true, 'serialized post-drain probe is reachable');
    assertEqualOrThrow(probeResult.answered, true, 'serialized post-drain probe receives status');
    assertEqualOrThrow(
      statusToFailureCause(probeResult),
      null,
      'serialized post-drain probe reports no false fault',
    );
    assertEqualOrThrow(
      server.rejectedConnections,
      0,
      'single-connection printer never saw overlapping connections during drain',
    );
    assertEqualOrThrow(
      server.maxConcurrentConnections,
      1,
      'print drain and status probe never overlapped concurrently',
    );
    assertEqualOrThrow(
      server.connections,
      2,
      'print drain and status probe ran on two sequential connections',
    );
    assertOrThrow(
      server.receivedByConnection[0].subarray(0, payload.length).equals(payload),
      'print payload and cutter bytes stayed isolated on connection 0',
    );
    assertOrThrow(
      server.receivedByConnection[0].subarray(payload.length).equals(DLE_EOT[1]),
      'drain DLE EOT 1 stayed on connection 0',
    );
  } finally {
    await server.close();
  }
}

async function main(): Promise<void> {
  await testSinglePassSlowMcuHoldsSocketUntilStatusReply();
  await testMultiChunkSlowMcuHoldsSocketUntilStatusReply();
  await testSilentPrinterCompletesWithinBoundedTimeout();
  await testPrematureServerEndAfterPayloadResolvesCleanly();
  await testFailureAndAbortPreserved();
  await testConcurrentProbeSerializedDuringDrainWait();
  console.log('✓ All network ESC/POS drain tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
