/**
 * GET /api/server-app-info
 * Returns Server App access URLs so Settings can render QR codes for tablets
 * and phones on the same local network.
 */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { getLocalIP, getAllLocalIPs } from '../server';
import { getServerAppPort } from '../server-app-state';
import { isServerAppEnabled } from '../db';
import { asyncHandler } from '../middleware/async-handler';

const router = Router();

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  if (!isServerAppEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const port = getServerAppPort();
    const ip = getLocalIP();
    const allIps = getAllLocalIPs();

    const mdnsUrl = `http://flo.local:${port}`;
    const ipUrl = `http://${ip}:${port}`;
    const ipsData = await Promise.all(allIps.map(async (localIp) => {
      const url = `http://${localIp}:${port}`;
      try {
        const qr_data = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 256 });
        return { ip: localIp, url, qr_data };
      } catch {
        return { ip: localIp, url, qr_data: null };
      }
    }));

    const primaryIpData = ipsData.find((entry) => entry.ip === ip);

    res.json({
      mdns_url: mdnsUrl,
      ip_url: ipUrl,
      qr_url: ipUrl,
      qr_data_url: primaryIpData?.qr_data ?? null,
      ips_data: ipsData,
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}));

export const serverAppInfoRoutes = router;
