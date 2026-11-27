import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { asyncHandler } from '../middleware/async-handler';
import { requireMasterPin } from '../middleware/master-pin';
import { requirePermission } from '../services/authorization';
import { getHttpsPort, getServerPort } from '../server-state';
import {
  getSecureNetwork,
  type SecureNetworkStatus,
  type SurfaceId,
} from '../security/lan-tls/secure-network';
import { isPermittedLanIPv4 } from '../security/lan-tls/x509';
import { installFirewallRuleElevated } from '../security/lan-tls/windows-firewall';

const router = Router();

const MDNS_HOST = 'flo.local';

function withPort(host: string, port: number): string {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

interface SurfaceAddresses {
  id: SurfaceId;
  label: string;
  listening: boolean;
  https_port: number | null;
  primary_url: string | null;
  fallback_urls: string[];
  error_code: string | null;
}

export function buildSurfaceAddresses(
  status: SecureNetworkStatus,
  lanIps: string[],
): SurfaceAddresses[] {
  const ips = lanIps.filter(isPermittedLanIPv4);
  return status.surfaces.map((surface) => ({
    id: surface.id,
    label: surface.label,
    listening: surface.listening,
    https_port: surface.https_port,
    primary_url: surface.https_port ? withPort(MDNS_HOST, surface.https_port) : null,
    fallback_urls: surface.https_port
      ? ips.map((ip) => withPort(ip, surface.https_port as number))
      : [],
    error_code: surface.error_code,
  }));
}

/** Runs `action` once after the response completes or the connection drops, whichever comes first. */
function afterResponse(res: Response, action: () => Promise<void>): void {
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    void action().catch(logLifecycleFailure);
  };
  res.once('finish', run);
  res.once('close', run);
}

function logLifecycleFailure(error: unknown): void {
  console.error('[SecureNetwork] Lifecycle action failed:', error);
}

function unavailable(res: Response): void {
  res.status(503).json({ error: 'Secure Network is not available in this mode.' });
}

// ── Public: only ever the public CA certificate and its fingerprints ───────────────────────────
router.get('/ca.cer', (_req: Request, res: Response) => {
  const ca = getSecureNetwork()?.getPublicCa();
  if (!ca) return void res.status(404).json({ error: 'No certificate available' });
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="FloCafe-Local-CA.cer"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(ca.der);
});

router.get('/ca.pem', (_req: Request, res: Response) => {
  const ca = getSecureNetwork()?.getPublicCa();
  if (!ca) return void res.status(404).json({ error: 'No certificate available' });
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', 'attachment; filename="FloCafe-Local-CA.pem"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(ca.pem);
});

// No fingerprint here: a value fetched over the same unauthenticated HTTP connection as the
// certificate proves nothing. The owner compares the device's fingerprint with the host screen.
router.get('/trust-info', (_req: Request, res: Response) => {
  const ca = getSecureNetwork()?.getPublicCa();
  if (!ca) return void res.status(404).json({ error: 'No certificate available' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ https_port: getHttpsPort() });
});

// ── Authenticated: settings.manage ─────────────────────────────────────────────────────────────
router.get(
  '/status',
  requirePermission('settings.manage'),
  asyncHandler(async (_req: Request, res: Response) => {
    const service = getSecureNetwork();
    if (!service) return unavailable(res);
    const status = service.getStatus();
    const lanIps = service.getCertifiedLanIps();
    const surfaces = buildSurfaceAddresses(status, lanIps);
    const main = surfaces.find((s) => s.id === 'main');

    const trustHost = lanIps.find(isPermittedLanIPv4) ?? null;
    const trustUrl =
      status.enabled && status.certificate.ca_fingerprint_sha256 && trustHost
        ? `http://${trustHost}:${getServerPort()}/trust`
        : null;
    const accessUrl = main?.fallback_urls[0] ?? main?.primary_url ?? null;

    const toQr = async (value: string | null): Promise<string | null> => {
      if (!value) return null;
      try {
        return await QRCode.toDataURL(value, { errorCorrectionLevel: 'M', width: 256 });
      } catch {
        return null;
      }
    };

    res.json({
      ...status,
      surfaces,
      trust_url: trustUrl,
      trust_qr_data_url: await toQr(trustUrl),
      access_url: accessUrl,
      access_qr_data_url: await toQr(accessUrl),
    });
  }),
);

router.put(
  '/enabled',
  requirePermission('settings.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const service = getSecureNetwork();
    if (!service) return unavailable(res);
    if (typeof req.body?.enabled !== 'boolean') {
      return void res.status(400).json({ error: 'enabled must be a boolean' });
    }
    // Answer before restarting: a request that arrived over HTTPS would otherwise keep its own front open.
    const enabled: boolean = req.body.enabled;
    try {
      service.saveEnabled(enabled);
    } catch (error) {
      logLifecycleFailure(error);
      return void res.status(500).json({ error: 'Could not save the setting' });
    }
    res.json({ success: true, enabled });
    afterResponse(res, () => service.applyEnabled());
  }),
);

router.post(
  '/diagnostics',
  requirePermission('settings.manage'),
  asyncHandler(async (_req: Request, res: Response) => {
    const service = getSecureNetwork();
    if (!service) return unavailable(res);
    res.json({ checks: await service.runDiagnostics() });
  }),
);

router.post(
  '/repair',
  requirePermission('settings.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const service = getSecureNetwork();
    if (!service) return unavailable(res);
    let firewallFixed: boolean | null = null;
    // Elevation is only ever requested by an explicit click, never at startup.
    if (req.body?.fix_firewall === true && process.platform === 'win32') {
      firewallFixed = await installFirewallRuleElevated(process.execPath);
    }
    res.json({ success: true, firewall_fixed: firewallFixed });
    afterResponse(res, () => service.repair());
  }),
);

router.post(
  '/acknowledge',
  requirePermission('settings.manage'),
  (_req: Request, res: Response) => {
    const service = getSecureNetwork();
    if (!service) return unavailable(res);
    service.acknowledgeNotices();
    res.json({ success: true });
  },
);

router.post(
  '/reset',
  requirePermission('settings.manage'),
  requireMasterPin,
  asyncHandler(async (_req: Request, res: Response) => {
    const service = getSecureNetwork();
    if (!service) return unavailable(res);
    res.json({ success: true });
    afterResponse(res, () => service.resetAuthority());
  }),
);

export const secureNetworkRoutes = router;
