/**
 * Unit and loopback mock-server tests for main/printers/ipp-client.ts
 * and Mac App Store (MAS) USB printing via local CUPS IPP (Issue #1347).
 *
 * Run: npm run test:printer
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildIppRequest,
  parseIppResponse,
  formatIppStatusError,
  ippGetPrinters,
  ippGetDefaultPrinterName,
  ippGetPrinterAttributes,
  ippPrintRaw,
  setIppEndpointForTesting,
  CUPS_RAW_DOCUMENT_FORMAT,
  IPP_STATUS_CLIENT_ERROR_NOT_FOUND,
  IPP_STATUS_SERVER_ERROR_BUSY,
  IPP_STATUS_SERVER_ERROR_NOT_ACCEPTING_JOBS,
  OP_CUPS_GET_DEFAULT,
  OP_CUPS_GET_PRINTERS,
  OP_GET_PRINTER_ATTRIBUTES,
  OP_PRINT_JOB,
  TAG_END_OF_ATTRIBUTES,
  TAG_JOB_ATTRIBUTES,
  TAG_OPERATION_ATTRIBUTES,
  TAG_PRINTER_ATTRIBUTES,
  VALUE_TAG,
  type IppAttribute,
} from '../main/printers/ipp-client';
import {
  classifyPrintFailure,
  detectConnectedPrinters,
  isMasRuntime,
  printViaUSB,
} from '../main/printers/thermal';

function buildMockIppResponse(
  statusCode: number,
  operationAttributes: IppAttribute[],
  groupTag?: number,
  groups: IppAttribute[][] = [],
): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(8);
  header.writeUInt8(2, 0);
  header.writeUInt8(0, 1);
  header.writeUInt16BE(statusCode, 2);
  header.writeUInt32BE(1, 4);
  parts.push(header);

  const writeAttr = (attr: IppAttribute) => {
    attr.values.forEach((value, idx) => {
      const nameBytes = idx === 0 ? Buffer.from(attr.name, 'utf8') : Buffer.alloc(0);
      let valBytes: Buffer;
      if (attr.tag === VALUE_TAG.integer || attr.tag === VALUE_TAG.enum) {
        valBytes = Buffer.alloc(4);
        valBytes.writeInt32BE(Number(value), 0);
      } else if (attr.tag === VALUE_TAG.boolean) {
        valBytes = Buffer.from([value ? 1 : 0]);
      } else {
        valBytes = Buffer.from(String(value), 'utf8');
      }
      const attrHeader = Buffer.alloc(1 + 2 + nameBytes.length + 2);
      attrHeader.writeUInt8(attr.tag, 0);
      attrHeader.writeUInt16BE(nameBytes.length, 1);
      nameBytes.copy(attrHeader, 3);
      attrHeader.writeUInt16BE(valBytes.length, 3 + nameBytes.length);
      parts.push(attrHeader, valBytes);
    });
  };

  parts.push(Buffer.from([TAG_OPERATION_ATTRIBUTES]));
  writeAttr({ tag: VALUE_TAG.charset, name: 'attributes-charset', values: ['utf-8'] });
  writeAttr({
    tag: VALUE_TAG.naturalLanguage,
    name: 'attributes-natural-language',
    values: ['en'],
  });
  for (const attr of operationAttributes) writeAttr(attr);

  if (groupTag && groups.length > 0) {
    for (const group of groups) {
      parts.push(Buffer.from([groupTag]));
      for (const attr of group) writeAttr(attr);
    }
  }

  parts.push(Buffer.from([TAG_END_OF_ATTRIBUTES]));
  return Buffer.concat(parts);
}

function testRequestBuildingAndResponseParsing(): void {
  const escposPayload = Buffer.from([0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x00]);
  const reqBuf = buildIppRequest(
    OP_PRINT_JOB,
    [
      {
        tag: VALUE_TAG.uri,
        name: 'printer-uri',
        values: ['ipp://localhost/printers/EPSON_TM_T20II'],
      },
      {
        tag: VALUE_TAG.mimeMediaType,
        name: 'document-format',
        values: [CUPS_RAW_DOCUMENT_FORMAT],
      },
      {
        tag: VALUE_TAG.keyword,
        name: 'requested-attributes',
        values: ['printer-name', 'printer-state'],
      },
    ],
    escposPayload,
  );

  // Verify IPP 2.0 header and operation ID
  assert.equal(reqBuf.readUInt8(0), 2, 'IPP major version is 2');
  assert.equal(reqBuf.readUInt8(1), 0, 'IPP minor version is 0');
  assert.equal(reqBuf.readUInt16BE(2), OP_PRINT_JOB, 'operationId is encoded big-endian');
  assert.ok(reqBuf.readUInt32BE(4) >= 1, 'requestId is positive');

  // Parse our own request buffer header + attributes and check trailing payload
  const parsedReq = parseIppResponse(reqBuf);
  assert.deepEqual(parsedReq.operationAttributes['attributes-charset'], ['utf-8']);
  assert.deepEqual(parsedReq.operationAttributes['attributes-natural-language'], ['en']);
  assert.deepEqual(parsedReq.operationAttributes['printer-uri'], [
    'ipp://localhost/printers/EPSON_TM_T20II',
  ]);
  assert.deepEqual(parsedReq.operationAttributes['document-format'], ['application/vnd.cups-raw']);
  assert.deepEqual(parsedReq.operationAttributes['requested-attributes'], [
    'printer-name',
    'printer-state',
  ]);
  assert.deepEqual(
    reqBuf.subarray(reqBuf.length - escposPayload.length),
    escposPayload,
    'raw ESC/POS payload is appended after TAG_END_OF_ATTRIBUTES',
  );

  // Parse response with textWithLanguage (0x35) and multiple printer groups
  const langVal = Buffer.alloc(2 + 2 + 2 + 5);
  langVal.writeUInt16BE(2, 0);
  langVal.write('en', 2, 'utf8');
  langVal.writeUInt16BE(5, 4);
  langVal.write('Ready', 6, 'utf8');
  const textWithLangAttr = Buffer.alloc(1 + 2 + 12 + 2 + langVal.length);
  textWithLangAttr.writeUInt8(VALUE_TAG.textWithLanguage, 0);
  textWithLangAttr.writeUInt16BE(12, 1);
  textWithLangAttr.write('printer-info', 3, 'utf8');
  textWithLangAttr.writeUInt16BE(langVal.length, 15);
  langVal.copy(textWithLangAttr, 17);

  const baseResp = buildMockIppResponse(0x0000, [], TAG_PRINTER_ATTRIBUTES, [
    [
      { tag: VALUE_TAG.nameWithoutLanguage, name: 'printer-name', values: ['EPSON_TM_T20II'] },
      { tag: VALUE_TAG.enum, name: 'printer-state', values: [3] },
      { tag: VALUE_TAG.boolean, name: 'printer-is-accepting-jobs', values: [true] },
    ],
  ]);
  // Splice textWithLangAttr right before TAG_END_OF_ATTRIBUTES
  const combinedResp = Buffer.concat([
    baseResp.subarray(0, baseResp.length - 1),
    textWithLangAttr,
    Buffer.from([TAG_END_OF_ATTRIBUTES]),
  ]);
  const parsedResp = parseIppResponse(combinedResp);
  assert.equal(parsedResp.statusCode, 0x0000);
  assert.equal(parsedResp.groups.length, 1);
  assert.equal(parsedResp.groups[0]['printer-name']?.[0], 'EPSON_TM_T20II');
  assert.equal(parsedResp.groups[0]['printer-state']?.[0], 3);
  assert.equal(parsedResp.groups[0]['printer-is-accepting-jobs']?.[0], true);
  assert.equal(parsedResp.groups[0]['printer-info']?.[0], 'Ready');

  // Truncated buffer checks
  assert.throws(
    () => parseIppResponse(Buffer.from([0x02, 0x00, 0x00])),
    /Truncated IPP response header/,
  );
  assert.throws(
    () => parseIppResponse(Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x01, 0x47, 0x00])),
    /Truncated IPP attribute/,
  );
}

function testErrorMappingAndClassification(): void {
  const notFoundMsg = formatIppStatusError(
    IPP_STATUS_CLIENT_ERROR_NOT_FOUND,
    'EPSON_TM_T20II',
    'The printer or class does not exist.',
  );
  assert.ok(
    notFoundMsg.includes(
      'Printer queue "EPSON_TM_T20II" was not found in macOS Printers & Scanners',
    ),
    '0x0406 produces actionable macOS Printers & Scanners guidance',
  );
  assert.equal(
    classifyPrintFailure(notFoundMsg),
    'not_configured',
    'missing CUPS queue error classifies as not_configured',
  );

  const notAcceptingMsg = formatIppStatusError(
    IPP_STATUS_SERVER_ERROR_NOT_ACCEPTING_JOBS,
    'EPSON_TM_T20II',
  );
  assert.equal(notAcceptingMsg, 'Printer "EPSON_TM_T20II" is not accepting jobs');
  assert.equal(classifyPrintFailure(notAcceptingMsg), 'queue_unavailable');

  const busyMsg = formatIppStatusError(IPP_STATUS_SERVER_ERROR_BUSY, 'EPSON_TM_T20II');
  assert.equal(busyMsg, 'Printer "EPSON_TM_T20II" is busy');

  const customStatusMsg = formatIppStatusError(0x0500, 'EPSON_TM_T20II', 'Spooler internal fault');
  assert.equal(customStatusMsg, 'Spooler internal fault (IPP status 0x500)');
}

async function testMockCupsServerAndMasDispatch(): Promise<void> {
  const receivedRequests: {
    url: string;
    operationId: number;
    operationAttributes: Record<string, unknown[]>;
    payload: Buffer;
  }[] = [];

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const operationId = body.readUInt16BE(2);
      const parsed = parseIppResponse(body);
      // Extract trailing payload after TAG_END_OF_ATTRIBUTES (0x03)
      const endIdx = body.indexOf(TAG_END_OF_ATTRIBUTES, 8);
      const payload = endIdx >= 0 ? body.subarray(endIdx + 1) : Buffer.alloc(0);

      receivedRequests.push({
        url: req.url || '',
        operationId,
        operationAttributes: parsed.operationAttributes,
        payload,
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/ipp');

      if (operationId === OP_CUPS_GET_PRINTERS) {
        res.end(
          buildMockIppResponse(0x0000, [], TAG_PRINTER_ATTRIBUTES, [
            [
              {
                tag: VALUE_TAG.nameWithoutLanguage,
                name: 'printer-name',
                values: ['EPSON_TM_T20II'],
              },
              {
                tag: VALUE_TAG.textWithoutLanguage,
                name: 'printer-make-and-model',
                values: ['EPSON TM-T20II Thermal'],
              },
              {
                tag: VALUE_TAG.uri,
                name: 'device-uri',
                values: ['usb://EPSON/TM-T20II?serial=12345'],
              },
              { tag: VALUE_TAG.enum, name: 'printer-state', values: [3] },
              { tag: VALUE_TAG.boolean, name: 'printer-is-accepting-jobs', values: [true] },
            ],
          ]),
        );
        return;
      }

      if (operationId === OP_CUPS_GET_DEFAULT) {
        res.end(
          buildMockIppResponse(0x0000, [], TAG_PRINTER_ATTRIBUTES, [
            [
              {
                tag: VALUE_TAG.nameWithoutLanguage,
                name: 'printer-name',
                values: ['EPSON_TM_T20II'],
              },
            ],
          ]),
        );
        return;
      }

      if (req.url === '/printers/EPSON_TM_T20II') {
        if (operationId === OP_GET_PRINTER_ATTRIBUTES) {
          res.end(
            buildMockIppResponse(0x0000, [], TAG_PRINTER_ATTRIBUTES, [
              [
                { tag: VALUE_TAG.enum, name: 'printer-state', values: [3] },
                { tag: VALUE_TAG.boolean, name: 'printer-is-accepting-jobs', values: [true] },
                { tag: VALUE_TAG.keyword, name: 'printer-state-reasons', values: ['none'] },
              ],
            ]),
          );
          return;
        }
        if (operationId === OP_PRINT_JOB) {
          res.end(
            buildMockIppResponse(0x0000, [], TAG_JOB_ATTRIBUTES, [
              [{ tag: VALUE_TAG.integer, name: 'job-id', values: [42] }],
            ]),
          );
          return;
        }
      }

      // Missing CUPS queue -> 0x0406 client-error-not-found
      res.end(
        buildMockIppResponse(IPP_STATUS_CLIENT_ERROR_NOT_FOUND, [
          {
            tag: VALUE_TAG.textWithoutLanguage,
            name: 'status-message',
            values: ['The printer or class does not exist.'],
          },
        ]),
      );
    });
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ipp-test-'));
  const socketPath = path.join(tmpDir, 'cupsd.sock');
  const unixServer = http.createServer(handler);
  const tcpServer = http.createServer(handler);

  const originalPlatform = process.platform;
  const originalMasEnv = process.env.MAS_BUILD;
  const originalPath = process.env.PATH;

  try {
    await new Promise<void>((resolve) => unixServer.listen(socketPath, resolve));
    await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
    const tcpPort = (tcpServer.address() as { port: number }).port;

    // 1. Direct UNIX domain socket transport test
    setIppEndpointForTesting({ socketPath });
    const printers = await ippGetPrinters();
    assert.equal(printers.length, 1);
    assert.equal(printers[0]['printer-name']?.[0], 'EPSON_TM_T20II');

    const defaultName = await ippGetDefaultPrinterName();
    assert.equal(defaultName, 'EPSON_TM_T20II');

    // 2. UNIX socket ENOENT fallback to loopback TCP
    setIppEndpointForTesting({
      socketPath: path.join(tmpDir, 'missing.sock'),
      host: '127.0.0.1',
      port: tcpPort,
    });
    const attrsExisting = await ippGetPrinterAttributes('EPSON_TM_T20II');
    assert.equal(attrsExisting.exists, true);
    assert.equal(attrsExisting.state, 3);
    assert.equal(attrsExisting.isAcceptingJobs, true);

    const attrsMissing = await ippGetPrinterAttributes('Missing_USB_Printer');
    assert.equal(attrsMissing.exists, false);
    assert.equal(attrsMissing.statusCode, IPP_STATUS_CLIENT_ERROR_NOT_FOUND);
    assert.ok(
      attrsMissing.detail?.includes('was not found in macOS Printers & Scanners'),
      'missing queue returns actionable message from ippGetPrinterAttributes',
    );

    // 3. End-to-end MAS printViaUSB & detectConnectedPrinters (with PATH emptied so lp/lpstat would fail if called)
    setIppEndpointForTesting({ socketPath });
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env.MAS_BUILD = '1';
    process.env.PATH = tmpDir;
    assert.equal(isMasRuntime(), true);

    const detected = await detectConnectedPrinters();
    assert.equal(detected.length, 1);
    assert.equal(detected[0].name, 'EPSON_TM_T20II');
    assert.equal(detected[0].connectionType, 'usb');
    assert.equal(detected[0].isDefault, true);

    const payload = Buffer.from('\x1b@\x1bE\x01FloCafe MAS Test\n\x1dV\x00', 'binary');
    receivedRequests.length = 0;
    const printOk = await printViaUSB(payload, 'EPSON_TM_T20II');
    assert.equal(printOk.ok, true, 'printViaUSB succeeds over local IPP on MAS darwin');
    assert.equal(printOk.jobId, 42);

    const printReq = receivedRequests.find((r) => r.operationId === OP_PRINT_JOB);
    assert.ok(printReq, 'OP_PRINT_JOB request was sent to CUPS');
    assert.deepEqual(
      printReq.operationAttributes['document-format'],
      [CUPS_RAW_DOCUMENT_FORMAT],
      'ippPrintRaw sends application/vnd.cups-raw for lp -o raw parity',
    );
    assert.deepEqual(printReq.payload, payload, 'exact ESC/POS bytes were transmitted');

    // 4. printViaUSB on MAS when no CUPS queue exists returns actionable not_configured error
    const printMissing = await printViaUSB(payload, 'Missing_USB_Printer');
    assert.equal(printMissing.ok, false);
    assert.equal(printMissing.failureClass, 'not_configured');
    assert.ok(
      printMissing.detail?.includes('System Settings > Printers & Scanners'),
      'printViaUSB surfaces actionable System Settings > Printers & Scanners instructions',
    );

    // 5. Direct ippPrintRaw against missing queue also maps 0x0406 cleanly
    const rawMissing = await ippPrintRaw('Missing_USB_Printer', payload);
    assert.equal(rawMissing.ok, false);
    assert.equal(rawMissing.statusCode, IPP_STATUS_CLIENT_ERROR_NOT_FOUND);
    assert.ok(rawMissing.detail?.includes('System Settings > Printers & Scanners'));
  } finally {
    setIppEndpointForTesting(null);
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalMasEnv === undefined) {
      delete process.env.MAS_BUILD;
    } else {
      process.env.MAS_BUILD = originalMasEnv;
    }
    process.env.PATH = originalPath;
    await new Promise<void>((resolve) => unixServer.close(() => resolve()));
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  testRequestBuildingAndResponseParsing();
  testErrorMappingAndClassification();
  await testMockCupsServerAndMasDispatch();
  console.log('✓ All IPP client and MAS CUPS USB printing tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
