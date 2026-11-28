import crypto from 'crypto';

/**
 * Minimal X.509 v3 issuer for the fixed profiles FloCafe needs: a long-lived local root CA and
 * short-lived server leaf certificates signed by it (ECDSA P-256 / SHA-256). Output is verified by
 * Node's own `X509Certificate` parser in tests.
 */

const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  OID: 0x06,
  UTF8: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
} as const;

const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  subjectKeyId: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  nameConstraints: '2.5.29.30',
  authorityKeyId: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(TAG.SEQUENCE, ...items);
const set = (...items: Buffer[]): Buffer => tlv(TAG.SET, ...items);
const octetString = (value: Buffer): Buffer => tlv(TAG.OCTET_STRING, value);
const boolean = (value: boolean): Buffer => tlv(TAG.BOOLEAN, Buffer.from([value ? 0xff : 0x00]));
const utf8 = (value: string): Buffer => tlv(TAG.UTF8, Buffer.from(value, 'utf8'));
const explicit = (tagNumber: number, content: Buffer): Buffer => tlv(0xa0 | tagNumber, content);
const implicitPrimitive = (tagNumber: number, content: Buffer): Buffer =>
  tlv(0x80 | tagNumber, content);

function bitString(content: Buffer, unusedBits = 0): Buffer {
  return tlv(TAG.BIT_STRING, Buffer.from([unusedBits]), content);
}

function integerFromBytes(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let trimmed = bytes.subarray(start);
  if (trimmed[0] & 0x80) trimmed = Buffer.concat([Buffer.from([0]), trimmed]);
  return tlv(TAG.INTEGER, trimmed);
}

function integerFromNumber(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return integerFromBytes(Buffer.from(bytes));
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded: number[] = [part & 0x7f];
    let remaining = Math.floor(part / 128);
    while (remaining > 0) {
      encoded.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...encoded);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

function formatTime(date: Date): Buffer {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const year = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  if (year >= 1950 && year < 2050) {
    return tlv(TAG.UTC_TIME, Buffer.from(pad(year % 100) + rest, 'ascii'));
  }
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(pad(year, 4) + rest, 'ascii'));
}

function name(commonName: string, organization: string): Buffer {
  const rdn = (type: string, value: string): Buffer => set(sequence(oid(type), utf8(value)));
  return sequence(rdn(OID.organization, organization), rdn(OID.commonName, commonName));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

function ipv4Bytes(address: string): Buffer {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new Error(`Invalid IPv4 address: ${address}`);
  }
  return Buffer.from(octets);
}

function randomSerial(): Buffer {
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  return serial;
}

/** Private ranges the CA may certify; also the only IP SANs a leaf may carry. */
const PERMITTED_IPV4_RANGES: ReadonlyArray<[string, string]> = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'],
];

export function isPermittedLanIPv4(address: string): boolean {
  let bytes: Buffer;
  try {
    bytes = ipv4Bytes(address);
  } catch {
    return false;
  }
  return PERMITTED_IPV4_RANGES.some(([base, mask]) => {
    const baseBytes = ipv4Bytes(base);
    const maskBytes = ipv4Bytes(mask);
    return bytes.every((byte, i) => (byte & maskBytes[i]) === baseBytes[i]);
  });
}

function nameConstraintsExtension(): Buffer {
  const dns = (value: string): Buffer =>
    sequence(implicitPrimitive(2, Buffer.from(value, 'ascii')));
  const ip = (base: string, mask: string): Buffer =>
    sequence(implicitPrimitive(7, Buffer.concat([ipv4Bytes(base), ipv4Bytes(mask)])));
  const permitted = tlv(
    0xa0,
    dns('local'),
    dns('localhost'),
    ...PERMITTED_IPV4_RANGES.map(([base, mask]) => ip(base, mask)),
  );
  return extension(OID.nameConstraints, false, sequence(permitted));
}

function subjectKeyIdentifier(spkiDer: Buffer): Buffer {
  const spki = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  const raw = spki.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(raw).digest().subarray(0, 20);
}

export interface KeyPair {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

export function generateKeyPair(): KeyPair {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function spkiDer(publicKey: crypto.KeyObject): Buffer {
  return publicKey.export({ type: 'spki', format: 'der' });
}

function signCertificate(tbs: Buffer, issuerKey: crypto.KeyObject): Buffer {
  const signature = crypto.sign('sha256', tbs, issuerKey);
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  return sequence(tbs, algorithm, bitString(signature));
}

function toPem(der: Buffer): string {
  const body = der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export interface IssuedCertificate {
  der: Buffer;
  pem: string;
  notBefore: Date;
  notAfter: Date;
}

const CLOCK_SKEW_BACKDATE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CA_VALIDITY_DAYS = 3650;
/** Well inside the 398-day ceiling that Apple platforms and Chrome enforce for server certificates. */
export const LEAF_VALIDITY_DAYS = 90;

export interface CaIdentity {
  commonName: string;
  organization: string;
}

export function issueCaCertificate(
  keys: KeyPair,
  identity: CaIdentity,
  now: Date = new Date(),
): IssuedCertificate {
  const notBefore = new Date(now.getTime() - CLOCK_SKEW_BACKDATE_MS);
  const notAfter = new Date(now.getTime() + CA_VALIDITY_DAYS * DAY_MS);
  const subject = name(identity.commonName, identity.organization);
  const spki = spkiDer(keys.publicKey);

  const tbs = sequence(
    explicit(0, integerFromNumber(2)),
    integerFromBytes(randomSerial()),
    sequence(oid(OID.ecdsaWithSha256)),
    subject,
    sequence(formatTime(notBefore), formatTime(notAfter)),
    subject,
    spki,
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence(boolean(true), integerFromNumber(0))),
        // keyCertSign only: bit 5 of the key usage bit string.
        extension(OID.keyUsage, true, bitString(Buffer.from([0x04]), 2)),
        extension(OID.subjectKeyId, false, octetString(subjectKeyIdentifier(spki))),
        nameConstraintsExtension(),
      ),
    ),
  );

  const der = signCertificate(tbs, keys.privateKey);
  return { der, pem: toPem(der), notBefore, notAfter };
}

export interface LeafRequest {
  dnsNames: string[];
  ipAddresses: string[];
  commonName?: string;
  organization?: string;
}

export function issueLeafCertificate(
  leafKeys: KeyPair,
  request: LeafRequest,
  ca: { certificateDer: Buffer; privateKey: crypto.KeyObject },
  now: Date = new Date(),
): IssuedCertificate {
  const caCert = new crypto.X509Certificate(ca.certificateDer);
  const issuerNameDer = extractSubjectDer(ca.certificateDer);
  const spki = spkiDer(leafKeys.publicKey);
  const caSpki = spkiDer(caCert.publicKey);
  const notBefore = new Date(now.getTime() - CLOCK_SKEW_BACKDATE_MS);
  const notAfter = new Date(now.getTime() + LEAF_VALIDITY_DAYS * DAY_MS);

  const sanEntries = [
    ...request.dnsNames.map((dns) => implicitPrimitive(2, Buffer.from(dns, 'ascii'))),
    ...request.ipAddresses.map((ip) => implicitPrimitive(7, ipv4Bytes(ip))),
  ];

  const tbs = sequence(
    explicit(0, integerFromNumber(2)),
    integerFromBytes(randomSerial()),
    sequence(oid(OID.ecdsaWithSha256)),
    issuerNameDer,
    sequence(formatTime(notBefore), formatTime(notAfter)),
    name(request.commonName ?? 'FloCafe', request.organization ?? 'FloCafe'),
    spki,
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence()),
        // digitalSignature: bit 0.
        extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)),
        extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
        extension(OID.subjectKeyId, false, octetString(subjectKeyIdentifier(spki))),
        extension(
          OID.authorityKeyId,
          false,
          sequence(implicitPrimitive(0, subjectKeyIdentifier(caSpki))),
        ),
        extension(OID.subjectAltName, false, sequence(...sanEntries)),
      ),
    ),
  );

  const der = signCertificate(tbs, ca.privateKey);
  return { der, pem: toPem(der), notBefore, notAfter };
}

/** Reads one DER element header; returns [headerLength, contentLength]. */
function readHeader(buffer: Buffer, offset: number): [number, number] {
  const first = buffer[offset + 1];
  if (first < 0x80) return [2, first];
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + buffer[offset + 2 + i];
  return [2 + count, length];
}

function skipElement(buffer: Buffer, offset: number): number {
  const [header, length] = readHeader(buffer, offset);
  return offset + header + length;
}

/** Extracts the DER of the subject Name so a leaf's issuer matches the CA byte for byte. */
function extractSubjectDer(certificateDer: Buffer): Buffer {
  const [certHeader] = readHeader(certificateDer, 0);
  const [tbsHeader] = readHeader(certificateDer, certHeader);
  let offset = certHeader + tbsHeader;
  // version [0], serial, signature, issuer, validity: skip to subject.
  offset = skipElement(certificateDer, offset);
  offset = skipElement(certificateDer, offset);
  offset = skipElement(certificateDer, offset);
  offset = skipElement(certificateDer, offset);
  offset = skipElement(certificateDer, offset);
  const end = skipElement(certificateDer, offset);
  return certificateDer.subarray(offset, end);
}

export interface CertificateFingerprints {
  sha256: string;
}

function colonHex(digest: Buffer): string {
  return digest.toString('hex').toUpperCase().match(/.{2}/g)!.join(':');
}

export function fingerprintsOf(der: Buffer): CertificateFingerprints {
  return {
    sha256: colonHex(crypto.createHash('sha256').update(der).digest()),
  };
}

export function derFromPem(pem: string): Buffer {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

function derBody(element: Buffer): Buffer {
  const [header, length] = readHeader(element, 0);
  if (header + length > element.length) throw new Error('Truncated DER element');
  return element.subarray(header, header + length);
}

function splitDerElements(buffer: Buffer): Buffer[] {
  const items: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [header, length] = readHeader(buffer, offset);
    const end = offset + header + length;
    if (end > buffer.length) throw new Error('Truncated DER element');
    items.push(buffer.subarray(offset, end));
    offset = end;
  }
  return items;
}

/**
 * Returns a PEM trust anchor with Name Constraints omitted so Electron's BoringSSL `x509_vfy`
 * (which rejects IP Name Constraints) still performs full native TLS verification.
 */
export function caTrustAnchorPemForNodeTls(caDer: Buffer): string {
  const [tbs, sigAlg, sigValue] = splitDerElements(derBody(caDer));
  const tbsElements = splitDerElements(derBody(tbs));
  const extIndex = tbsElements.findIndex((el) => el[0] === 0xa3);
  if (extIndex === -1) return toPem(caDer);

  const extensionsSeq = derBody(tbsElements[extIndex]);
  const extensions = splitDerElements(derBody(extensionsSeq));
  const nameConstraintsOid = oid(OID.nameConstraints);
  const filtered = extensions.filter((ext) => {
    const [extOid] = splitDerElements(derBody(ext));
    return !extOid.equals(nameConstraintsOid);
  });
  if (filtered.length === extensions.length) return toPem(caDer);

  const updatedTbs = [
    ...tbsElements.slice(0, extIndex),
    ...(filtered.length > 0 ? [explicit(3, sequence(...filtered))] : []),
    ...tbsElements.slice(extIndex + 1),
  ];
  return toPem(sequence(sequence(...updatedTbs), sigAlg, sigValue));
}
