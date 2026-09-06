/** Returns POS local network access URLs (mDNS and local IP) for QR code generation. */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { getLocalIP, getAllLocalIPs, getServerPort } from '../server';
import { asyncHandler } from '../middleware/async-handler';

const router = Router();

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const port = getServerPort();
  const ip = getLocalIP();
  const allIps = getAllLocalIPs();

  const mdnsUrl = `http://flo.local:${port}`;
  const ipUrl   = `http://${ip}:${port}`;
  const qrUrl   = ipUrl;

  const ipsData = await Promise.all(allIps.map(async (localIp) => {
    const url = `http://${localIp}:${port}`;
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
    console.warn('[POS-Info] QR generation failed:', err);
  }

  res.json({
    mdns_url:    mdnsUrl,
    ip_url:      ipUrl,
    qr_url:      qrUrl,
    qr_data_url: qrDataUrl,
    ips_data:    ipsData,
  });
}));

export const posInfoRoutes = router;
