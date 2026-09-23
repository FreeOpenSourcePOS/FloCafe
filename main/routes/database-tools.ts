import { Router, Request, Response } from 'express';
import { resetDatabaseWithBackup, resetDatabaseForCurrencyChange, getCurrencyResetImpact, listBackups, deleteBackup, getCurrentSchemaVersion } from '../db';
import { clearInMemoryRevokedTokens, clearUserAuthCache, requireRole } from '../middleware/security';
import { requireMasterPin } from '../middleware/master-pin';
import { asyncHandler } from '../middleware/async-handler';
import { runHealthCheck, applySafeFixes } from '../services/schema-health';
import { isMasterPinAvailable, isMasterPinSet, resetMasterPin } from '../services/master-pin';
import { clearJWTSecretCache } from './auth';
import { getHttpRequestSignal } from '../shutdown';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { googleDrive } from '../services/google-drive';
import { isSupportedCurrencyCode } from '../../shared/currencies';

const router = Router();

// Read-only / additive-only — not master-PIN gated, only owner-gated.
router.get('/health-check', requireRole(...ROLE_ACCESS.owner), (_req: Request, res: Response) => {
  try {
    res.json(runHealthCheck());
  } catch (error: any) {
    console.error('[DB Tools] health-check error:', error);
    res.status(500).json({ error: 'Health check failed' });
  }
});

router.post('/apply-safe-fixes', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { findingIds?: unknown };
    const { findingIds } = body;
    if (findingIds !== undefined && (!Array.isArray(findingIds) || findingIds.some((id) => typeof id !== 'string'))) {
      return res.status(400).json({ error: 'findingIds must be an array of finding id strings' });
    }
    res.json(applySafeFixes(findingIds as string[] | undefined));
  } catch (error: any) {
    console.error('[DB Tools] apply-safe-fixes error:', error);
    res.status(500).json({ error: 'Applying fixes failed' });
  }
});

// Read-only listing of the managed backups/ directory (#120). Not master-PIN
// gated — same read-only rationale as /health-check.
router.get('/backups', requireRole(...ROLE_ACCESS.owner), (_req: Request, res: Response) => {
  try {
    res.json({ backups: listBackups() });
  } catch (error: any) {
    console.error('[DB Tools] list backups error:', error);
    res.status(500).json({ error: 'Listing backups failed' });
  }
});

// Deletes one backup from the managed backups directory, protected by Master PIN.
router.post('/backups/:fileName/delete', requireRole(...ROLE_ACCESS.owner), requireMasterPin, (req: Request, res: Response) => {
  try {
    deleteBackup(req.params.fileName as string);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[DB Tools] delete backup error:', error);
    if (error?.code === 'ERR_INVALID_BACKUP_NAME') {
      return res.status(400).json({ error: 'Invalid backup file name' });
    }
    if (error?.code === 'ERR_BACKUP_NOT_FOUND') {
      return res.status(404).json({ error: 'Backup not found' });
    }
    res.status(500).json({ error: 'Deleting backup failed' });
  }
});

router.get('/master-pin/status', requireRole(...ROLE_ACCESS.owner), (_req: Request, res: Response) => {
  res.json({ available: isMasterPinAvailable(), isSet: isMasterPinSet(), schemaVersion: getCurrentSchemaVersion() });
});

router.post('/master-pin/reset', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  const { pin, confirm_pin } = req.body as { pin?: string; confirm_pin?: string };
  const cleanPin = String(pin || '').trim();
  if (!/^\d{4}$/.test(cleanPin)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  }
  if (cleanPin !== confirm_pin) {
    return res.status(400).json({ error: 'PINs do not match' });
  }
  if (!isMasterPinAvailable()) {
    return res.status(409).json({ error: 'Master PIN is not available on this device' });
  }
  try {
    resetMasterPin(cleanPin);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[DB Tools] set Master PIN error:', error);
    res.status(500).json({ error: 'Failed to set Master PIN' });
  }
});

const INITIALIZE_CONFIRM_PHRASE = 'INITIALIZE';

router.get('/currency-reset-impact', requireRole(...ROLE_ACCESS.owner), (_req: Request, res: Response) => {
  try {
    res.json(getCurrencyResetImpact());
  } catch (error: any) {
    console.error('[DB Tools] currency reset impact error:', error);
    res.status(500).json({ error: 'Could not inspect currency reset impact' });
  }
});

router.post('/currency-reset', requireRole(...ROLE_ACCESS.owner), requireMasterPin, asyncHandler(async (req: Request, res: Response) => {
  const currency = typeof req.body?.currency === 'string' ? req.body.currency.trim().toUpperCase() : '';
  if (!isSupportedCurrencyCode(currency)) {
    return res.status(400).json({ error: 'Invalid or unsupported currency' });
  }

  const impact = getCurrencyResetImpact();
  if (!impact.currentCurrency) {
    return res.status(409).json({ error: 'Store currency is not configured' });
  }
  if (impact.currentCurrency === currency) {
    return res.status(409).json({ error: 'The selected currency is already active' });
  }
  if (req.body?.current_currency !== impact.currentCurrency) {
    return res.status(409).json({ error: 'The active currency changed. Reload settings and try again.' });
  }

  const confirmationPhrase = `CHANGE TO ${currency}`;
  if (req.body?.confirmation_phrase !== confirmationPhrase) {
    return res.status(400).json({ error: `Type "${confirmationPhrase}" to confirm` });
  }

  try {
    await googleDrive.prepareForDatabaseRestore();
    const result = await resetDatabaseForCurrencyChange(currency, getHttpRequestSignal(req));
    const cleanup = googleDrive.completeDatabaseRestore();
    clearUserAuthCache();
    clearInMemoryRevokedTokens();
    clearJWTSecretCache();
    res.json({
      success: true,
      currency,
      backupPath: result.backupPath,
      cleanupPending: result.cleanupPending || cleanup.cleanupPending,
    });
  } catch (error: any) {
    console.error('[DB Tools] currency reset error:', error);
    res.status(500).json({ error: 'Currency reset failed' });
  } finally {
    googleDrive.releaseDatabaseRestore();
  }
}));

router.post('/initialize', requireRole(...ROLE_ACCESS.owner), requireMasterPin, asyncHandler(async (req: Request, res: Response) => {
  if (req.body?.confirmation_phrase !== INITIALIZE_CONFIRM_PHRASE) {
    return res.status(400).json({ error: `Type "${INITIALIZE_CONFIRM_PHRASE}" to confirm` });
  }
  try {
    await googleDrive.prepareForDatabaseRestore();
    const { backupPath } = await resetDatabaseWithBackup(getHttpRequestSignal(req));
    const cleanup = googleDrive.completeDatabaseRestore();
    clearUserAuthCache();
    clearInMemoryRevokedTokens();
    clearJWTSecretCache();
    res.json({ success: true, backupPath, cleanupPending: cleanup.cleanupPending });
  } catch (error: any) {
    console.error('[DB Tools] initialize error:', error);
    res.status(500).json({ error: 'Initialize failed' });
  } finally {
    googleDrive.releaseDatabaseRestore();
  }
}));

export const databaseToolsRoutes = router;
