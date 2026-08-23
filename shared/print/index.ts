/**
 * Shared print kernel — public surface (#441, epic #438).
 *
 * Consumed by `main/` (compiled into dist), `frontend/` (bundled by Next via
 * the `@print/*` alias), and `tests/`. Purity contract: types + pure
 * functions only — see shared/print/README.md.
 */
export * from './types';
export * from './policy';
export * from './direction';
export * from './bilingual';
export * from './document';
export * from './merchant-template';
