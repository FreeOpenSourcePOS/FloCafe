import type { BrowserWindow, Menu, MenuItem, WebFrameMain } from 'electron';
import { isCurrentRendererFrame } from './window-readiness';

/** A top-level application-menu entry the Windows/Linux title bar renders. */
export interface ApplicationMenuEntry {
  /** Position of the entry in `Menu.items`; echoed back to open its submenu. */
  key: string;
  label: string;
}

/** The slice of a top-level `MenuItem` a title-bar entry needs. */
export type ApplicationMenuItem = Pick<MenuItem, 'label' | 'type'> &
  Partial<Pick<MenuItem, 'submenu'>>;

/**
 * Describes the top-level menu entries a frameless Windows/Linux title bar can
 * render. Electron never draws a menu bar for a frameless window, so the
 * renderer draws these labels and asks main to pop the real submenu; roles,
 * accelerators, and click handlers stay the ones `createMenu()` already built.
 */
export function listApplicationMenuEntries(
  items: readonly ApplicationMenuItem[],
): ApplicationMenuEntry[] {
  const entries: ApplicationMenuEntry[] = [];
  items.forEach((item, index) => {
    if (item.type === 'separator' || !item.submenu) return;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    if (!label) return;
    entries.push({ key: String(index), label });
  });
  return entries;
}

/**
 * The identity of the window and frame an application-menu request came from,
 * already resolved by the main process.
 */
export interface ApplicationMenuSender {
  /** Window the request came from, or null when it belongs to none. */
  window: BrowserWindow | null;
  /** The sending webContents' current main frame. */
  currentFrame: WebFrameMain | null;
  /** The frame the invoking message was actually delivered to. */
  senderFrame: WebFrameMain | null | undefined;
}

/**
 * The submenu popup is a privileged native surface on the main window, so only
 * that window's own current renderer frame may request one. The localhost
 * origin check alone is not enough: other windows this process serves, such as
 * the KDS window, pass it while belonging to a different window.
 */
export function isApplicationMenuSender(
  mainWindow: BrowserWindow | null,
  sender: ApplicationMenuSender,
): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (sender.window !== mainWindow) return false;
  return isCurrentRendererFrame(sender.senderFrame, sender.currentFrame);
}

/**
 * Menu popup coordinates are relative to the window's content bounds, and
 * Electron reads a negative pair as "open at the cursor", so only the finite
 * non-negative coordinates the renderer measures from a button rect are valid.
 */
function isPopupCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Pops the submenu behind a title-bar entry label. */
export function openApplicationMenuSubmenu(
  menu: Menu | null,
  key: unknown,
  window: BrowserWindow | null,
  x: unknown,
  y: unknown,
): { success: true } | { error: string } {
  if (!menu) return { error: 'Application menu unavailable' };
  if (!window || window.isDestroyed()) return { error: 'Window unavailable' };
  if (typeof key !== 'string' || !/^\d+$/.test(key)) return { error: 'Unknown menu entry' };
  const item = menu.items[Number(key)];
  if (!item) return { error: 'Unknown menu entry' };
  if (!item.submenu) return { error: 'Menu entry has no submenu' };
  if (!isPopupCoordinate(x) || !isPopupCoordinate(y)) return { error: 'Invalid menu position' };
  item.submenu.popup({ window, x, y });
  return { success: true };
}
