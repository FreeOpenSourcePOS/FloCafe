/**
 * GET /api/kds-info
 * Returns the KDS access URLs (mDNS + local IP) so the POS UI can render a QR code.
 * The tablet/display on the same network opens either URL in a browser.
 */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { getLocalIP, getAllLocalIPs } from '../server';
import { getKdsPort } from '../kds-server';
import { requireKdsEnabled } from '../middleware/security';

const router = Router();

router.use(requireKdsEnabled);

router.get('/', async (_req: Request, res: Response) => {
  const kdsPort = getKdsPort();
  const ip = getLocalIP();
  const allIps = getAllLocalIPs();

  const mdnsUrl = `http://flo.local:${kdsPort}`;
  const ipUrl   = `http://${ip}:${kdsPort}`;
  const qrUrl   = ipUrl;

  const ipsData = await Promise.all(allIps.map(async (localIp) => {
    const url = `http://${localIp}:${kdsPort}`;
    try {
      const qr_data = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 256 });
      return { ip: localIp, url, qr_data };
    } catch {
      return { ip: localIp, url, qr_data: null };
    }
  }));

  let qrDataUrl: string | null = null;
  try {
    qrDataUrl = await QRCode.toDataURL(qrUrl, { errorCorrectionLevel: 'M', width: 256 });
  } catch (err) {
    console.warn('[KDS-Info] QR generation failed:', err);
  }

  res.json({
    mdns_url:    mdnsUrl,
    ip_url:      ipUrl,
    qr_url:      qrUrl,
    qr_data_url: qrDataUrl,
    ips_data:    ipsData,
  });
});

export const kdsInfoRoutes = router;

