import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadOrCreateCa,
  resetCa,
  readCaMeta,
  SecureStorageUnavailableError,
  type SecretStorage,
} from '../main/security/lan-tls/ca-store';
import {
  LEAF_VALIDITY_DAYS,
  fingerprintsOf,
  generateKeyPair,
  isPermittedLanIPv4,
  issueLeafCertificate,
} from '../main/security/lan-tls/x509';

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeStorage(overrides: Partial<SecretStorage> = {}): SecretStorage {
  return {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').toString('base64'), 'utf8'),
    decrypt: (encrypted) => Buffer.from(encrypted.toString('utf8'), 'base64').toString('utf8'),
    ...overrides,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flo-secure-network-certs-'));
}

function opensslText(pem: string): string | null {
  try {
    return execFileSync('openssl', ['x509', '-noout', '-text'], { input: pem }).toString();
  } catch {
    return null;
  }
}

function issueLeaf(ca: ReturnType<typeof loadOrCreateCa>, ips: string[], now?: Date) {
  return issueLeafCertificate(
    generateKeyPair(),
    { dnsNames: ['flo.local', 'localhost'], ipAddresses: ips },
    { certificateDer: ca.certificateDer, privateKey: ca.privateKey },
    now,
  );
}

async function main() {
  console.log('Secure Network certificate suite');

  // ── CA profile ─────────────────────────────────────────────────────────────
  const dir = tempDir();
  const storage = fakeStorage();
  const ca = loadOrCreateCa({ directory: dir, storage });
  assert.equal(ca.created, true, 'first load creates the CA');
  assert.equal(ca.regeneratedBecause, null, 'a first-time CA is not a regeneration');

  const caCert = new crypto.X509Certificate(ca.certificateDer);
  assert.equal(caCert.ca, true, 'CA certificate has CA:TRUE');
  assert.ok(caCert.verify(caCert.publicKey), 'CA is self-signed');
  const caYears = (new Date(caCert.validTo).getTime() - Date.now()) / (365 * DAY_MS);
  assert.ok(caYears > 9 && caYears < 11, 'CA is long-lived (about ten years)');

  const caText = opensslText(ca.certificatePem);
  if (caText) {
    assert.match(caText, /CA:TRUE, pathlen:0/, 'CA path length is 0');
    assert.match(
      caText,
      /Key Usage: critical\s+Certificate Sign\s*\n/,
      'CA key usage is keyCertSign only',
    );
    assert.match(caText, /Name Constraints/, 'CA carries name constraints');
    assert.match(caText, /DNS:local/, 'name constraints permit .local');
    assert.match(
      caText,
      /IP:192\.168\.0\.0\/255\.255\.0\.0/,
      'name constraints permit private ranges',
    );
  } else {
    console.log('  note: openssl not found, CA extension text checks not run');
  }

  // ── Leaf profile and SAN ───────────────────────────────────────────────────
  const leaf = issueLeaf(ca, ['127.0.0.1', '192.168.1.20', '10.0.0.5']);
  const leafCert = new crypto.X509Certificate(leaf.der);
  assert.equal(leafCert.ca, false, 'leaf is not a CA');
  assert.ok(leafCert.verify(caCert.publicKey), 'leaf signature verifies against the CA');
  assert.ok(leafCert.checkIssued(caCert), 'leaf names the CA as issuer');
  assert.ok(leafCert.checkHost('flo.local'), 'leaf covers flo.local');
  assert.ok(leafCert.checkHost('localhost'), 'leaf covers localhost');
  for (const ip of ['127.0.0.1', '192.168.1.20', '10.0.0.5']) {
    assert.ok(leafCert.checkIP(ip), `leaf covers ${ip}`);
  }
  assert.equal(leafCert.checkIP('192.168.1.99'), undefined, 'leaf does not cover other addresses');
  assert.deepEqual(leafCert.keyUsage, ['1.3.6.1.5.5.7.3.1'], 'leaf EKU is serverAuth only');
  const leafDays =
    (new Date(leafCert.validTo).getTime() - new Date(leafCert.validFrom).getTime()) / DAY_MS;
  assert.ok(leafDays <= 398, 'leaf validity stays inside the 398-day browser limit');
  assert.ok(
    leafDays >= LEAF_VALIDITY_DAYS,
    'leaf is valid for its full period plus skew allowance',
  );

  const leafText = opensslText(leaf.pem);
  if (leafText) {
    assert.match(leafText, /CA:FALSE/, 'leaf basic constraints CA:FALSE');
    assert.match(leafText, /Digital Signature/, 'leaf key usage includes digitalSignature');
    fs.writeFileSync(path.join(dir, 'leaf.pem'), leaf.pem);
    const verified = execFileSync('openssl', [
      'verify',
      '-CAfile',
      path.join(dir, 'ca.crt'),
      '-purpose',
      'sslserver',
      path.join(dir, 'leaf.pem'),
    ]).toString();
    assert.match(verified, /OK/, 'openssl accepts the leaf as a TLS server certificate');
  }

  // A forged leaf signed by a different key must not verify against this CA.
  const rogueCa = loadOrCreateCa({ directory: tempDir(), storage });
  const rogueLeaf = new crypto.X509Certificate(issueLeaf(rogueCa, ['127.0.0.1']).der);
  assert.equal(rogueLeaf.verify(caCert.publicKey), false, 'a leaf from another CA does not verify');

  // ── IP SAN filtering helper ────────────────────────────────────────────────
  assert.equal(isPermittedLanIPv4('192.168.29.92'), true);
  assert.equal(isPermittedLanIPv4('172.20.1.1'), true);
  assert.equal(isPermittedLanIPv4('172.32.1.1'), false, '172.32/16 is public space');
  assert.equal(isPermittedLanIPv4('100.64.0.15'), false, 'CGNAT/VPN addresses are not certified');
  assert.equal(isPermittedLanIPv4('8.8.8.8'), false);
  assert.equal(isPermittedLanIPv4('not-an-ip'), false);

  // ── Key storage ────────────────────────────────────────────────────────────
  const keyFile = path.join(dir, 'ca.key.enc');
  const keyBytes = fs.readFileSync(keyFile, 'utf8');
  assert.ok(!keyBytes.includes('PRIVATE KEY'), 'the CA key is not stored in plaintext');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, 'CA key file mode is 0600');
  }
  assert.ok(
    !fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8').includes('PRIVATE KEY'),
    'ca.crt is public only',
  );

  const reloaded = loadOrCreateCa({ directory: dir, storage });
  assert.equal(reloaded.created, false, 'second load reuses the CA');
  assert.deepEqual(reloaded.certificateDer, ca.certificateDer, 'same CA certificate after reload');
  assert.deepEqual(
    fingerprintsOf(reloaded.certificateDer),
    fingerprintsOf(ca.certificateDer),
    'fingerprints are stable across loads',
  );
  assert.match(fingerprintsOf(ca.certificateDer).sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.match(fingerprintsOf(ca.certificateDer).sha1, /^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);

  // ── Recovery: unreadable key regenerates rather than failing ───────────────
  const brokenStorage = fakeStorage({
    decrypt: () => {
      throw new Error('keychain changed');
    },
  });
  const recovered = loadOrCreateCa({ directory: dir, storage: brokenStorage });
  assert.equal(recovered.regeneratedBecause, 'key-unreadable', 'unreadable key is regenerated');
  assert.notDeepEqual(
    recovered.certificateDer,
    ca.certificateDer,
    'a new CA replaces the lost one',
  );
  assert.equal(
    readCaMeta(dir)?.regeneratedBecause,
    'key-unreadable',
    'regeneration is recorded for the UI',
  );

  // A certificate that does not match its key is replaced too.
  const mismatchDir = tempDir();
  loadOrCreateCa({ directory: mismatchDir, storage });
  const otherCa = loadOrCreateCa({ directory: tempDir(), storage });
  fs.writeFileSync(path.join(mismatchDir, 'ca.crt'), otherCa.certificatePem);
  assert.equal(
    loadOrCreateCa({ directory: mismatchDir, storage }).regeneratedBecause,
    'certificate-invalid',
    'mismatched certificate and key regenerate',
  );

  // A CA near expiry is renewed ahead of time.
  const lateDir = tempDir();
  loadOrCreateCa({ directory: lateDir, storage });
  const nearEnd = new Date(Date.now() + 3650 * DAY_MS - 30 * DAY_MS);
  assert.equal(
    loadOrCreateCa({ directory: lateDir, storage, now: () => nearEnd }).regeneratedBecause,
    'expiring',
    'a CA within a year of expiry is regenerated',
  );

  // Reset replaces the CA.
  const beforeReset = loadOrCreateCa({ directory: dir, storage });
  const afterReset = resetCa({ directory: dir, storage });
  assert.equal(afterReset.regeneratedBecause, 'reset');
  assert.notDeepEqual(
    afterReset.certificateDer,
    beforeReset.certificateDer,
    'reset yields a new CA',
  );

  // No OS encryption: refuse to persist an unprotected key.
  assert.throws(
    () =>
      loadOrCreateCa({ directory: tempDir(), storage: fakeStorage({ isAvailable: () => false }) }),
    SecureStorageUnavailableError,
    'unavailable OS encryption refuses to store the key',
  );

  // The CA directory is never inside a location that backups or diagnostics read from.
  const sources = [
    'main/services/local-backup.ts',
    'main/routes/diagnostics.ts',
    'main/services/google-drive.ts',
  ];
  for (const source of sources) {
    const text = fs.readFileSync(path.join(__dirname, '..', source), 'utf8');
    assert.ok(
      !/secure-network|ca\.key\.enc/.test(text),
      `${source} never references the CA key store`,
    );
  }

  console.log('Secure Network certificate suite passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
