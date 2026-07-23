import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import { getDbPath, createBackup, closeDatabase, initDatabase, listBackups, deleteBackup } from '../db';
import { requireRole } from '../middleware/security';
import { requireMasterPin } from '../middleware/master-pin';
import { runHealthCheck, applySafeFixes } from '../services/schema-health';
import { isMasterPinAvailable, isMasterPinSet, resetMasterPin } from '../services/master-pin';

const router = Router();

// Read-only / additive-only — not master-PIN gated, only owner-gated.
router.get('/health-check', requireRole('owner'), (_req: Request, res: Response) => {
  try {
    res.json(runHealthCheck());
  } catch (error: any) {
    console.error('[DB Tools] health-check error:', error);
    res.status(500).json({ error: 'Health check failed' });
  }
});

router.post('/apply-safe-fixes', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const { findingIds } = req.body as { findingIds?: string[] };
    res.json(applySafeFixes(findingIds));
  } catch (error: any) {
    console.error('[DB Tools] apply-safe-fixes error:', error);
    res.status(500).json({ error: 'Applying fixes failed' });
  }
});

// Read-only listing of the managed backups/ directory (#120). Not master-PIN
// gated — same read-only rationale as /health-check.
router.get('/backups', requireRole('owner'), (_req: Request, res: Response) => {
  try {
    res.json({ backups: listBackups() });
  } catch (error: any) {
    console.error('[DB Tools] list backups error:', error);
    res.status(500).json({ error: 'Listing backups failed' });
  }
});

// Deletes one backup from the managed backups/ directory (#120) — same
// master-PIN gate as creating one, since a backup is the safety net a
// restore/initialize depends on.
router.post('/backups/:fileName/delete', requireRole('owner'), requireMasterPin, (req: Request, res: Response) => {
  try {
    deleteBackup(req.params.fileName);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[DB Tools] delete backup error:', error);
    res.status(400).json({ error: 'Deleting backup failed' });
  }
});

router.get('/master-pin/status', requireRole('owner'), (_req: Request, res: Response) => {
  res.json({ available: isMasterPinAvailable(), isSet: isMasterPinSet() });
});

router.post('/master-pin/reset', requireRole('owner'), (req: Request, res: Response) => {
  const { pin, confirm_pin } = req.body as { pin?: string; confirm_pin?: string };
  if (!/^\d{4}$/.test(String(pin || ''))) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  }
  if (pin !== confirm_pin) {
    return res.status(400).json({ error: 'PINs do not match' });
  }
  if (!isMasterPinAvailable()) {
    return res.status(409).json({ error: 'Master PIN is not available on this device' });
  }
  try {
    resetMasterPin(pin!);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[DB Tools] set Master PIN error:', error);
    res.status(500).json({ error: 'Failed to set Master PIN' });
  }
});

const INITIALIZE_CONFIRM_PHRASE = 'INITIALIZE';

router.post('/initialize', requireRole('owner'), requireMasterPin, async (req: Request, res: Response) => {
  if (req.body?.confirmation_phrase !== INITIALIZE_CONFIRM_PHRASE) {
    return res.status(400).json({ error: `Type "${INITIALIZE_CONFIRM_PHRASE}" to confirm` });
  }
  try {
    const { path: backupPath } = await createBackup();

    closeDatabase();
    const dbPath = getDbPath();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    // master-pin.enc lives in userData/, separate from flo.db — untouched by design,
    // so a locked-out owner can still authorize this even after the wipe.
    initDatabase();

    res.json({ success: true, backupPath });
  } catch (error: any) {
    console.error('[DB Tools] initialize error:', error);
    res.status(500).json({ error: 'Initialize failed' });
  }
});

export const databaseToolsRoutes = router;
