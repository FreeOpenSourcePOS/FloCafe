/**
 * GET /api/more-apps
 * Returns the catalog of companion apps shown on the Settings → More Apps
 * tab, with a QR code per store link so a phone can scan-to-download
 * instead of typing a URL.
 *
 * RevFlo is deliberately not in this generic catalog — it gets its own
 * consolidated section in Settings → Integrations (QR/download + pairing
 * code + paired devices) via GET /api/more-apps/revflo below, instead of
 * being split across the generic apps grid and the Account tab.
 *
 * Store links are filled in once each app actually has a published
 * listing — update MORE_APPS below when that happens, no schema change needed.
 */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';

const router = Router();

type AppEntry = {
  id: string;
  name: string;
  tagline: string;
  iosUrl: string | null;
  androidUrl: string | null;
  landingUrl?: string | null;
};

const MORE_APPS: AppEntry[] = [];

const REVFLO_APP: AppEntry = {
  id: 'revflo',
  name: 'RevFlo',
  tagline: 'See live sales, daily summaries, and reports for your store from your phone.',
  iosUrl: null,
  androidUrl: null,
  landingUrl: 'https://flopos.com',
};

async function toAppResponse(app: AppEntry) {
  const primaryUrl = app.iosUrl || app.androidUrl || app.landingUrl || null;
  let qrDataUrl: string | null = null;
  if (primaryUrl) {
    try {
      qrDataUrl = await QRCode.toDataURL(primaryUrl, { errorCorrectionLevel: 'M', width: 256 });
    } catch (err) {
      console.warn(`[MoreApps] QR generation failed for ${app.id}:`, err);
    }
  }
  return {
    id: app.id,
    name: app.name,
    tagline: app.tagline,
    ios_url: app.iosUrl,
    android_url: app.androidUrl,
    landing_url: app.landingUrl || null,
    qr_data_url: qrDataUrl,
    available: Boolean(primaryUrl),
  };
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const apps = await Promise.all(MORE_APPS.map(toAppResponse));
    res.json({ apps });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/more-apps/revflo — backs the consolidated RevFlo card in
// Settings → Integrations (see AppEntry note above).
router.get('/revflo', async (_req: Request, res: Response) => {
  try {
    res.json({ app: await toAppResponse(REVFLO_APP) });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const moreAppsRoutes = router;
