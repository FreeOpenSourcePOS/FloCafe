/** The guard on the places that add a product through upstream's dialog, which cannot build a recipe. */
import toast from 'react-hot-toast';
import { needsPizzaScreen } from './sent-line';

/**
 * True, with `message` saying where to add it, for a half and half or a deal:
 * the server refuses either without its recipe. False for any other product,
 * which is added as before.
 */
export function sentToPos(product: { id: string }, message: string): boolean {
  if (!needsPizzaScreen(product.id)) return false;
  toast(message, { icon: 'ℹ️' });
  return true;
}
