// Minimal IPP (RFC 8011) client to communicate with local CUPS over UNIX socket /private/var/run/cupsd.
// Used for macOS App Store sandboxed builds without shelling out to lp/lpstat.

import * as http from 'http';

export const DEFAULT_CUPS_SOCKET_PATH = '/private/var/run/cupsd';
export const DEFAULT_CUPS_HOST = '127.0.0.1';
export const DEFAULT_CUPS_PORT = 631;
export const CUPS_RAW_DOCUMENT_FORMAT = 'application/vnd.cups-raw';
const IPP_TIMEOUT_MS = 10_000;

export const OP_PRINT_JOB = 0x0002;
export const OP_GET_PRINTER_ATTRIBUTES = 0x000b;
export const OP_CUPS_GET_DEFAULT = 0x4001;
export const OP_CUPS_GET_PRINTERS = 0x4002;

export const TAG_OPERATION_ATTRIBUTES = 0x01;
export const TAG_JOB_ATTRIBUTES = 0x02;
export const TAG_END_OF_ATTRIBUTES = 0x03;
export const TAG_PRINTER_ATTRIBUTES = 0x04;

export const VALUE_TAG = {
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  textWithLanguage: 0x35,
  nameWithLanguage: 0x36,
  textWithoutLanguage: 0x41,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
} as const;

export const IPP_STATUS_OK_MAX = 0x00ff;
export const IPP_STATUS_CLIENT_ERROR_NOT_FOUND = 0x0406;
export const IPP_STATUS_SERVER_ERROR_BUSY = 0x0507;
export const IPP_STATUS_SERVER_ERROR_NOT_ACCEPTING_JOBS = 0x0508;

export interface IppEndpointConfig {
  socketPath?: string | null;
  host?: string;
  port?: number;
}

let endpointOverride: IppEndpointConfig | null = null;

export function setIppEndpointForTesting(config: IppEndpointConfig | null): void {
  endpointOverride = config;
}

export type IppValue = string | number | boolean;
export type IppAttributeGroup = Record<string, IppValue[]>;

export interface IppAttribute {
  tag: number;
  name: string;
  values: IppValue[];
}

export interface IppResponse {
  statusCode: number;
  operationAttributes: IppAttributeGroup;
  /** One entry per printer-attributes-tag group (or per job-attributes-tag group). */
  groups: IppAttributeGroup[];
}

let requestIdCounter = 1;

function encodeValue(tag: number, value: IppValue): Buffer {
  if (tag === VALUE_TAG.integer || tag === VALUE_TAG.enum) {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(Number(value), 0);
    return buf;
  }
  if (tag === VALUE_TAG.boolean) {
    return Buffer.from([value ? 1 : 0]);
  }
  return Buffer.from(String(value), 'utf8');
}

function encodeAttribute(buf: Buffer[], attr: IppAttribute): void {
  attr.values.forEach((value, i) => {
    const nameBytes = i === 0 ? Buffer.from(attr.name, 'utf8') : Buffer.alloc(0);
    const valueBytes = encodeValue(attr.tag, value);

    const header = Buffer.alloc(1 + 2 + nameBytes.length + 2);
    header.writeUInt8(attr.tag, 0);
    header.writeUInt16BE(nameBytes.length, 1);
    nameBytes.copy(header, 3);
    header.writeUInt16BE(valueBytes.length, 3 + nameBytes.length);

    buf.push(header, valueBytes);
  });
}

export function buildIppRequest(
  operationId: number,
  operationAttributes: IppAttribute[],
  body?: Buffer,
): Buffer {
  const parts: Buffer[] = [];

  const header = Buffer.alloc(8);
  header.writeUInt8(2, 0); // IPP major version
  header.writeUInt8(0, 1); // IPP minor version
  header.writeUInt16BE(operationId, 2);
  header.writeUInt32BE(requestIdCounter++, 4);
  parts.push(header);

  parts.push(Buffer.from([TAG_OPERATION_ATTRIBUTES]));
  encodeAttribute(parts, {
    tag: VALUE_TAG.charset,
    name: 'attributes-charset',
    values: ['utf-8'],
  });
  encodeAttribute(parts, {
    tag: VALUE_TAG.naturalLanguage,
    name: 'attributes-natural-language',
    values: ['en'],
  });
  for (const attr of operationAttributes) encodeAttribute(parts, attr);

  parts.push(Buffer.from([TAG_END_OF_ATTRIBUTES]));
  if (body) parts.push(body);

  return Buffer.concat(parts);
}

function readString(buf: Buffer, offset: number, length: number): string {
  return buf.toString('utf8', offset, offset + length);
}

function decodeValue(tag: number, buf: Buffer, offset: number, length: number): IppValue {
  if (tag === VALUE_TAG.integer || tag === VALUE_TAG.enum) {
    return length >= 4 ? buf.readInt32BE(offset) : 0;
  }
  if (tag === VALUE_TAG.boolean) {
    return length >= 1 && buf.readUInt8(offset) !== 0;
  }
  if (tag === VALUE_TAG.textWithLanguage || tag === VALUE_TAG.nameWithLanguage) {
    if (length >= 4) {
      const langLen = buf.readUInt16BE(offset);
      const textOffset = offset + 2 + langLen;
      if (textOffset + 2 <= offset + length) {
        const textLen = buf.readUInt16BE(textOffset);
        if (textOffset + 2 + textLen <= offset + length) {
          return readString(buf, textOffset + 2, textLen);
        }
      }
    }
  }
  return readString(buf, offset, length);
}

function isValueTag(tag: number): boolean {
  // Attribute value tags occupy 0x10-0x4F; the delimiter tags (start-of-group
  // / end-of-attributes) used here are all below that range.
  return tag >= 0x10;
}

export function parseIppResponse(buf: Buffer): IppResponse {
  if (buf.length < 8) {
    throw new Error('Truncated IPP response header');
  }
  const statusCode = buf.readUInt16BE(2);
  let offset = 8;

  const operationAttributes: IppAttributeGroup = {};
  const groups: IppAttributeGroup[] = [];
  let currentGroup: IppAttributeGroup | null = null;
  let lastAttrName = '';

  while (offset < buf.length) {
    const tag = buf.readUInt8(offset);
    offset += 1;

    if (tag === TAG_END_OF_ATTRIBUTES) break;

    if (!isValueTag(tag)) {
      // A new attribute-group delimiter (operation/job/printer/...).
      currentGroup = tag === TAG_OPERATION_ATTRIBUTES ? null : {};
      if (currentGroup && (tag === TAG_PRINTER_ATTRIBUTES || tag === TAG_JOB_ATTRIBUTES)) {
        groups.push(currentGroup);
      }
      lastAttrName = '';
      continue;
    }

    if (offset + 2 > buf.length) {
      throw new Error('Truncated IPP attribute name length');
    }
    const nameLength = buf.readUInt16BE(offset);
    offset += 2;
    if (offset + nameLength + 2 > buf.length) {
      throw new Error('Truncated IPP attribute name');
    }
    const name = readString(buf, offset, nameLength);
    offset += nameLength;

    const valueLength = buf.readUInt16BE(offset);
    offset += 2;
    if (offset + valueLength > buf.length) {
      throw new Error('Truncated IPP attribute value');
    }
    const value = decodeValue(tag, buf, offset, valueLength);
    offset += valueLength;

    const attrName = name || lastAttrName;
    lastAttrName = attrName;
    const target = currentGroup ?? operationAttributes;
    if (!target[attrName]) target[attrName] = [];
    target[attrName].push(value);
  }

  return { statusCode, operationAttributes, groups };
}

export function formatIppStatusError(
  statusCode: number,
  printerName: string,
  statusMessage?: string,
): string {
  if (statusCode === IPP_STATUS_CLIENT_ERROR_NOT_FOUND) {
    return `Printer queue "${printerName}" was not found in macOS Printers & Scanners. Add the USB printer in System Settings > Printers & Scanners and make sure the printer name in FloCafe matches the CUPS queue name.`;
  }
  if (statusCode === IPP_STATUS_SERVER_ERROR_NOT_ACCEPTING_JOBS) {
    return `Printer "${printerName}" is not accepting jobs`;
  }
  if (statusCode === IPP_STATUS_SERVER_ERROR_BUSY) {
    return `Printer "${printerName}" is busy`;
  }
  const cleanMessage = typeof statusMessage === 'string' ? statusMessage.trim() : '';
  if (cleanMessage) {
    return `${cleanMessage} (IPP status 0x${statusCode.toString(16)})`;
  }
  return `IPP status 0x${statusCode.toString(16)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveEndpoint(
  useTcpFallback: boolean,
): { socketPath: string } | { host: string; port: number } {
  if (endpointOverride) {
    if (endpointOverride.socketPath) {
      if (!useTcpFallback || (!endpointOverride.host && !endpointOverride.port)) {
        return { socketPath: endpointOverride.socketPath };
      }
    }
    if (endpointOverride.host || endpointOverride.port || endpointOverride.socketPath === null) {
      return {
        host: endpointOverride.host ?? DEFAULT_CUPS_HOST,
        port: endpointOverride.port ?? DEFAULT_CUPS_PORT,
      };
    }
  }
  if (useTcpFallback) {
    return { host: DEFAULT_CUPS_HOST, port: DEFAULT_CUPS_PORT };
  }
  return { socketPath: DEFAULT_CUPS_SOCKET_PATH };
}

function canFallbackToTcp(): boolean {
  if (!endpointOverride) return true;
  return Boolean(endpointOverride.socketPath && (endpointOverride.host || endpointOverride.port));
}

// Retry on ECONNREFUSED and fall back from UNIX socket ENOENT to loopback TCP.
async function ippRequest(
  path: string,
  operationId: number,
  operationAttributes: IppAttribute[],
  body?: Buffer,
  signal?: AbortSignal,
): Promise<IppResponse> {
  const maxAttempts = 3;
  let useTcpFallback = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ippRequestOnce(
        path,
        operationId,
        operationAttributes,
        body,
        signal,
        resolveEndpoint(useTcpFallback),
      );
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' && !useTcpFallback && canFallbackToTcp() && !signal?.aborted) {
        useTcpFallback = true;
        return await ippRequestOnce(
          path,
          operationId,
          operationAttributes,
          body,
          signal,
          resolveEndpoint(true),
        );
      }
      if (code !== 'ECONNREFUSED' || attempt === maxAttempts || signal?.aborted) throw err;
      await delay(250 * attempt);
    }
  }
  throw new Error('unreachable');
}

async function ippRequestOnce(
  path: string,
  operationId: number,
  operationAttributes: IppAttribute[],
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
  endpoint: { socketPath: string } | { host: string; port: number },
): Promise<IppResponse> {
  const requestBody = buildIppRequest(operationId, operationAttributes, body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...endpoint,
        path,
        method: 'POST',
        headers: {
          Host: 'localhost',
          'Content-Type': 'application/ipp',
          'Content-Length': requestBody.length,
          Connection: 'close',
        },
        timeout: IPP_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`local CUPS returned HTTP ${status} for ${path}`));
            return;
          }
          try {
            resolve(parseIppResponse(Buffer.concat(chunks)));
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      },
    );

    req.on('timeout', () => req.destroy(new Error('IPP request to local CUPS server timed out')));
    req.on('error', reject);

    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }

    req.end(requestBody);
  });
}

const REQUESTED_PRINTER_ATTRIBUTES: IppAttribute = {
  tag: VALUE_TAG.keyword,
  name: 'requested-attributes',
  values: [
    'printer-name',
    'printer-info',
    'printer-make-and-model',
    'printer-state',
    'printer-is-accepting-jobs',
    'device-uri',
    'printer-uri-supported',
  ],
};

/** Enumerates every printer CUPS knows about (queues for USB and network printers alike). */
export async function ippGetPrinters(signal?: AbortSignal): Promise<IppAttributeGroup[]> {
  const response = await ippRequest(
    '/',
    OP_CUPS_GET_PRINTERS,
    [
      { tag: VALUE_TAG.nameWithoutLanguage, name: 'requesting-user-name', values: ['flocafe'] },
      REQUESTED_PRINTER_ATTRIBUTES,
    ],
    undefined,
    signal,
  );
  return response.groups;
}

/** Returns the CUPS-configured default printer's name, or null if none is set. */
export async function ippGetDefaultPrinterName(signal?: AbortSignal): Promise<string | null> {
  const response = await ippRequest(
    '/',
    OP_CUPS_GET_DEFAULT,
    [
      { tag: VALUE_TAG.nameWithoutLanguage, name: 'requesting-user-name', values: ['flocafe'] },
      REQUESTED_PRINTER_ATTRIBUTES,
    ],
    undefined,
    signal,
  );
  const name = response.groups[0]?.['printer-name']?.[0];
  return typeof name === 'string' ? name : null;
}

export interface IppPrinterAttributes {
  exists: boolean;
  statusCode: number;
  state?: number;
  isAcceptingJobs?: boolean;
  stateReasons?: string[];
  detail?: string;
}

function firstStatusMessage(operationAttributes: IppAttributeGroup): string | undefined {
  const msg = operationAttributes['status-message']?.[0];
  return typeof msg === 'string' ? msg : undefined;
}

/** Pre-flight check mirroring thermal.ts's describeCupsQueueProblem for the lp path. */
export async function ippGetPrinterAttributes(
  printerName: string,
  signal?: AbortSignal,
): Promise<IppPrinterAttributes> {
  const response = await ippRequest(
    `/printers/${encodeURIComponent(printerName)}`,
    OP_GET_PRINTER_ATTRIBUTES,
    [
      {
        tag: VALUE_TAG.uri,
        name: 'printer-uri',
        values: [`ipp://localhost/printers/${encodeURIComponent(printerName)}`],
      },
      { tag: VALUE_TAG.nameWithoutLanguage, name: 'requesting-user-name', values: ['flocafe'] },
      {
        tag: VALUE_TAG.keyword,
        name: 'requested-attributes',
        values: ['printer-state', 'printer-is-accepting-jobs', 'printer-state-reasons'],
      },
    ],
    undefined,
    signal,
  );
  const statusMessage = firstStatusMessage(response.operationAttributes);
  if (response.statusCode === IPP_STATUS_CLIENT_ERROR_NOT_FOUND) {
    return {
      exists: false,
      statusCode: response.statusCode,
      detail: formatIppStatusError(response.statusCode, printerName, statusMessage),
    };
  }
  if (response.statusCode > IPP_STATUS_OK_MAX) {
    return {
      exists: true,
      statusCode: response.statusCode,
      detail: formatIppStatusError(response.statusCode, printerName, statusMessage),
    };
  }
  const group = response.groups[0] || {};
  const state = group['printer-state']?.[0];
  const accepting = group['printer-is-accepting-jobs']?.[0];
  const reasons = group['printer-state-reasons']?.filter((v): v is string => typeof v === 'string');
  return {
    exists: true,
    statusCode: response.statusCode,
    state: typeof state === 'number' ? state : undefined,
    isAcceptingJobs: typeof accepting === 'boolean' ? accepting : undefined,
    stateReasons: reasons,
  };
}

export interface IppPrintResult {
  ok: boolean;
  statusCode: number;
  jobId?: number;
  detail?: string;
}

/** Submits raw bytes (ESC/POS) as a Print-Job with document-format application/vnd.cups-raw - the IPP equivalent of `lp -o raw`. */
export async function ippPrintRaw(
  printerName: string,
  data: Buffer,
  signal?: AbortSignal,
): Promise<IppPrintResult> {
  const response = await ippRequest(
    `/printers/${encodeURIComponent(printerName)}`,
    OP_PRINT_JOB,
    [
      {
        tag: VALUE_TAG.uri,
        name: 'printer-uri',
        values: [`ipp://localhost/printers/${encodeURIComponent(printerName)}`],
      },
      { tag: VALUE_TAG.nameWithoutLanguage, name: 'requesting-user-name', values: ['flocafe'] },
      { tag: VALUE_TAG.nameWithoutLanguage, name: 'job-name', values: ['FloCafe receipt'] },
      {
        tag: VALUE_TAG.mimeMediaType,
        name: 'document-format',
        values: [CUPS_RAW_DOCUMENT_FORMAT],
      },
    ],
    data,
    signal,
  );

  const jobId = response.groups[0]?.['job-id']?.[0];
  const ok = response.statusCode <= IPP_STATUS_OK_MAX;
  const statusMessage = firstStatusMessage(response.operationAttributes);
  return {
    ok,
    statusCode: response.statusCode,
    jobId: typeof jobId === 'number' ? jobId : undefined,
    detail: ok ? undefined : formatIppStatusError(response.statusCode, printerName, statusMessage),
  };
}
