import * as crypto from 'node:crypto';

/**
 * A restore source is a filesystem path chosen by the operator in a native
 * dialog that only the main process can show. The dialog result is held here and
 * handed to the HTTP restore route as a single-use token, so a renderer that
 * asks to restore an arbitrary path it invented is refused: the only path the
 * route will accept is one the operator just picked in that dialog.
 */

let pendingSelection: { path: string; token: string } | null = null;

export function rememberRestoreFileSelection(selectedPath: string): { path: string; token: string } {
  const selection = { path: selectedPath, token: crypto.randomBytes(32).toString('hex') };
  pendingSelection = selection;
  return selection;
}

export function clearRestoreFileSelection(): void {
  pendingSelection = null;
}

/** Returns the picked path once for a matching token, otherwise null. */
export function consumeRestoreFileSelection(token: string): string | null {
  const selection = pendingSelection;
  if (!selection || !token) return null;
  const presented = Buffer.from(token, 'utf8');
  const expected = Buffer.from(selection.token, 'utf8');
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return null;
  pendingSelection = null;
  return selection.path;
}
