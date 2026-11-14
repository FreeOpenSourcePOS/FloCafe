/**
 * Unit and loopback tests for main/printers/escpos-status.ts (DLE EOT n).
 * Run: npm run test:escpos-status
 */

import * as net from 'net';

import {
  DLE_EOT,
  decodeErrorCause,
  decodeOfflineCause,
  decodePaperSensor,
  decodePrinterStatus,
  isValidStatusByte,
  probeNetworkPrinterStatus,
  statusToFailureCause,
} from '../main/printers/escpos-status';
import { printViaNetwork } from '../main/printers/thermal';
import { start } from './helpers/fake-escpos-printer';

const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

function testRequestBytesAndValidity() {
  assertEqualOrThrow(DLE_EOT[1].toString('hex'), '100401', 'n=1 request is DLE EOT 1');
  assertEqualOrThrow(DLE_EOT[2].toString('hex'), '100402', 'n=2 request is DLE EOT 2');
  assertEqualOrThrow(DLE_EOT[3].toString('hex'), '100403', 'n=3 request is DLE EOT 3');
  assertEqualOrThrow(DLE_EOT[4].toString('hex'), '100404', 'n=4 request is DLE EOT 4');

  assertOrThrow(isValidStatusByte(0x16), 'n=1 online byte 0x16 is valid');
  assertOrThrow(isValidStatusByte(0x12), 'paper ok byte 0x12 is valid');
  assertOrThrow(!isValidStatusByte(0x00), '0x00 fails the validity rule');
  assertOrThrow(!isValidStatusByte(0x96), 'bit 7 set fails the validity rule');
  assertOrThrow(!isValidStatusByte(0x13), 'bit 0 set fails the validity rule');
  assertOrThrow(!isValidStatusByte(0x14), 'bit 1 clear fails the validity rule');
}

function testDecoders() {
  const online = decodePrinterStatus(0x16);
  assertOrThrow(online.online, 'n=1 0x16 means online');
  assertOrThrow(decodePrinterStatus(0x12).online, 'n=1 0x12 means online');
  const offline = decodePrinterStatus(0x1e);
  assertOrThrow(!offline.online, 'n=1 0x1e means offline');

  const cover = decodeOfflineCause(0x16);
  assertOrThrow(cover.coverOpen, 'n=2 0x16 means cover open');
  assertOrThrow(!cover.error, 'n=2 0x16 has no error bit');
  const stopped = decodeOfflineCause(0x32);
  assertOrThrow(stopped.stoppedByPaperEnd, 'n=2 0x32 means stopped by paper end');
  assertOrThrow(!stopped.coverOpen, 'n=2 0x32 has no cover bit');
  const errorCause = decodeOfflineCause(0x52);
  assertOrThrow(errorCause.error, 'n=2 0x52 sets the error bit');

  assertOrThrow(!decodeErrorCause(0x12).unrecoverableError, 'n=3 0x12 has no error');
  assertOrThrow(decodeErrorCause(0x1a).cutterError, 'n=3 0x1a is a cutter error');
  assertOrThrow(decodeErrorCause(0x32).unrecoverableError, 'n=3 0x32 is unrecoverable');
  assertOrThrow(decodeErrorCause(0x52).autoRecoverableError, 'n=3 0x52 is auto-recoverable');

  const ok = decodePaperSensor(0x12);
  assertOrThrow(!ok.paperOut && !ok.paperNearEnd, 'n=4 0x12 is paper ok');
  const nearEnd = decodePaperSensor(0x1e);
  assertOrThrow(nearEnd.paperNearEnd && !nearEnd.paperOut, 'n=4 0x1e is near end');
  const out = decodePaperSensor(0x72);
  assertOrThrow(out.paperOut, 'n=4 0x72 is paper out');
  const outEmulator = decodePaperSensor(0x7e);
  assertOrThrow(outEmulator.paperOut, 'n=4 0x7e is paper out (near end and out together)');
  assertOrThrow(outEmulator.paperNearEnd, 'n=4 0x7e also reports near end');
}

async function testProbeOnline() {
  const printer = await start({ state: {} });
  try {
    const result = await probeNetworkPrinterStatus('127.0.0.1', printer.port);
    assertOrThrow(result.reachable, 'online printer: reachable');
    assertOrThrow(result.answered, 'online printer: answered');
    assertEqualOrThrow(result.online, true, 'online printer: online');
    assertOrThrow(
      !result.paperOut && !result.coverOpen && !result.error,
      'online printer: no fault',
    );
    assertEqualOrThrow(statusToFailureCause(result), null, 'online printer: no failure cause');
    assertEqualOrThrow(printer.connections, 1, 'online printer: one TCP connection');
    assertEqualOrThrow(
      printer.received.slice(0, 3).join(','),
      '16,4,1',
      'online printer: received DLE EOT 1',
    );
    assertOrThrow(!printer.received.includes(3), 'no error query when n=2 reports no error');
  } finally {
    await printer.close();
  }
}

async function testProbePaperOut() {
  const printer = await start({ state: { paper: 'out' } });
  try {
    const result = await probeNetworkPrinterStatus('127.0.0.1', printer.port);
    assertEqualOrThrow(result.paperOut, true, 'paper out: paperOut');
    assertEqualOrThrow(result.paperNearEnd, true, 'paper out: near end also reported');
    assertEqualOrThrow(statusToFailureCause(result), 'paper_out', 'paper out: failure cause');
  } finally {
    await printer.close();
  }
}

async function testProbePaperNearEnd() {
  const printer = await start({ state: { paper: 'near_end' } });
  try {
    const result = await probeNetworkPrinterStatus('127.0.0.1', printer.port);
    assertEqualOrThrow(result.paperNearEnd, true, 'near end: paperNearEnd');
    assertEqualOrThrow(result.paperOut, false, 'near end: not paper out');
    assertEqualOrThrow(statusToFailureCause(result), null, 'near end: no failure cause yet');
  } finally {
    await printer.close();
  }
}

async function testProbeCoverOpen() {
  const printer = await start({ state: { coverOpen: true } });
  try {
    const result = await probeNetworkPrinterStatus('127.0.0.1', printer.port);
    assertEqualOrThrow(result.coverOpen, true, 'cover open: coverOpen');
    assertEqualOrThrow(statusToFailureCause(result), 'cover_open', 'cover open: failure cause');
  } finally {
    await printer.close();
  }
}

async function testProbePrinterError() {
  const printer = await start({ state: { error: 'unrecoverable' } });
  try {
    const result = await probeNetworkPrinterStatus('127.0.0.1', printer.port);
    assertEqualOrThrow(result.error, 'unrecoverable', 'printer error: unrecoverable');
    assertEqualOrThrow(statusToFailureCause(result), 'printer_error', 'printer error: cause');
    const queries = printer.received.filter((_, i) => i % 3 === 2);
    assertEqualOrThrow(queries.join(','), '1,2,3,4', 'printer error: n=3 queried after n=2 error');
  } finally {
    await printer.close();
  }
}

async function testProbeOffline() {
  const printer = await start({ state: { online: false } });
  try {
    const result = await probeNetworkPrinterStatus('127.0.0.1', printer.port);
    assertEqualOrThrow(result.online, false, 'offline: online false');
    assertEqualOrThrow(statusToFailureCause(result), 'offline', 'offline: failure cause');
  } finally {
    await printer.close();
  }
}

async function testPrintBytesKeptOnlyWhenReady() {
  const ready = await start({ state: {} });
  const blocked = await start({ state: { paper: 'out' } });
  try {
    await new Promise<void>((resolve) =>
      net
        .connect(ready.port, '127.0.0.1')
        .on('connect', function (this: net.Socket) {
          this.end('AB');
        })
        .on('close', () => resolve()),
    );
    await new Promise<void>((resolve) =>
      net
        .connect(blocked.port, '127.0.0.1')
        .on('connect', function (this: net.Socket) {
          this.end('AB');
        })
        .on('close', () => resolve()),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEqualOrThrow(ready.printed.join(','), '65,66', 'ready printer keeps print bytes');
    assertEqualOrThrow(blocked.printed.length, 0, 'paper-out printer drops print bytes');
    assertEqualOrThrow(
      blocked.received.join(','),
      '65,66',
      'paper-out printer still received them',
    );
  } finally {
    await ready.close();
    await blocked.close();
  }
}

async function testSplitStatusCommand() {
  const printer = await start({ state: {} });
  try {
    const reply = await new Promise<number[]>((resolve, reject) => {
      const socket = net.connect(printer.port, '127.0.0.1', async () => {
        for (const part of [[0x10], [0x04], [0x01]]) {
          socket.write(Buffer.from(part));
          await new Promise((wait) => setTimeout(wait, 20));
        }
      });
      socket.once('data', (data) => {
        socket.destroy();
        resolve([...data]);
      });
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        resolve([]);
      }, 500);
    });
    assertEqualOrThrow(reply.length, 1, 'DLE EOT n split across 3 reads still gets one reply');
    assertEqualOrThrow(printer.printed.length, 0, 'the split command is not printed');
  } finally {
    await printer.close();
  }
}

async function testProbeSilentPrinter() {
  const printer = await start({ silent: true });
  try {
    const startedAt = Date.now();
    const result = await probeNetworkPrinterStatus('127.0.0.1', printer.port, { timeoutMs: 100 });
    const elapsed = Date.now() - startedAt;
    assertOrThrow(result.reachable, 'silent clone: reachable');
    assertEqualOrThrow(result.answered, false, 'silent clone: answered false');
    assertOrThrow(elapsed < 2000, `silent clone: gave up in time (${elapsed}ms)`);
    assertEqualOrThrow(statusToFailureCause(result), null, 'silent clone: no fault reported');
  } finally {
    await printer.close();
  }
}

async function testProbeGarbageReply() {
  const printer = await start({ garbage: true });
  try {
    const result = await probeNetworkPrinterStatus('127.0.0.1', printer.port, { timeoutMs: 100 });
    assertOrThrow(result.reachable, 'garbage reply: reachable');
    assertEqualOrThrow(result.answered, false, 'garbage reply: invalid byte ignored');
    assertEqualOrThrow(result.paperOut, undefined, 'garbage reply: nothing decoded');
  } finally {
    await printer.close();
  }
}

async function testProbeConnectionRefused() {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const result = await probeNetworkPrinterStatus('127.0.0.1', port, { timeoutMs: 300 });
  assertEqualOrThrow(result.reachable, false, 'connection refused: not reachable');
  assertEqualOrThrow(result.answered, false, 'connection refused: not answered');
  assertEqualOrThrow(statusToFailureCause(result), 'unreachable', 'connection refused: cause');
}

async function testSocketClosedAfterProbe() {
  let closed = false;
  const server = net.createServer((socket) => {
    socket.on('close', () => {
      closed = true;
    });
    socket.on('error', () => {});
    socket.on('data', () => socket.write(Buffer.from([0x12])));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const result = await probeNetworkPrinterStatus('127.0.0.1', port);
    assertOrThrow(result.answered, 'socket closed: probe answered');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertOrThrow(closed, 'socket closed: client closed its TCP connection');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testConcurrentPrintAndProbeSerialized() {
  const printer = await start({ state: {}, singleConnection: true });
  try {
    // 10KB payload forces multi-chunk transmission (>4096 bytes) with 10ms delays between chunks.
    const payload = Buffer.alloc(10000, 0x41);
    const printPromise = printViaNetwork('127.0.0.1', printer.port, payload);
    // Start a concurrent status probe while printViaNetwork is mid-chunk.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const probePromise = probeNetworkPrinterStatus('127.0.0.1', printer.port, { timeoutMs: 800 });

    const [printResult, probeResult] = await Promise.all([printPromise, probePromise]);
    assertEqualOrThrow(printResult.ok, true, 'concurrent multi-chunk print succeeds');
    assertEqualOrThrow(
      probeResult.reachable,
      true,
      'concurrent probe is serialized and stays reachable',
    );
    assertEqualOrThrow(probeResult.answered, true, 'concurrent probe receives status reply');
    assertEqualOrThrow(
      statusToFailureCause(probeResult),
      null,
      'concurrent probe never reports false unreachable',
    );
    assertEqualOrThrow(
      printer.rejectedConnections,
      0,
      'single-connection printer never saw a concurrent second socket',
    );
    assertEqualOrThrow(
      printer.maxConcurrentConnections,
      1,
      'print and probe never opened concurrent connections',
    );
    assertEqualOrThrow(
      printer.printed.length,
      payload.length,
      'all multi-chunk receipt bytes were printed intact',
    );
    // Verify 0x10 0x04 was never interleaved inside the 0x41 payload run.
    const receivedBuf = Buffer.from(printer.received);
    const firstPayloadIdx = receivedBuf.indexOf(0x41);
    const lastPayloadIdx = receivedBuf.lastIndexOf(0x41);
    const payloadSlice = receivedBuf.subarray(firstPayloadIdx, lastPayloadIdx + 1);
    assertEqualOrThrow(
      payloadSlice.includes(Buffer.from([0x10, 0x04])),
      false,
      'DLE EOT bytes never interleaved inside multi-chunk receipt payload',
    );
  } finally {
    await printer.close();
  }
}

async function testPrintWaitsForSocketCloseBeforeResolving() {
  const printer = await start({ state: {}, singleConnection: true });
  try {
    const payload = Buffer.from('RECEIPT_TEST_CLOSE\n');
    const result = await printViaNetwork('127.0.0.1', printer.port, payload);
    assertEqualOrThrow(result.ok, true, 'print succeeds');
    const probe = await probeNetworkPrinterStatus('127.0.0.1', printer.port, { timeoutMs: 500 });
    assertEqualOrThrow(
      probe.reachable,
      true,
      'immediate post-print probe finds socket already closed and port free',
    );
    assertEqualOrThrow(
      printer.rejectedConnections,
      0,
      'immediate post-print probe never hits single-connection refusal',
    );
  } finally {
    await printer.close();
  }
}

async function main() {
  testRequestBytesAndValidity();
  testDecoders();
  await testProbeOnline();
  await testProbePaperOut();
  await testProbePaperNearEnd();
  await testProbeCoverOpen();
  await testProbePrinterError();
  await testProbeOffline();
  await testPrintBytesKeptOnlyWhenReady();
  await testProbeSilentPrinter();
  await testSplitStatusCommand();
  await testProbeGarbageReply();
  await testProbeConnectionRefused();
  await testSocketClosedAfterProbe();
  await testConcurrentPrintAndProbeSerialized();
  await testPrintWaitsForSocketCloseBeforeResolving();
  console.log('✓ All ESC/POS status tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
