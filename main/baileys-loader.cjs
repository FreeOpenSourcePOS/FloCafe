'use strict';

// Keep native import() in a CommonJS bridge. TypeScript's CommonJS emitter
// rewrites import() expressions in .ts files to require(), which cannot load
// Baileys because it is ESM-only.
exports.loadBaileys = () => import('@whiskeysockets/baileys');
