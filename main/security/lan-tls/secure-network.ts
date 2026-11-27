import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import tls from 'tls';
import { WebSocket } from 'ws';
import {
  clearCaRegeneration,
  loadOrCreateCa,
  readCaMeta,
  resetCa,
  type CaMaterial,
  type CaRegenerationReason,
  type CaStoreOptions,
  type SecretStorage,
} from './ca-store';
import { createHttpsFront, type HttpsFront, type TlsCredentials } from './https-front';
import {
  fingerprintsOf,
  generateKeyPair,
  isPermittedLanIPv4,
  issueLeafCertificate,
  type CertificateFingerprints,
  type IssuedCertificate,
} from './x509';

export type SurfaceId = 'main' | 'kds' | 'serverApp';

export interface SurfaceDefinition {
  id: SurfaceId;
  label: string;
  getHttpServer: () => http.Server | null;
  getHttpPort: () => number;
  /** HTTPS ports to try, most preferred first. */
  getCandidatePorts: () => number[];
  setHttpsPort: (port: number | null) => void;
}

export type FirewallState = {
  supported: boolean;
  ruleInstalled: boolean | null;
  networkProfile: 'private' | 'public' | 'domain' | 'unknown';
};

export interface SecureNetworkDeps {
  directory: string;
  storage: SecretStorage;
  getLanIPs: () => string[];
  surfaces: SurfaceDefinition[];
  bindHost?: string;
  now?: () => Date;
  getFirewallState?: () => Promise<FirewallState>;
  /** Called after enable, disable, repair or reset changes the serving ports or CA. */
  onChange?: () => void;
  log?: (message: string) => void;
}

export type SecureNetworkErrorCode =
  | 'secure_storage_unavailable'
  | 'certificate_failed'
  | 'port_unavailable';

export type CertificateStatus = 'valid' | 'expiring' | 'attention' | 'missing';

export interface SurfaceStatus {
  id: SurfaceId;
  label: string;
  listening: boolean;
  https_port: number | null;
  http_port: number;
  error_code: SecureNetworkErrorCode | null;
}

export interface SecureNetworkStatus {
  enabled: boolean;
  state: 'disabled' | 'starting' | 'running' | 'partial' | 'unavailable';
  error_code: SecureNetworkErrorCode | null;
  certificate: {
    status: CertificateStatus;
    leaf_not_after: string | null;
    ca_not_after: string | null;
    ca_fingerprint_sha256: string | null;
  };
  lan_ips: string[];
  surfaces: SurfaceStatus[];
  ip_change: { previous: string[]; current: string[]; at: string } | null;
  ca_regenerated: { reason: CaRegenerationReason; at: string } | null;
}

export type DiagnosticId =
  | 'lan_ip'
  | 'ports'
  | 'https_service'
  | 'certificate'
  | 'backend'
  | 'websocket'
  | 'firewall'
  | 'network_profile';

export interface DiagnosticCheck {
  id: DiagnosticId;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  /** Stable machine code the UI maps to a translated sentence. */
  code: string;
  surface?: SurfaceId;
}

interface ConfigFile {
  enabled?: boolean;
  lastLanIps?: string[];
  ipChange?: { previous: string[]; current: string[]; at: string } | null;
}

const CONFIG_FILE = 'config.json';
const REFRESH_INTERVAL_MS = 30_000;
const RENEW_LEAF_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_FLOOR = new Date('2025-01-01T00:00:00Z');
const CLOCK_SKEW_TOLERANCE_MS = 36 * 60 * 60 * 1000;
const SELF_CHECK_TIMEOUT_MS = 4000;

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function verifyLoopbackPeerCertificate(
  peerRaw: Buffer | undefined,
  expectedLeafDer: Buffer,
  caCertificateDer: Buffer,
  now: Date,
): void {
  if (!peerRaw || peerRaw.length === 0) {
    throw new Error('Missing peer certificate');
  }
  if (!peerRaw.equals(expectedLeafDer)) {
    throw new Error('Peer certificate does not match expected leaf');
  }
  const peerCert = new crypto.X509Certificate(peerRaw);
  const caCert = new crypto.X509Certificate(caCertificateDer);
  if (!peerCert.verify(caCert.publicKey)) {
    throw new Error('Peer certificate signature verification failed');
  }
  if (!peerCert.checkIssued(caCert)) {
    throw new Error('Peer certificate issuer mismatch');
  }
  const nowMs = now.getTime();
  const notBeforeMs = Date.parse(peerCert.validFrom);
  const notAfterMs = Date.parse(peerCert.validTo);
  if (
    !Number.isFinite(notBeforeMs) ||
    !Number.isFinite(notAfterMs) ||
    nowMs < notBeforeMs ||
    nowMs > notAfterMs
  ) {
    throw new Error('Peer certificate is outside its validity window');
  }
  if (!peerCert.checkHost('localhost') || !peerCert.checkIP('127.0.0.1')) {
    throw new Error('Peer certificate SANs do not cover loopback');
  }
}

export class SecureNetworkService {
  private readonly deps: SecureNetworkDeps;
  private ca: CaMaterial | null = null;
  private caFingerprints: CertificateFingerprints | null = null;
  private leaf: IssuedCertificate | null = null;
  private leafKeyPem: string | null = null;
  private leafIps: string[] = [];
  private fronts = new Map<SurfaceId, HttpsFront>();
  private surfaceErrors = new Map<SurfaceId, SecureNetworkErrorCode>();
  private errorCode: SecureNetworkErrorCode | null = null;
  private starting = false;
  private timer: NodeJS.Timeout | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(deps: SecureNetworkDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.deps.log ?? ((m) => console.log(m)))(`[SecureNetwork] ${message}`);
  }

  private caOptions(): CaStoreOptions {
    return { directory: this.deps.directory, storage: this.deps.storage, now: this.deps.now };
  }

  private readConfig(): ConfigFile {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.deps.directory, CONFIG_FILE), 'utf8'));
    } catch {
      return {};
    }
  }

  private writeConfig(patch: ConfigFile): void {
    fs.mkdirSync(this.deps.directory, { recursive: true, mode: 0o700 });
    const next = { ...this.readConfig(), ...patch };
    fs.writeFileSync(path.join(this.deps.directory, CONFIG_FILE), JSON.stringify(next));
  }

  isEnabled(): boolean {
    return this.readConfig().enabled !== false;
  }

  /** Serialises start, stop and repair so overlapping UI actions cannot interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(task, task);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private desiredLanIps(): string[] {
    const ips = new Set<string>(['127.0.0.1']);
    for (const ip of this.deps.getLanIPs()) {
      if (isPermittedLanIPv4(ip)) ips.add(ip);
    }
    return [...ips].sort();
  }

  private clearCertificateState(): void {
    this.ca = null;
    this.caFingerprints = null;
    this.leaf = null;
    this.leafKeyPem = null;
    this.leafIps = [];
  }

  private issueLeaf(): void {
    if (!this.ca) throw new Error('CA not loaded');
    const keys = generateKeyPair();
    const ips = this.desiredLanIps();
    this.leaf = issueLeafCertificate(
      keys,
      { dnsNames: ['flo.local', 'localhost'], ipAddresses: ips },
      { certificateDer: this.ca.certificateDer, privateKey: this.ca.privateKey },
      this.now(),
    );
    this.leafKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    this.leafIps = ips;
  }

  private credentials(): TlsCredentials {
    if (!this.leaf || !this.leafKeyPem) throw new Error('Leaf certificate not issued');
    return { key: this.leafKeyPem, cert: this.leaf.pem };
  }

  private recordIpChange(): void {
    const config = this.readConfig();
    const previous = [...(config.lastLanIps ?? [])].sort();
    const current = this.leafIps;
    if (previous.length > 0 && !sameSet(previous, current)) {
      this.writeConfig({
        lastLanIps: current,
        ipChange: { previous, current, at: this.now().toISOString() },
      });
      this.log(`LAN address set changed: ${previous.join(', ')} -> ${current.join(', ')}`);
    } else if (previous.length === 0) {
      this.writeConfig({ lastLanIps: current });
    }
  }

  start(): Promise<void> {
    return this.enqueue(() => this.startInternal());
  }

  private async startInternal(): Promise<void> {
    this.errorCode = null;
    this.surfaceErrors.clear();
    if (!this.isEnabled()) return;
    this.starting = true;
    try {
      try {
        this.ca = loadOrCreateCa(this.caOptions());
        this.caFingerprints = fingerprintsOf(this.ca.certificateDer);
        this.issueLeaf();
      } catch (error) {
        this.clearCertificateState();
        const code = (error as { code?: string }).code;
        this.errorCode =
          code === 'SECURE_STORAGE_UNAVAILABLE'
            ? 'secure_storage_unavailable'
            : 'certificate_failed';
        this.log(`Certificate provisioning failed: ${(error as Error).message}`);
        return;
      }
      try {
        this.recordIpChange();
      } catch (error) {
        this.log(`Could not record the address change: ${(error as Error).message}`);
      }

      const credentials = this.credentials();
      for (const surface of this.deps.surfaces) {
        if (!surface.getHttpServer()) continue;
        const front = createHttpsFront({
          label: surface.label,
          getHttpServer: surface.getHttpServer,
          candidatePorts: surface.getCandidatePorts(),
          bindHost: this.deps.bindHost,
          credentials,
        });
        try {
          const port = await front.start();
          this.fronts.set(surface.id, front);
          surface.setHttpsPort(port);
          this.log(`${surface.label} HTTPS listening on port ${port}`);
        } catch (error) {
          this.surfaceErrors.set(surface.id, 'port_unavailable');
          this.log(`${surface.label} HTTPS failed to start: ${(error as Error).message}`);
        }
      }

      this.timer = setInterval(() => {
        void this.refresh().catch((error) =>
          this.log(`Certificate refresh failed: ${(error as Error).message}`),
        );
      }, REFRESH_INTERVAL_MS);
      this.timer.unref();
    } finally {
      this.starting = false;
    }
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopInternal());
  }

  private async stopInternal(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const fronts = [...this.fronts.entries()];
    this.fronts.clear();
    const failures: unknown[] = [];
    for (const [id, front] of fronts) {
      this.deps.surfaces.find((s) => s.id === id)?.setHttpsPort(null);
      try {
        await front.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Secure Network shutdown failed');
  }

  /** Reissues the leaf when the LAN address set changed or renewal is due, without any device re-trusting. */
  refresh(): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.ca || !this.leaf || this.fronts.size === 0) return false;
      const desired = this.desiredLanIps();
      const renewalDue = this.leaf.notAfter.getTime() - this.now().getTime() < RENEW_LEAF_WITHIN_MS;
      if (sameSet(desired, this.leafIps) && !renewalDue) return false;
      const previous = { leaf: this.leaf, key: this.leafKeyPem, ips: this.leafIps };
      const previousCredentials = this.credentials();
      try {
        this.issueLeaf();
        const credentials = this.credentials();
        for (const front of this.fronts.values()) front.setCredentials(credentials);
      } catch (error) {
        // Published addresses must keep matching what every front presents; retry next tick.
        this.leaf = previous.leaf;
        this.leafKeyPem = previous.key;
        this.leafIps = previous.ips;
        for (const [id, front] of [...this.fronts.entries()]) {
          try {
            front.setCredentials(previousCredentials);
          } catch (restoreError) {
            // A front that cannot be restored must not keep presenting a certificate the published addresses do not match.
            this.log(
              `Stopping a front that could not be restored: ${(restoreError as Error).message}`,
            );
            this.fronts.delete(id);
            this.surfaceErrors.set(id, 'certificate_failed');
            this.deps.surfaces.find((surface) => surface.id === id)?.setHttpsPort(null);
            void front.stop().catch(() => undefined);
          }
        }
        throw error;
      }
      try {
        this.recordIpChange();
      } catch (error) {
        this.log(`Could not record the address change: ${(error as Error).message}`);
      }
      return true;
    });
  }

  /** A slow drain must never leave HTTPS down, so a failed stop is logged and the restart still runs. */
  private async restartFronts(): Promise<void> {
    try {
      await this.stopInternal();
    } catch (error) {
      this.log(`Stopping HTTPS fronts failed: ${(error as Error).message}`);
    }
    this.clearCertificateState();
    await this.startInternal();
  }

  private notifyChanged(): void {
    try {
      this.deps.onChange?.();
    } catch (error) {
      this.log(`Change notification failed: ${(error as Error).message}`);
    }
  }

  /** Persists the setting only, so a caller can report a write failure before touching the listeners. */
  saveEnabled(enabled: boolean): void {
    this.writeConfig({ enabled });
  }

  /** Applies the persisted setting by starting or stopping the fronts. */
  applyEnabled(): Promise<void> {
    return this.enqueue(async () => {
      const enabled = this.isEnabled();
      if (enabled) {
        await this.restartFronts();
      } else {
        try {
          await this.stopInternal();
        } catch (error) {
          this.log(`Stopping HTTPS fronts failed: ${(error as Error).message}`);
        }
        this.clearCertificateState();
      }
      this.notifyChanged();
    });
  }

  setEnabled(enabled: boolean): Promise<void> {
    this.saveEnabled(enabled);
    return this.applyEnabled();
  }

  /** Stops and restarts the fronts and reloads the CA; used by Repair Connection. */
  repair(): Promise<void> {
    return this.enqueue(async () => {
      await this.restartFronts();
      this.notifyChanged();
    });
  }

  /** Replaces the root CA. Every device must trust the new certificate again. */
  resetAuthority(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.stopInternal();
      } catch (error) {
        this.log(`Stopping HTTPS fronts failed: ${(error as Error).message}`);
      }
      let resetFailure: unknown = null;
      try {
        resetCa(this.caOptions());
      } catch (error) {
        resetFailure = error;
      }
      this.clearCertificateState();
      let startFailure: unknown = null;
      try {
        await this.startInternal();
      } catch (error) {
        startFailure = error;
      }
      this.notifyChanged();
      // The first failure is the root cause, so it is the one reported.
      if (resetFailure) throw resetFailure;
      if (startFailure) throw startFailure;
    });
  }

  /** Clears the address-change and certificate-recreated notices once the owner has seen them. */
  acknowledgeNotices(): void {
    this.writeConfig({ ipChange: null });
    clearCaRegeneration(this.deps.directory);
  }

  /** LAN addresses the active leaf certificate covers; only these are safe to publish as URLs. */
  getCertifiedLanIps(): string[] {
    return this.leafIps.filter((ip) => ip !== '127.0.0.1');
  }

  getPublicCa(): { pem: string; der: Buffer; fingerprints: CertificateFingerprints } | null {
    if (!this.ca || !this.caFingerprints) return null;
    return {
      pem: this.ca.certificatePem,
      der: this.ca.certificateDer,
      fingerprints: this.caFingerprints,
    };
  }

  getStatus(): SecureNetworkStatus {
    const enabled = this.isEnabled();
    const surfaces: SurfaceStatus[] = this.deps.surfaces.map((surface) => {
      const front = this.fronts.get(surface.id);
      return {
        id: surface.id,
        label: surface.label,
        listening: Boolean(front?.getPort()),
        https_port: front?.getPort() ?? null,
        http_port: surface.getHttpPort(),
        error_code: this.surfaceErrors.get(surface.id) ?? null,
      };
    });

    const listening = surfaces.filter((s) => s.listening).length;
    let state: SecureNetworkStatus['state'];
    if (!enabled) state = 'disabled';
    else if (this.starting) state = 'starting';
    else if (this.errorCode || listening === 0) state = 'unavailable';
    else if (listening < surfaces.length) state = 'partial';
    else state = 'running';

    let certificateStatus: CertificateStatus = 'missing';
    if (this.leaf && this.ca) {
      const now = this.now();
      const clockOk =
        now >= CLOCK_FLOOR &&
        this.leaf.notBefore.getTime() - now.getTime() < CLOCK_SKEW_TOLERANCE_MS;
      const remaining = this.leaf.notAfter.getTime() - now.getTime();
      if (!clockOk || remaining <= 0) certificateStatus = 'attention';
      else if (remaining < RENEW_LEAF_WITHIN_MS) certificateStatus = 'expiring';
      else certificateStatus = 'valid';
    }

    const config = this.readConfig();
    const meta = readCaMeta(this.deps.directory);
    return {
      enabled,
      state,
      error_code: this.errorCode,
      certificate: {
        status: certificateStatus,
        leaf_not_after: this.leaf?.notAfter.toISOString() ?? null,
        ca_not_after: this.ca?.notAfter.toISOString() ?? null,
        ca_fingerprint_sha256: this.caFingerprints?.sha256 ?? null,
      },
      lan_ips: this.desiredLanIps().filter((ip) => ip !== '127.0.0.1'),
      surfaces,
      ip_change: config.ipChange ?? null,
      // A reset the owner started needs no warning; an unexpected regeneration does.
      ca_regenerated:
        meta?.regeneratedAt && meta.regeneratedBecause && meta.regeneratedBecause !== 'reset'
          ? { reason: meta.regeneratedBecause, at: meta.regeneratedAt }
          : null,
    };
  }

  private createPinnedLoopbackSocket(port: number): tls.TLSSocket {
    if (!this.ca || !this.leaf) {
      throw new Error('TLS certificate material not loaded');
    }
    const expectedLeafDer = this.leaf.der;
    const caCertificateDer = this.ca.certificateDer;
    const caCertificatePem = this.ca.certificatePem;
    // Electron BoringSSL rejects GEN_IPADD Name Constraints during x509_vfy, so loopback diagnostics pin the exact leaf and verify its CA chain directly.
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      servername: 'localhost',
      ca: caCertificatePem,
      rejectUnauthorized: false,
    });
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate(true);
        verifyLoopbackPeerCertificate(peer?.raw, expectedLeafDer, caCertificateDer, this.now());
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return socket;
  }

  private selfRequest(
    port: number,
    requestPath: string,
    useTls: boolean,
  ): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      try {
        const options: https.RequestOptions = {
          host: '127.0.0.1',
          port,
          path: requestPath,
          method: 'GET',
          headers: { Host: 'localhost' },
          timeout: SELF_CHECK_TIMEOUT_MS,
          ...(useTls
            ? {
                servername: 'localhost',
                createConnection: () => this.createPinnedLoopbackSocket(port),
              }
            : { agent: false }),
        };
        const request = useTls ? https.request(options) : http.request(options);
        request.on('response', (response) => {
          response.resume();
          resolve({ status: response.statusCode ?? 0 });
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', reject);
        request.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  private websocketCheck(port: number): Promise<'open' | 'rejected' | 'failed'> {
    return new Promise((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(`wss://127.0.0.1:${port}/kds`, {
          headers: { Host: 'localhost' },
          handshakeTimeout: SELF_CHECK_TIMEOUT_MS,
          createConnection: () => this.createPinnedLoopbackSocket(port),
        });
      } catch {
        resolve('failed');
        return;
      }
      let settled = false;
      const finish = (result: 'open' | 'rejected' | 'failed') => {
        if (settled) return;
        settled = true;
        try {
          socket.terminate();
        } catch {}
        resolve(result);
      };
      socket.on('open', () => finish('open'));
      // A 404 means KDS is switched off: TLS and the upgrade path still worked.
      socket.on('unexpected-response', (_req, res) =>
        finish(res.statusCode === 404 ? 'rejected' : 'failed'),
      );
      socket.on('error', () => finish('failed'));
    });
  }

  async runDiagnostics(): Promise<DiagnosticCheck[]> {
    const checks: DiagnosticCheck[] = [];
    const status = this.getStatus();

    if (!status.enabled) {
      return [{ id: 'https_service', status: 'skipped', code: 'disabled' }];
    }
    if (status.error_code === 'secure_storage_unavailable') {
      return [{ id: 'certificate', status: 'fail', code: 'secure_storage_unavailable' }];
    }

    const desired = this.desiredLanIps();
    checks.push({
      id: 'lan_ip',
      status: sameSet(desired, this.leafIps) ? 'ok' : 'warn',
      code: sameSet(desired, this.leafIps) ? 'lan_ip_ok' : 'lan_ip_changed',
    });

    for (const surface of status.surfaces) {
      checks.push({
        id: 'ports',
        surface: surface.id,
        status: surface.listening ? 'ok' : 'fail',
        code: surface.listening ? 'port_ok' : 'port_unavailable',
      });
    }

    for (const surface of status.surfaces) {
      if (surface.https_port) {
        try {
          await this.selfRequest(surface.https_port, '/api/health', true);
          checks.push({ id: 'https_service', surface: surface.id, status: 'ok', code: 'https_ok' });
        } catch {
          checks.push({
            id: 'https_service',
            surface: surface.id,
            status: 'fail',
            code: 'https_unreachable',
          });
        }
      }
      try {
        const { status: httpStatus } = await this.selfRequest(
          surface.http_port,
          '/api/health',
          false,
        );
        checks.push({
          id: 'backend',
          surface: surface.id,
          status: httpStatus > 0 && httpStatus < 500 ? 'ok' : 'fail',
          code: httpStatus > 0 && httpStatus < 500 ? 'backend_ok' : 'backend_unreachable',
        });
      } catch {
        checks.push({
          id: 'backend',
          surface: surface.id,
          status: 'fail',
          code: 'backend_unreachable',
        });
      }
    }

    for (const surfaceId of ['main', 'kds'] as const) {
      const surface = status.surfaces.find((s) => s.id === surfaceId);
      if (!surface?.https_port) continue;
      const result = await this.websocketCheck(surface.https_port);
      checks.push({
        id: 'websocket',
        surface: surfaceId,
        status: result === 'failed' ? 'fail' : 'ok',
        code: result === 'failed' ? 'websocket_failed' : 'websocket_ok',
      });
    }

    const certificate = status.certificate;
    checks.push({
      id: 'certificate',
      status:
        certificate.status === 'valid' ? 'ok' : certificate.status === 'expiring' ? 'warn' : 'fail',
      code: `certificate_${certificate.status}`,
    });

    if (this.deps.getFirewallState) {
      const firewall = await this.deps.getFirewallState().catch(() => null);
      if (!firewall || !firewall.supported) {
        checks.push({ id: 'firewall', status: 'skipped', code: 'firewall_unsupported' });
      } else {
        checks.push({
          id: 'firewall',
          status:
            firewall.ruleInstalled === true
              ? 'ok'
              : firewall.ruleInstalled === false
                ? 'warn'
                : 'skipped',
          code:
            firewall.ruleInstalled === true
              ? 'firewall_ok'
              : firewall.ruleInstalled === false
                ? 'firewall_rule_missing'
                : 'firewall_unknown',
        });
        let profileStatus: DiagnosticCheck['status'];
        let profileCode: string;
        if (firewall.networkProfile === 'private') {
          profileStatus = 'ok';
          profileCode = 'network_profile_ok';
        } else if (firewall.networkProfile === 'public') {
          profileStatus = 'warn';
          profileCode = 'network_profile_public';
        } else if (firewall.networkProfile === 'domain') {
          profileStatus = 'warn';
          profileCode = 'network_profile_domain';
        } else {
          profileStatus = 'skipped';
          profileCode = 'network_profile_unknown';
        }
        checks.push({
          id: 'network_profile',
          status: profileStatus,
          code: profileCode,
        });
      }
    }

    return checks;
  }
}

let active: SecureNetworkService | null = null;

export function configureSecureNetwork(deps: SecureNetworkDeps): SecureNetworkService {
  active = new SecureNetworkService(deps);
  return active;
}

export function getSecureNetwork(): SecureNetworkService | null {
  return active;
}

export function clearSecureNetworkForTests(): void {
  active = null;
}
