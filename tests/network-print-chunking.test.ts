import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import { printViaNetwork, NETWORK_PRINT_CHUNK_SIZE, NETWORK_PRINT_CHUNK_DELAY_MS } from "../main/printers/thermal";

class MockSocket extends EventEmitter {
  public writtenChunks: Buffer[] = [];
  public destroyed = false;
  public ended = false;
  public timeoutMs = 0;
  public timeoutCb?: () => void;
  public simulateBackpressure = false;

  connect(port: number, host: string, cb?: () => void): this {
    process.nextTick(() => {
      if (cb) cb();
    });
    return this;
  }

  write(chunk: Buffer, cb?: () => void): boolean {
    this.writtenChunks.push(Buffer.from(chunk));
    if (this.simulateBackpressure) {
      // Simulate socket buffer full: return false and drain later
      process.nextTick(() => {
        if (cb) cb();
        this.emit("drain");
      });
      return false;
    }
    process.nextTick(() => {
      if (cb) cb();
    });
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  setTimeout(ms: number, cb?: () => void): this {
    this.timeoutMs = ms;
    this.timeoutCb = cb;
    return this;
  }
}

async function testSmallPayloadDirectSend(): Promise<void> {
  const originalSocket = net.Socket;
  let mock: MockSocket | null = null;
  (net as any).Socket = function () {
    mock = new MockSocket();
    return mock;
  };

  try {
    const smallPayload = Buffer.from("Small receipt content under 4KB");
    const result = await printViaNetwork("192.168.1.100", 9100, smallPayload);
    assert.equal(result.ok, true);
    assert(mock);
    assert.equal(mock!.writtenChunks.length, 1);
    assert.deepEqual(mock!.writtenChunks[0], smallPayload);
    assert.equal(mock!.ended, true);
  } finally {
    (net as any).Socket = originalSocket;
  }
}

async function testLargePayloadChunkedSend(): Promise<void> {
  const originalSocket = net.Socket;
  let mock: MockSocket | null = null;
  (net as any).Socket = function () {
    mock = new MockSocket();
    return mock;
  };

  try {
    // 10KB payload (> 2 chunks of 4KB)
    const largePayload = Buffer.alloc(10 * 1024, 0xaa);
    const result = await printViaNetwork("192.168.1.100", 9100, largePayload);
    assert.equal(result.ok, true);
    assert(mock);
    assert.equal(mock!.writtenChunks.length, 3); // 4096 + 4096 + 2048
    assert.equal(mock!.writtenChunks[0].length, 4096);
    assert.equal(mock!.writtenChunks[1].length, 4096);
    assert.equal(mock!.writtenChunks[2].length, 2048);
    const reassembled = Buffer.concat(mock!.writtenChunks);
    assert.deepEqual(reassembled, largePayload);
    assert.equal(mock!.ended, true);
  } finally {
    (net as any).Socket = originalSocket;
  }
}

async function testLargePayloadWithBackpressure(): Promise<void> {
  const originalSocket = net.Socket;
  let mock: MockSocket | null = null;
  (net as any).Socket = function () {
    mock = new MockSocket();
    mock.simulateBackpressure = true;
    return mock;
  };

  try {
    const largePayload = Buffer.alloc(9000, 0xbb);
    const result = await printViaNetwork("192.168.1.100", 9100, largePayload);
    assert.equal(result.ok, true);
    assert(mock);
    assert.equal(mock!.writtenChunks.length, 3); // 4096 + 4096 + 808
    const reassembled = Buffer.concat(mock!.writtenChunks);
    assert.deepEqual(reassembled, largePayload);
    assert.equal(mock!.ended, true);
  } finally {
    (net as any).Socket = originalSocket;
  }
}

async function testAbortSignalCancelsPrint(): Promise<void> {
  const originalSocket = net.Socket;
  let mock: MockSocket | null = null;
  (net as any).Socket = function () {
    mock = new MockSocket();
    return mock;
  };

  try {
    const controller = new AbortController();
    const largePayload = Buffer.alloc(10000, 0xcc);
    setTimeout(() => controller.abort(), 2);
    const result = await printViaNetwork("192.168.1.100", 9100, largePayload, controller.signal);
    assert.equal(result.ok, false);
    assert.match(result.detail || "", /Print cancelled during shutdown/);
    assert(mock);
    assert.equal(mock!.destroyed, true);
  } finally {
    (net as any).Socket = originalSocket;
  }
}

async function testAbortBeforeDrain(): Promise<void> {
  const originalSocket = net.Socket;
  let mock: MockSocket | null = null;
  (net as any).Socket = function () {
    mock = new MockSocket();
    // Do not immediately emit drain; stay paused in backpressure
    mock.write = function (chunk: Buffer, cb?: () => void): boolean {
      this.writtenChunks.push(Buffer.from(chunk));
      if (cb) process.nextTick(cb);
      return false; // Backpressured, awaiting drain
    };
    return mock;
  };

  try {
    const controller = new AbortController();
    const largePayload = Buffer.alloc(10000, 0xdd);
    const printPromise = printViaNetwork("192.168.1.100", 9100, largePayload, controller.signal);

    // Let the first chunk write happen
    await new Promise((r) => setImmediate(r));
    assert.equal(mock!.writtenChunks.length, 1);

    // Abort before drain fires
    controller.abort();
    const result = await printPromise;
    assert.equal(result.ok, false);

    // Emitting drain after settlement must be a no-op and must not trigger another chunk write
    mock!.emit("drain");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(mock!.writtenChunks.length, 1);
  } finally {
    (net as any).Socket = originalSocket;
  }
}

async function run(): Promise<void> {
  await testSmallPayloadDirectSend();
  await testLargePayloadChunkedSend();
  await testLargePayloadWithBackpressure();
  await testAbortSignalCancelsPrint();
  await testAbortBeforeDrain();
  console.log("✓ All network print chunking tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
