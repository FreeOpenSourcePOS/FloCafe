import { Router, Request, RequestHandler, Response } from 'express';
import { getDatabase } from '../db';
import { importMenu, MenuImportError } from '../pizza/menu-import';
import { readPrices, savePrices } from '../pizza/prices';
import {
  deleteQuickButton,
  findQuickButton,
  listQuickButtons,
  type QuickButtonRow,
  saveQuickButton,
} from '../pizza/quick-buttons';
import { requireAnyPermission, requirePermission } from '../services/authorization';
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

/** Answers a refusal with its own status and message; anything else is a 500. */
function fail(res: Response, error: unknown): void {
  const { statusCode, message } = error as { statusCode?: number; message?: string };
  if (statusCode) {
    res.status(statusCode).json({ error: message });
    return;
  }
  res.locals.postHogError = error;
  console.error('[API] Internal error:', error);
  res.status(500).json({ error: 'Internal server error' });
}

// Every price of the loaded menu, with the menu file's amount beside the one charged.
router.get('/prices', requirePermission('catalog.view'), (_req: Request, res: Response) => {
  try {
    res.json(readPrices(getDatabase()));
  } catch (error) {
    fail(res, error);
  }
});

// Body `{ prices: { "<key>": <amount or null> } }`; null takes the price set in the POS off.
router.put('/prices', requirePermission('catalog.manage'), (req: Request, res: Response) => {
  try {
    res.json(savePrices(getDatabase(), req.body?.prices));
  } catch (error) {
    if (error instanceof MenuImportError) return res.status(400).json({ error: error.message });
    fail(res, error);
  }
});

/** A customer's button is kept by whoever takes orders; a shop-wide one is part of the menu. */
const mayKeepButton = (customerId: unknown) =>
  requirePermission(customerId ? 'orders.create' : 'catalog.manage');

/** The shop's buttons are part of the menu; a customer's say what that customer orders. */
const mayReadButtons: RequestHandler = (req, res, next) =>
  requirePermission('catalog.view')(req, res, () =>
    req.query.customer_id ? requirePermission('orders.create')(req, res, next) : next(),
  );

router.get('/quick-buttons', mayReadButtons, (req: Request, res: Response) => {
  try {
    const { customer_id: customerId } = req.query;
    res.json({
      buttons: listQuickButtons(
        getDatabase(),
        typeof customerId === 'string' ? customerId : undefined,
      ),
    });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/quick-buttons', (req: Request, res: Response) =>
  mayKeepButton(req.body?.customer_id)(req, res, () => {
    try {
      res.status(201).json({ button: saveQuickButton(getDatabase(), req.body ?? {}) });
    } catch (error) {
      fail(res, error);
    }
  }),
);

/**
 * Runs `change` on the stored button when there is one and the user may keep it. Someone who may
 * keep neither kind is refused before the lookup, so the answer does not say whether an id exists.
 */
function withStoredButton(req: Request, res: Response, change: (row: QuickButtonRow) => void) {
  requireAnyPermission('orders.create', 'catalog.manage')(req, res, () => {
    try {
      const row = findQuickButton(getDatabase(), String(req.params.id));
      if (!row) return res.status(404).json({ error: 'That button is no longer saved' });
      mayKeepButton(row.customer_id)(req, res, () => change(row));
    } catch (error) {
      fail(res, error);
    }
  });
}

router.put('/quick-buttons/:id', (req: Request, res: Response) =>
  withStoredButton(req, res, (row) =>
    res.json({ button: saveQuickButton(getDatabase(), req.body ?? {}, row) }),
  ),
);

router.delete('/quick-buttons/:id', (req: Request, res: Response) =>
  withStoredButton(req, res, (row) => {
    deleteQuickButton(getDatabase(), row.id);
    res.json({ success: true });
  }),
);

export { router as pizzaRoutes };
