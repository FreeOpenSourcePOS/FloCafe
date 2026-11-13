/**
 * Enum-only print failure facts: "is this Windows queue really USB or a network printer behind
 * one", and "which sub-case is a printer.queue_failed". Nothing here may carry a queue name,
 * host, IP, GUID, or path, and the collector drops a capture with an unregistered key.
 */
import { serializeOperationFailure } from '../main/lib/operation-failure';
import {
  cupsDevicePortKind,
  cupsQueuePort,
  driverKindFromName,
  failureStepFromDetail,
  printFailureFacts,
  queueRefusalFromDetail,
  windowsQueuePort,
} from '../main/printers/print-failure-facts';
import { scrubPostHogEvent } from '../shared/posthog-scrub';
import {
  BYPASS_OUTCOMES,
  DRIVER_KINDS,
  FAILURE_STEPS,
  PORT_KINDS,
  QUEUE_REFUSALS,
  SNMP_STATES,
} from '../shared/print/printer-facts';
import { assertEqualOrThrow, assertOrThrow } from './helpers/test-setup';

const INFO = 'FLO_PRINTER_INFO=';
const PORT = 'FLO_PRINTER_PORT=';

function windowsStdout(info?: Record<string, unknown>, port?: Record<string, unknown>): string {
  return [
    info ? `${INFO}${JSON.stringify(info)}` : '',
    port ? `${PORT}${JSON.stringify(port)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const TCP_RAW = { HostAddress: '192.168.1.50', PortNumber: 9100, Protocol: 1, SNMPEnabled: true };
const TCP_LPR = { HostAddress: '192.168.1.50', PortNumber: 515, Protocol: 2, SNMPEnabled: false };

function windowsPortKinds(): void {
  const cases: Array<
    [string, Record<string, unknown>, Record<string, unknown> | undefined, string]
  > = [
    ['USB001', { PortName: 'USB001' }, undefined, 'usb'],
    ['USB003 virtual', { PortName: 'USB003' }, undefined, 'usb'],
    ['IP_ queue with a RAW port', { PortName: 'IP_192.168.1.50' }, TCP_RAW, 'tcp_raw'],
    ['IP_ queue with an LPR port', { PortName: 'IP_192.168.1.50' }, TCP_LPR, 'tcp_lpr'],
    ['WSD queue', { PortName: 'WSD-8f2a4c10-9b11-4f2c-8a1e-1f0b2c3d4e5f' }, undefined, 'wsd'],
    ['shared queue', { PortName: '\\\\SERVER\\Kitchen' }, undefined, 'shared'],
    ['COM port', { PortName: 'COM3' }, undefined, 'serial'],
    ['LPT port', { PortName: 'LPT1' }, undefined, 'serial'],
    ['PORTPROMPT', { PortName: 'PORTPROMPT:' }, undefined, 'file'],
    ['FILE:', { PortName: 'FILE:' }, undefined, 'file'],
    ['a spool path', { PortName: 'C:\\spool\\out.prn' }, undefined, 'file'],
    ['a vendor port', { PortName: 'DockPort-7' }, undefined, 'other'],
    ['no metadata at all', undefined, undefined, 'unknown'],
  ];
  for (const [label, info, port, expected] of cases) {
    assertEqualOrThrow(windowsQueuePort(windowsStdout(info, port)).kind, expected, label);
  }
  // A Windows queue is stored as USB, so the port record is the only witness of a network device.
  const raw = windowsQueuePort(windowsStdout({ PortName: 'IP_192.168.1.50' }, TCP_RAW));
  assertEqualOrThrow(raw.snmpEnabled, true, 'the TCP port record carries the SNMP flag');
  const lpr = windowsQueuePort(windowsStdout({ PortName: 'IP_192.168.1.50' }, TCP_LPR));
  assertEqualOrThrow(lpr.snmpEnabled, false, 'an LPR port without SNMP says so');
  assertEqualOrThrow(
    windowsQueuePort('garbage\nFLO_PRINTER_INFO={oops').kind,
    'unknown',
    'unreadable metadata is unknown',
  );
}

function cupsPortKinds(): void {
  const cases: Array<[string, string]> = [
    ['usb://EPSON/TM-T20III', 'usb'],
    ['socket://192.168.1.50:9100', 'tcp_raw'],
    ['lpd://192.168.1.50/queue', 'tcp_lpr'],
    ['ipp://192.168.1.50/printers/kitchen', 'ipp'],
    ['ipps://print.local/printers/kitchen', 'ipp'],
    ['dnssd://Kitchen._ipp._tcp.local/', 'ipp'],
    ['http://till.office.lan/printers/kitchen', 'ipp'],
    ['smb://server/kitchen', 'shared'],
    ['serial:/dev/ttyS0', 'serial'],
    ['parallel:/dev/lp0', 'serial'],
    ['hp:/usb/Deskjet?serial=ABC', 'other'],
  ];
  for (const [uri, expected] of cases) {
    assertEqualOrThrow(
      cupsDevicePortKind(`device for Kitchen: ${uri}\n`, 'Kitchen'),
      expected,
      uri,
    );
  }
  assertEqualOrThrow(
    cupsDevicePortKind('device for Office: usb://EPSON/TM-T20III\n', 'Kitchen'),
    'unknown',
    'another queue is not ours',
  );
  assertEqualOrThrow(cupsDevicePortKind('', 'Kitchen'), 'unknown', 'no lpstat output');
}

async function cupsLookup(): Promise<void> {
  const calls: Array<{ file: string; args: string[]; timeout: number; lang?: string }> = [];
  const ok = await cupsQueuePort('Kitchen', {
    run: async (file, args, options) => {
      calls.push({ file, args, timeout: options.timeout, lang: options.env?.LC_ALL });
      return { stdout: 'device for Kitchen: ipp://192.168.1.50/printers/kitchen\n' };
    },
  });
  assertEqualOrThrow(ok.kind, 'ipp', 'the device URI scheme answers the question');
  assertEqualOrThrow(calls[0]?.file, 'lpstat', 'the lookup is lpstat');
  assertEqualOrThrow(calls[0]?.args.join(' '), '-v Kitchen', 'one queue is asked about');
  assertEqualOrThrow(calls[0]?.timeout, 2000, 'the lookup cannot hang a print failure');
  assertEqualOrThrow(calls[0]?.lang, 'C', 'lpstat runs in the C locale the parser reads');

  const failed = await cupsQueuePort('Kitchen', {
    run: async () => {
      throw new Error('lpstat: not found');
    },
  });
  assertEqualOrThrow(failed.kind, 'unknown', 'a failed lookup stays unknown');
  assertEqualOrThrow((await cupsQueuePort(undefined, {})).kind, 'unknown', 'no queue, no lookup');
  assertEqualOrThrow(
    (await cupsQueuePort('Kitchen', { isMas: true })).kind,
    'unknown',
    'the sandboxed Mac App Store build has no lpstat',
  );
}

function refusalsAndSteps(): void {
  const refusals: Array<[string, string]> = [
    ["printer is set to 'Use Printer Offline' in Windows", 'work_offline'],
    ['printer is offline', 'offline'],
    ['printer is not available', 'not_available'],
    ['printer is out of paper', 'paper_out'],
    ['printer has a paper jam', 'paper_jam'],
    ['printer cover is open', 'cover_open'],
    ['printer needs attention', 'attention'],
    ['printer reported an error', 'error'],
  ];
  for (const [text, expected] of refusals) {
    assertEqualOrThrow(queueRefusalFromDetail(text), expected, text);
    // The helper's text arrives inside PowerShell's wrapper, English or localized.
    const wrapped = `Exception calling "SendRaw" with "2" argument(s): "${text}"`;
    assertEqualOrThrow(queueRefusalFromDetail(wrapped), expected, wrapped);
    const spanish = `Excepción al llamar a "SendRaw" con los argumentos "2": "${text}"`;
    assertEqualOrThrow(queueRefusalFromDetail(spanish), expected, spanish);
    assertEqualOrThrow(
      failureStepFromDetail(wrapped, queueRefusalFromDetail(wrapped)),
      'pre_spool',
      text,
    );
  }
  assertEqualOrThrow(
    queueRefusalFromDetail('the printer is offline'),
    undefined,
    'exact text only',
  );

  const steps: Array<[string, string | undefined]> = [
    ["cannot open printer 'Kitchen' (Win32 error 1801)", 'open'],
    ['StartDocPrinter failed (Win32 error 1722)', 'startdoc'],
    ['StartPagePrinter failed (Win32 error 1722)', 'startpage'],
    ['WritePrinter failed (Win32 error 1722)', 'write'],
    ['WritePrinter accepted 3 of 9 bytes', 'short_write'],
    ['Windows print command timed out', 'timeout'],
    ['Windows print command was cancelled', 'cancelled'],
    ['Could not start the Windows print helper', 'helper_start'],
    ['lp: The printer or class does not exist.', undefined],
  ];
  for (const [detail, expected] of steps) {
    assertEqualOrThrow(failureStepFromDetail(detail, undefined), expected, detail);
  }

  const open = printFailureFacts({
    detail: "cannot open printer 'Kitchen' (Win32 error 1801)",
    connectionType: 'usb',
    platformErrorCode: 1801,
    queuePort: { kind: 'usb' },
  });
  assertEqualOrThrow(open.failure_step, 'open', 'the open step is reported');
  assertEqualOrThrow(open.win32_error, 1801, 'the Win32 error travels as a number');
  assertEqualOrThrow('queue_refusal' in open, false, 'no refusal, no bypass fact');

  const refused = printFailureFacts({
    detail: 'Exception calling "SendRaw" with "2" argument(s): "printer is offline"',
    platformErrorCode: 0,
    connectionType: 'usb',
    queuePort: { kind: 'tcp_raw', snmpEnabled: true },
  });
  assertEqualOrThrow(refused.queue_refusal, 'offline', 'the refusal is named');
  assertEqualOrThrow(refused.failure_step, 'pre_spool', 'a refusal happens before spooling');
  assertEqualOrThrow(refused.bypass, 'failed', 'a RAW port was worth a direct print');
  assertEqualOrThrow(refused.snmp_enabled, 'yes', 'the SNMP flag rides along');

  // The bypass appends the SNMP note after the quoted refusal; the refusal must still be named.
  const snmpNoted = printFailureFacts({
    detail:
      'Excepción al llamar a "SendRaw" con los argumentos "2": "printer is offline" (SNMP status is enabled on this printer port)',
    queuePort: { kind: 'tcp_raw', snmpEnabled: true },
  });
  assertEqualOrThrow(snmpNoted.queue_refusal, 'offline', 'the SNMP note does not hide the refusal');
  assertEqualOrThrow(snmpNoted.bypass, 'failed', 'the SNMP note does not hide the bypass try');

  const paperOnRaw = printFailureFacts({
    detail: 'printer is out of paper',
    queuePort: { kind: 'tcp_raw' },
  });
  assertEqualOrThrow(paperOnRaw.bypass, 'not_eligible', 'paper out is never bypassed, even on RAW');

  const notEligible = printFailureFacts({
    detail: 'printer is not available',
    connectionType: 'usb',
    queuePort: { kind: 'usb' },
  });
  assertEqualOrThrow(notEligible.bypass, 'not_eligible', 'a USB queue has no TCP port to try');

  const network = printFailureFacts({ detail: 'connect ECONNREFUSED', connectionType: 'network' });
  assertEqualOrThrow(network.port_kind, 'tcp_raw', 'a network profile prints to a socket');

  const drivers: Array<[string, string]> = [
    ['Generic / Text Only', 'generic_text'],
    ['Microsoft IPP Class Driver', 'ms_class'],
    ['Brother HL-L2350DW series', 'vendor'],
  ];
  for (const [driver, expected] of drivers) {
    assertEqualOrThrow(
      printFailureFacts({ detail: 'x', driverName: driver }).driver_kind,
      expected,
      driver,
    );
  }
  assertEqualOrThrow(driverKindFromName(''), 'unknown', 'no driver, no driver kind');
}

// reportPrintFailure builds `fc.backend.printer.<kind>.<queue|timeout>`; an unregistered point drops the ticket.
function everyCapturePointAndValue(): void {
  const sets: Record<string, readonly string[]> = {
    port_kind: PORT_KINDS,
    queue_refusal: QUEUE_REFUSALS,
    failure_step: FAILURE_STEPS,
    snmp_enabled: SNMP_STATES,
    driver_kind: DRIVER_KINDS,
    bypass: BYPASS_OUTCOMES,
  };
  for (const kind of ['receipt', 'kot', 'delivery_slip', 'payment_ticket']) {
    for (const stage of ['queue', 'timeout']) {
      for (const [key, values] of Object.entries(sets)) {
        for (const value of values) {
          const point = `fc.backend.printer.${kind}.${stage}`;
          const facts = { connection_type: 'usb', failure_class: 'offline', kind, [key]: value };
          const kept = serializeOperationFailure({
            capture_point: point,
            outcome: 'unknown',
            facts,
          });
          assertEqualOrThrow(kept?.facts[key], value, `${point} keeps ${key}=${value}`);
          const sent = scrubPostHogEvent(
            {
              event: 'printer_failed',
              properties: { capture_point: 'printer', kind, [key]: value },
            },
            { telemetryEnabled: true, accountLinked: false, allowExceptions: true },
          );
          assertEqualOrThrow(sent?.properties?.[key], value, `PostHog keeps ${key}=${value}`);
        }
      }
    }
  }
}

function schema(): void {
  const all = printFailureFacts({
    detail: 'StartDocPrinter failed (Win32 error 1722)',
    connectionType: 'usb',
    platformErrorCode: 1722,
    driverName: 'Generic / Text Only',
    queuePort: { kind: 'tcp_lpr', snmpEnabled: false },
  });
  const facts = { connection_type: 'usb', failure_class: 'spooler_error', kind: 'receipt', ...all };
  const kept = serializeOperationFailure({
    capture_point: 'fc.backend.printer.receipt.queue',
    outcome: 'unknown',
    facts,
  });
  assertOrThrow(kept !== null, 'the collector keeps a capture with every new fact');
  assertEqualOrThrow(kept?.facts.port_kind, 'tcp_lpr', 'port_kind survives the collector');
  assertEqualOrThrow(kept?.facts.bypass, undefined, 'no refusal, so no bypass fact');
  assertEqualOrThrow(kept?.facts.failure_step, 'startdoc', 'failure_step survives the collector');
  const refusedKept = serializeOperationFailure({
    capture_point: 'fc.backend.printer.receipt.queue',
    outcome: 'unknown',
    facts: {
      connection_type: 'usb',
      failure_class: 'offline',
      kind: 'receipt',
      ...printFailureFacts({ detail: 'printer is offline', queuePort: { kind: 'usb' } }),
    },
  });
  assertEqualOrThrow(refusedKept?.facts.bypass, 'not_eligible', 'bypass survives the collector');
  assertEqualOrThrow(kept?.facts.win32_error, 1722, 'win32_error survives as a number');

  const old = serializeOperationFailure({
    capture_point: 'fc.backend.printer.receipt.queue',
    outcome: 'unknown',
    facts: { connection_type: 'usb', failure_class: 'queue_unavailable', kind: 'receipt' },
  });
  assertOrThrow(old !== null, 'the old payload still serializes: every new fact is optional');

  const leaky = serializeOperationFailure({
    capture_point: 'fc.backend.printer.receipt.queue',
    outcome: 'unknown',
    facts: {
      connection_type: 'usb',
      failure_class: 'queue_unavailable',
      kind: 'receipt',
      port_kind: 'IP_192.168.1.50',
    },
  });
  assertEqualOrThrow(leaky, null, 'a port name in port_kind drops the whole capture');

  const badEnum = serializeOperationFailure({
    capture_point: 'fc.backend.printer.kot.timeout',
    outcome: 'unknown',
    facts: { connection_type: 'usb', failure_class: 'timeout', kind: 'kot', queue_refusal: 'nope' },
  });
  assertEqualOrThrow(badEnum, null, 'an unregistered refusal value drops the capture');

  const badInteger = serializeOperationFailure({
    capture_point: 'fc.backend.printer.kot.timeout',
    outcome: 'unknown',
    facts: {
      connection_type: 'usb',
      failure_class: 'timeout',
      kind: 'kot',
      win32_error: 4294967296,
    },
  });
  assertEqualOrThrow(badInteger, null, 'win32_error stays inside 32 bits');
  assertEqualOrThrow(
    'win32_error' in printFailureFacts({ detail: 'x', platformErrorCode: -1 }),
    false,
    'a negative code is dropped',
  );
  assertEqualOrThrow(
    'win32_error' in printFailureFacts({ detail: 'x', platformErrorCode: 1.5 }),
    false,
    'a fractional code is dropped',
  );
}

function privacy(): void {
  const leaky = printFailureFacts({
    detail:
      "cannot open printer 'Kitchen EPSON' (Win32 error 1801) at \\\\SERVER\\Kitchen on WSD-8f2a4c10",
    connectionType: 'usb',
    platformErrorCode: 1801,
    driverName: 'Generic / Text Only',
    queuePort: { kind: 'tcp_raw', snmpEnabled: true },
  });
  const failed = scrubPostHogEvent(
    {
      event: 'printer_failed',
      properties: {
        capture_point: 'printer',
        kind: 'receipt',
        connection_type: 'usb',
        failure_class: 'spooler_error',
        error_text: "cannot open printer 'Kitchen EPSON' on 192.168.1.50",
        ...leaky,
        port_name: 'WSD-8f2a4c10',
        host: '192.168.1.50',
      },
    },
    { telemetryEnabled: true, accountLinked: false, allowExceptions: true },
  );
  assertOrThrow(failed !== null, 'a diagnostic event passes the gate');
  const failedJson = JSON.stringify(failed);
  for (const secret of ['IP_', '192.168.', 'WSD-', '\\\\', 'Kitchen', 'EPSON', 'SERVER']) {
    assertEqualOrThrow(failedJson.includes(secret), false, `printer_failed leaks ${secret}`);
  }
  assertEqualOrThrow(failed?.properties?.port_kind, 'tcp_raw', 'the port kind survives the gate');
  assertEqualOrThrow(failed?.properties?.win32_error, 1801, 'the Win32 error survives the gate');
  assertEqualOrThrow(failed?.properties?.snmp_enabled, 'yes', 'the SNMP flag survives the gate');

  const recovered = scrubPostHogEvent(
    {
      event: 'printer_recovered',
      properties: {
        capture_point: 'printer',
        via: 'direct_tcp',
        kind: 'receipt',
        port_kind: 'tcp_raw',
        queue_refusal: 'work_offline',
        queue_name: 'Kitchen EPSON',
        host: '192.168.1.50',
      },
    },
    { telemetryEnabled: true, accountLinked: false, allowExceptions: true },
  );
  assertOrThrow(recovered !== null, 'the recovery event passes the gate');
  const recoveredJson = JSON.stringify(recovered);
  for (const secret of ['192.168.', 'Kitchen', 'EPSON']) {
    assertEqualOrThrow(recoveredJson.includes(secret), false, `printer_recovered leaks ${secret}`);
  }
  assertEqualOrThrow(recovered?.properties?.via, 'direct_tcp', 'the route is kept');
  assertEqualOrThrow(recovered?.properties?.queue_refusal, 'work_offline', 'the refusal is kept');
  const withoutConsent = scrubPostHogEvent(
    { event: 'printer_recovered', properties: { capture_point: 'printer', via: 'direct_tcp' } },
    { telemetryEnabled: true, accountLinked: false, allowExceptions: false },
  );
  assertEqualOrThrow(withoutConsent, null, 'no error-sending consent, no recovery event');
}

async function mainTest(): Promise<void> {
  windowsPortKinds();
  cupsPortKinds();
  await cupsLookup();
  refusalsAndSteps();
  schema();
  everyCapturePointAndValue();
  privacy();
  console.log('print failure facts: all assertions passed');
}

mainTest().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
