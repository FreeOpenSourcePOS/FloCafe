/**
 * Title-bar application menu contract (#486 follow-up).
 *
 * The Windows/Linux title bar restores the top-level application menu by
 * rendering the labels the main process built and popping the real submenu,
 * so the descriptor and the popup request are what keep the menu reachable.
 * Runs without Electron: main/application-menu.ts imports Electron types only.
 */
import * as assert from 'node:assert/strict';
import {
  listApplicationMenuEntries,
  openApplicationMenuSubmenu,
  type ApplicationMenuItem,
} from '../main/application-menu';

const submenuItem = (label: string): ApplicationMenuItem => ({
  label,
  type: 'submenu',
  submenu: { popup: () => {} } as never,
});

const menu = [
  submenuItem('File'),
  submenuItem('Edit'),
  { type: 'separator' as const, label: '' },
  submenuItem('Orders'),
  { type: 'submenu' as const, label: '   ' },
  { type: 'normal' as const, label: 'No submenu' },
  submenuItem('Help'),
];

const entries = listApplicationMenuEntries(menu);
assert.deepEqual(entries, [
  { key: '0', label: 'File' },
  { key: '1', label: 'Edit' },
  { key: '3', label: 'Orders' },
  { key: '6', label: 'Help' },
], 'keys address Menu.items so separators, blank labels, and submenu-less items are skipped');

assert.deepEqual(listApplicationMenuEntries([]), []);

let popupCalls: unknown[] = [];
const popupMenu = {
  items: [
    { label: 'File', type: 'submenu', submenu: { popup: (options: unknown) => popupCalls.push(options) } },
  ],
};
const liveWindow = { isDestroyed: () => false };
const destroyedWindow = { isDestroyed: () => true };

const open = (key: unknown, window: unknown, x: unknown, y: unknown) =>
  openApplicationMenuSubmenu(popupMenu as never, key, window as never, x, y);

assert.deepEqual(open('0', liveWindow, 12, 0), { success: true });
assert.equal(popupCalls.length, 1);
assert.deepEqual(popupCalls[0], { window: liveWindow, x: 12, y: 0 });
assert.equal(
  popupCalls.length,
  1,
  'a successful open pops the submenu main built, so roles/accelerators/click handlers stay intact',
);

assert.deepEqual(open('99', liveWindow, 0, 0), { error: 'Unknown menu entry' });
assert.deepEqual(open('../0', liveWindow, 0, 0), { error: 'Unknown menu entry' });
assert.deepEqual(open('abc', liveWindow, 0, 0), { error: 'Unknown menu entry' });
assert.deepEqual(open(null, liveWindow, 0, 0), { error: 'Unknown menu entry' });
assert.deepEqual(open(0, liveWindow, 0, 0), { error: 'Unknown menu entry' });
assert.deepEqual(open('0', destroyedWindow, 0, 0), { error: 'Window unavailable' });
assert.deepEqual(open('0', null, 0, 0), { error: 'Window unavailable' });
assert.deepEqual(
  openApplicationMenuSubmenu(null, '0', liveWindow as never, 0, 0),
  { error: 'Application menu unavailable' },
);
assert.equal(popupCalls.length, 1, 'rejected requests never pop anything');

// Electron reads a negative pair as "open at the cursor"; the renderer always
// sends a measured button rect, so a negative coordinate is a client bug.
for (const [x, y] of [[-1, 0], [0, -1], [Number.NaN, 0], ['0', 0], [null, 0], [0, undefined]]) {
  assert.deepEqual(open('0', liveWindow, x, y), { error: 'Invalid menu position' });
}
assert.equal(popupCalls.length, 1);

console.log('menu-surface: application menu surface contract OK');
