/** Counters behind the error-report card, mounted before the settings wildcard. */

import { Router, Request, Response } from 'express';
import { requirePermission } from '../services/authorization';
import {
  dismissDiagnosticsPrompt,
  readDiagnosticsPromptState,
  recordDiagnosticsPromptShown,
} from '../services/diagnostics-prompt';

export const diagnosticsPromptRoutes = Router();

function fail(res: Response, error: unknown) {
  res.locals.postHogError = error;
  console.error('[API] Internal error:', error);
  res.status(500).json({ error: 'Internal server error' });
}

diagnosticsPromptRoutes.get(
  '/',
  requirePermission('settings.manage'),
  (_req: Request, res: Response) => {
    try {
      res.json(readDiagnosticsPromptState());
    } catch (error) {
      fail(res, error);
    }
  },
);

diagnosticsPromptRoutes.post(
  '/',
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      const event = req.body?.event;
      if (event === 'shown') {
        res.json(recordDiagnosticsPromptShown());
        return;
      }
      if (event === 'dismissed') {
        res.json(dismissDiagnosticsPrompt());
        return;
      }
      res.status(400).json({ error: 'event must be "shown" or "dismissed"' });
    } catch (error) {
      fail(res, error);
    }
  },
);
