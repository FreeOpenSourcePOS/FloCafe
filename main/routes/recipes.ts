import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';
import { deleteRecipe, getRecipeByProduct, listRecipes, saveRecipe } from '../services/recipes';

const router = Router();

function sendError(res: Response, error: unknown): void {
  const details = error as { statusCode?: unknown; message?: unknown };
  const statusCode = Number.isInteger(details.statusCode) ? details.statusCode as number : 500;
  if (statusCode >= 500) console.error('[API] Internal error:', error);
  res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal server error' : details.message });
}

router.get('/', requirePermission('supplies.manage'), (_req: Request, res: Response) => {
  try {
    res.json({ recipes: listRecipes(getDatabase()) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/product/:productId', requirePermission('supplies.manage'), (req: Request, res: Response) => {
  try {
    const recipe = getRecipeByProduct(getDatabase(), String(req.params.productId));
    res.json({ recipe });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.put('/product/:productId', requirePermission('supplies.manage'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const recipe = saveRecipe(getDatabase(), {
      productId: String(req.params.productId),
      yieldQuantity: body.yield_quantity,
      isActive: body.is_active,
      items: body.items,
    });
    res.json({ recipe });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.delete('/product/:productId', requirePermission('supplies.manage'), (req: Request, res: Response) => {
  try {
    deleteRecipe(getDatabase(), String(req.params.productId));
    res.json({ success: true });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const recipeRoutes = router;
