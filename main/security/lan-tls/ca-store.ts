import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { derFromPem, generateKeyPair, issueCaCertificate, type IssuedCertificate } from './x509';

/** Encrypts the CA private key at rest. The default implementation wraps Electron `safeStorage`. */
export interface SecretStorage {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export type CaRegenerationReason = 'key-unreadable' | 'certificate-invalid' | 'expiring' | 'reset';

export interface CaMaterial {
  certificatePem: string;
  certificateDer: Buffer;
  privateKey: crypto.KeyObject;
  notBefore: Date;
  notAfter: Date;
  /** Set when this call created a CA that replaced an earlier one (devices must trust again). */
  regeneratedBecause: CaRegenerationReason | null;
  created: boolean;
}

export interface CaStoreOptions {
  directory: string;
  storage: SecretStorage;
  now?: () => Date;
}

const CA_CERT_FILE = 'ca.crt';
const CA_KEY_FILE = 'ca.key.enc';
const CA_META_FILE = 'ca-meta.json';
const RENEW_CA_WITHIN_MS = 365 * 24 * 60 * 60 * 1000;

export class SecureStorageUnavailableError extends Error {
  readonly code = 'SECURE_STORAGE_UNAVAILABLE';
  constructor() {
    super(
      'Operating-system encryption is unavailable, so the certificate key cannot be stored safely.',
    );
  }
}

export interface CaMeta {
  createdAt: string;
  regeneratedAt?: string;
  regeneratedBecause?: CaRegenerationReason;
}

export function electronSecretStorage(): SecretStorage {
  // Loaded lazily so unit tests can run without the Electron runtime.
  const { safeStorage } = require('electron') as typeof import('electron');
  return {
    isAvailable: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (encrypted) => safeStorage.decryptString(encrypted),
  };
}

export function defaultSecureNetworkDirectory(): string {
  const { app } = require('electron') as typeof import('electron');
  return path.join(app.getPath('userData'), 'secure-network');
}

function writePrivateFile(file: string, data: string | Buffer): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function readMeta(directory: string): CaMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, CA_META_FILE), 'utf8')) as CaMeta;
  } catch {
    return null;
  }
}

export function readCaMeta(directory: string): CaMeta | null {
  return readMeta(directory);
}

function hostLabel(): string {
  const host = os
    .hostname()
    .split('.')[0]
    .replace(/[^A-Za-z0-9-]/g, '');
  return host.slice(0, 24) || 'host';
}

function createCa(
  options: CaStoreOptions,
  regeneratedBecause: CaRegenerationReason | null,
): CaMaterial {
  const keys = generateKeyPair();
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const issued: IssuedCertificate = issueCaCertificate(
    keys,
    { commonName: `FloCafe Local CA ${hostLabel()} ${suffix}`, organization: 'FloCafe' },
    options.now?.() ?? new Date(),
  );

  const keyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  // Key first: a crash between the two writes leaves an unmatched pair, which loads as "invalid" and regenerates.
  writePrivateFile(path.join(options.directory, CA_KEY_FILE), options.storage.encrypt(keyPem));
  fs.writeFileSync(path.join(options.directory, CA_CERT_FILE), issued.pem);
  const meta: CaMeta = {
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    ...(regeneratedBecause
      ? {
          regeneratedAt: (options.now?.() ?? new Date()).toISOString(),
          regeneratedBecause,
        }
      : {}),
  };
  writePrivateFile(path.join(options.directory, CA_META_FILE), JSON.stringify(meta));

  return {
    certificatePem: issued.pem,
    certificateDer: issued.der,
    privateKey: keys.privateKey,
    notBefore: issued.notBefore,
    notAfter: issued.notAfter,
    regeneratedBecause,
    created: true,
  };
}

function tryLoadCa(options: CaStoreOptions): CaMaterial | CaRegenerationReason | null {
  const certPath = path.join(options.directory, CA_CERT_FILE);
  const keyPath = path.join(options.directory, CA_KEY_FILE);
  if (!fs.existsSync(certPath) && !fs.existsSync(keyPath)) return null;
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return 'key-unreadable';

  let privateKey: crypto.KeyObject;
  try {
    const keyPem = options.storage.decrypt(fs.readFileSync(keyPath));
    privateKey = crypto.createPrivateKey(keyPem);
  } catch {
    return 'key-unreadable';
  }

  let certificate: crypto.X509Certificate;
  let certificateDer: Buffer;
  let certificatePem: string;
  try {
    certificatePem = fs.readFileSync(certPath, 'utf8');
    certificateDer = derFromPem(certificatePem);
    certificate = new crypto.X509Certificate(certificateDer);
    const derivedPublic = crypto
      .createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' });
    const certPublic = certificate.publicKey.export({ type: 'spki', format: 'der' });
    if (!derivedPublic.equals(certPublic)) return 'certificate-invalid';
  } catch {
    return 'certificate-invalid';
  }

  const now = options.now?.() ?? new Date();
  const notAfter = new Date(certificate.validTo);
  if (notAfter.getTime() - now.getTime() < RENEW_CA_WITHIN_MS) return 'expiring';

  return {
    certificatePem,
    certificateDer,
    privateKey,
    notBefore: new Date(certificate.validFrom),
    notAfter,
    regeneratedBecause: null,
    created: false,
  };
}

/**
 * Loads the installation's root CA, creating it on first use. A missing, unreadable or mismatched CA
 * (for example after a restore onto new hardware) is regenerated instead of failing, so recovery
 * never depends on the old key; callers surface `regeneratedBecause` so the owner knows devices must trust again.
 */
export function loadOrCreateCa(options: CaStoreOptions): CaMaterial {
  if (!options.storage.isAvailable()) throw new SecureStorageUnavailableError();
  const loaded = tryLoadCa(options);
  if (loaded && typeof loaded === 'object') return loaded;
  return createCa(options, loaded);
}

/** Discards the current CA and issues a new one. Every device must trust the new certificate again. */
export function resetCa(options: CaStoreOptions): CaMaterial {
  if (!options.storage.isAvailable()) throw new SecureStorageUnavailableError();
  return createCa(options, 'reset');
}
