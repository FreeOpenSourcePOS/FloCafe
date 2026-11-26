import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { importMenu, MenuImportError } from '../pizza/menu-import';
import { requirePermission } from '../services/authorization';
import { MenuError, parseMenuFile } from '../../shared/pizza/menu';

const router = Router();

// The body is the shop's menu file. It is parsed whole before anything is written.
router.post(
  '/menu/import',
  requirePermission('catalog.import-export'),
  (req: Request, res: Response) => {
    try {
      res.json(importMenu(getDatabase(), parseMenuFile(req.body)));
    } catch (error) {
      if (error instanceof MenuError) {
        return res.status(400).json({ error: error.message, path: error.path });
      }
      if (error instanceof MenuImportError) return res.status(400).json({ error: error.message });
      res.locals.postHogError = error;
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get('/catalog', requirePermission('catalog.view'), (_req: Request, res: Response) => {
  try {
    const row = getDatabase().prepare('SELECT catalog FROM pizza_menu WHERE id = 1').get() as
      | { catalog: string }
      | undefined;
    if (!row) return res.status(404).json({ error: 'No menu has been loaded' });
    res.type('json').send(row.catalog);
  } catch (error) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as pizzaRoutes };
