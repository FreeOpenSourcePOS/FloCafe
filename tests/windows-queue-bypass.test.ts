/**
 * Windows queue bypass: a refusal that happens before spooling may print once
 * straight to the queue's TCP/IP port, and only for those refusals.
 */
import {
  canBypassWindowsQueue,
  parseWindowsTcpPort,
  withWindowsQueueBypass,
  PRE_SPOOL_REFUSALS,
} from '../main/printers/windows-queue-bypass';
import { printViaNetwork, WINSPOOL_HELPER_SOURCE } from '../main/printers/thermal';
import { assertEqualOrThrow, assertOrThrow } from './helpers/test-setup';
import { start, type FakeEscposPrinter } from './helpers/fake-escpos-printer';

const RAW = 1;
const LPR = 2;
const PAYLOAD = Buffer.from('HELLO-1550', 'ascii');

function portLine(port: {
  host?: string | null;
  port?: number;
  protocol?: number;
  snmpEnabled?: boolean;
}): string {
  return `FLO_PRINTER_PORT=${JSON.stringify({
    HostAddress: 'host' in port ? port.host : '192.168.1.50',
    PortNumber: port.port ?? 9100,
    Protocol: port.protocol ?? RAW,
    SNMPEnabled: port.snmpEnabled ?? false,
  })}`;
}

function stdoutWith(port: string): string {
  return ['FLO_PRINTER_INFO={"Name":"Rec","PrinterStatus":3}', port, 'FLO_JOB_ID=12'].join('\r\n');
}

// ── Parsing ─────────────────────────────────────────────────────────────────
assertEqualOrThrow(
  JSON.stringify(parseWindowsTcpPort(stdoutWith(portLine({})))),
  '{"host":"192.168.1.50","port":9100,"protocol":1,"snmpEnabled":false}',
  'a valid port line parses',
);
assertOrThrow(
  parseWindowsTcpPort(portLine({ host: null })) === undefined,
  'a missing host is rejected',
);
assertOrThrow(parseWindowsTcpPort(portLine({ port: 0 })) === undefined, 'port 0 is rejected');
assertOrThrow(
  parseWindowsTcpPort(portLine({ port: 70000 })) === undefined,
  'port 70000 is rejected',
);
assertOrThrow(
  parseWindowsTcpPort('FLO_PRINTER_PORT={not json') === undefined,
  'bad JSON is rejected',
);
assertEqualOrThrow(
  JSON.stringify(parseWindowsTcpPort(stdoutWith(portLine({ protocol: LPR, snmpEnabled: true })))),
  '{"host":"192.168.1.50","port":9100,"protocol":2,"snmpEnabled":true}',
  'an LPR port parses with its protocol and SNMP flag',
);
assertOrThrow(
  parseWindowsTcpPort('FLO_PRINTER_INFO={"Name":"Rec"}') === undefined,
  'stdout without a port line yields nothing',
);

// ── Which refusals may bypass ───────────────────────────────────────────────
const rawPort = parseWindowsTcpPort(portLine({}));
for (const refusal of PRE_SPOOL_REFUSALS) {
  assertOrThrow(canBypassWindowsQueue(refusal, rawPort), `bypass allowed for "${refusal}"`);
  // The real stderr shape, as seen in support logs, in English and Spanish Windows.
  assertOrThrow(
    canBypassWindowsQueue(
      `Exception calling "SendRaw" with "2" argument(s): "${refusal}"`,
      rawPort,
    ),
    `bypass allowed for wrapped "${refusal}"`,
  );
  assertOrThrow(
    canBypassWindowsQueue(
      `Excepción al llamar a "SendRaw" con los argumentos "2": "${refusal}"`,
      rawPort,
    ),
    `bypass allowed for localized "${refusal}"`,
  );
}
for (const detail of [
  'printer is out of paper',
  'Exception calling "SendRaw" with "2" argument(s): "printer is out of paper"',
  'Exception calling "SendRaw" with "2" argument(s): "printer is offline after StartDocPrinter"',
  "cannot open printer 'Rec' (Win32 error 1801)",
  'StartDocPrinter failed (Win32 error 1722)',
  'WritePrinter failed (Win32 error 6)',
  'Windows print command timed out',
]) {
  assertOrThrow(!canBypassWindowsQueue(detail, rawPort), `no bypass for "${detail}"`);
}
assertOrThrow(
  !canBypassWindowsQueue('printer is offline', parseWindowsTcpPort(portLine({ protocol: LPR }))),
  'no bypass for an LPR port',
);
assertOrThrow(!canBypassWindowsQueue('printer is offline', undefined), 'no bypass without a port');

// ── The bypass itself ───────────────────────────────────────────────────────
/** The socket write resolves before the server's data event fires. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (fake?.received.length) return;
  }
}

const failure = { ok: false, detail: 'printer is offline' } as const;
const options = { printerName: 'Rec', printViaNetwork };
let fake: FakeEscposPrinter | null = null;

async function main(): Promise<void> {
  fake = await start();
  try {
    const localPort = portLine({ host: '127.0.0.1', port: fake.port });
    const result = await withWindowsQueueBypass({ ...failure }, localPort, PAYLOAD, options);
    await settle();
    assertEqualOrThrow(result.ok, true, 'the bypass reports success');
    assertEqualOrThrow(result.transport, 'direct_tcp_fallback', 'the bypass names its transport');
    assertEqualOrThrow(
      Buffer.from(fake.received).equals(PAYLOAD) ? 'sent once' : `sent ${fake.received.length}`,
      'sent once',
      'the printer received the payload exactly once',
    );

    // A refusal outside the 3 texts must not open a connection at all.
    await withWindowsQueueBypass(
      { ok: false, detail: 'printer is out of paper' },
      localPort,
      PAYLOAD,
      options,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEqualOrThrow(fake.connections, 1, 'paper out opens no connection');
  } finally {
    await fake.close();
  }

  // Bypass to a closed port: the original failure comes back.
  const closed = await start();
  const closedPort = closed.port;
  await closed.close();
  const failed = await withWindowsQueueBypass(
    { ...failure },
    portLine({ host: '127.0.0.1', port: closedPort }),
    PAYLOAD,
    options,
  );
  assertEqualOrThrow(failed.ok, false, 'a failed bypass reports failure');
  assertEqualOrThrow(failed.detail, 'printer is offline', 'a failed bypass keeps the detail');

  // SNMP on: the detail says so, with and without a bypass.
  fake = await start();
  try {
    const snmpOk = await withWindowsQueueBypass(
      { ...failure },
      portLine({ host: '127.0.0.1', port: fake.port, snmpEnabled: true }),
      PAYLOAD,
      options,
    );
    assertEqualOrThrow(snmpOk.ok, true, 'SNMP on still bypasses once');

    const snmpFailed = await withWindowsQueueBypass(
      { ...failure },
      portLine({ host: '127.0.0.1', port: closedPort, snmpEnabled: true }),
      PAYLOAD,
      options,
    );
    assertEqualOrThrow(
      snmpFailed.detail,
      'printer is offline (SNMP status is enabled on this printer port)',
      'a failed bypass on an SNMP port names the SNMP setting',
    );

    const snmpLpr = await withWindowsQueueBypass(
      { ...failure },
      portLine({
        host: '127.0.0.1',
        port: fake.port,
        protocol: LPR,
        snmpEnabled: true,
      }),
      PAYLOAD,
      options,
    );
    assertEqualOrThrow(
      snmpLpr.detail,
      'printer is offline (SNMP status is enabled on this printer port)',
      'an LPR port is reported but never bypassed',
    );
    assertEqualOrThrow(fake.connections, 1, 'the LPR port was never contacted');
  } finally {
    await fake.close();
  }

  blockingStateOrder();
  console.log('windows queue bypass tests passed');
}

// Runs the shipped C# DescribeBlockingState as JS: its body is plain bit tests and returns.
function blockingStateOrder(): void {
  const body = WINSPOOL_HELPER_SOURCE.match(
    /string DescribeBlockingState\(uint status, uint attributes\) \{([\s\S]*?)\n {4}\}/,
  )?.[1];
  assertOrThrow(body, 'DescribeBlockingState is found in the helper source');
  const describe = new Function('status', 'attributes', 'PRINTER_ATTRIBUTE_WORK_OFFLINE', body) as (
    status: number,
    attributes: number,
    workOffline: number,
  ) => string | null;
  const state = (status: number, attributes = 0) => describe(status, attributes, 0x400);
  const refusable = (text: string | null) => PRE_SPOOL_REFUSALS.some((r) => text === r);

  assertEqualOrThrow(state(0x80), 'printer is offline', 'offline alone is a refusal');
  assertOrThrow(refusable(state(0x80)), 'offline alone may use the bypass');
  for (const [status, attributes, text] of [
    [0x90, 0, 'printer is out of paper'],
    [0x1008, 0, 'printer has a paper jam'],
    [0x400080, 0, 'printer cover is open'],
    [0x10, 0x400, 'printer is out of paper'],
  ] as const) {
    assertEqualOrThrow(
      state(status, attributes),
      text,
      `status ${status} names the physical fault`,
    );
    assertOrThrow(!refusable(state(status, attributes)), `status ${status} never uses the bypass`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
