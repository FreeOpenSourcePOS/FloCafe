/**
 * RTL/LTR Dashboard, POS, and common flow regression test (Batch E, Refs #241).
 *
 * Builds on the shared direction foundation guarded by `rtl-foundation.test.ts`
 * (Batch C) and the Setup/Auth/Settings guard `rtl-setup-auth-settings.test.ts`
 * (Batch D), and extends the same guarantees to the core merchant/cashier
 * operational screens:
 *
 *   - dashboard
 *   - POS ordering, cart, product grid, customer search, held orders
 *   - products/categories (and the product image uploader)
 *   - customers, tables
 *   - orders / bills / order detail (incl. split check)
 *   - checkout / payment flows (payment + prepaid checkout modals)
 *   - shared operational components
 *
 *   1. These screens must not use physical left/right utilities for
 *      content-flow layout (margin, padding, alignment, borders, rounding,
 *      positioning). The shared logical equivalents (`ms/me/ps/pe/start/end/
 *      text-start/text-end/border-s/border-e/rounded-s/rounded-e`) render
 *      identically in LTR and mirror under `dir="rtl"`, so any remaining
 *      physical utility is a regression.
 *
 *   2. Directional icons (`ArrowLeft`/`ArrowRight`/`ChevronLeft`/
 *      `ChevronRight`) must carry the shared `.rtl-flip` class so they
 *      mirror under `[dir="rtl"]` (e.g. the dashboard "view all" arrows and
 *      the expandable tax / print-history chevrons).
 *
 *   3. An icon rendered BEFORE its label/text (e.g. `<Plus size={16} ... />
 *      Add product`) needs the gap on its inline-end side, so it must use the
 *      logical `me-*` margin — never `ms-*`, which would put the gap on the
 *      wrong side and change the LTR layout. (This is the `mr-*` → `me-*`
 *      mapping; `ml-*` → `ms-*` remains correct for icons rendered AFTER
 *      their label, like sort/chevron icons.)
 *
 * Run: npm run test:rtl-dashboard-pos-common
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');

/** Batch E screen files that must use logical direction utilities. */
const SCREEN_FILES = [
  'frontend/src/app/(dashboard)/pos/page.tsx',
  'frontend/src/app/(dashboard)/dashboard/page.tsx',
  'frontend/src/app/(dashboard)/orders/page.tsx',
  'frontend/src/app/(dashboard)/products/page.tsx',
  'frontend/src/app/(dashboard)/customers/page.tsx',
  'frontend/src/app/(dashboard)/tables/page.tsx',
  'frontend/src/components/pos/CartPanel.tsx',
  'frontend/src/components/pos/ProductGrid.tsx',
  'frontend/src/components/pos/PosTopbar.tsx',
  'frontend/src/components/pos/TaxBreakdown.tsx',
  'frontend/src/components/pos/PaymentModal.tsx',
  'frontend/src/components/pos/PrepaidCheckoutModal.tsx',
  'frontend/src/components/pos/TablePickerModal.tsx',
  'frontend/src/components/pos/TableCheckoutModal.tsx',
  'frontend/src/components/pos/AddonModal.tsx',
  'frontend/src/components/pos/CustomerSearch.tsx',
  'frontend/src/components/pos/EditCustomerModal.tsx',
  'frontend/src/components/pos/PrinterStatus.tsx',
  'frontend/src/components/pos/SplitCheckModal.tsx',
  'frontend/src/components/orders/OrderHistoryGrid.tsx',
  'frontend/src/components/products/ImageUploader.tsx',
];

/**
 * Physical directional utilities that must be converted to logical ones in the
 * batch screens. Same rule set as the shared foundation and Batch D tests.
 */
const PHYSICAL_UTIL_RE =
  /\b(ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|left|right)-[0-9a-zA-Z.]+|\btext-(left|right)\b/g;

/**
 * Per-file allowlist of physical utilities that are genuinely intentional.
 * Currently empty: every physical utility found in the batch was converted to
 * its logical equivalent. If a future change introduces a genuinely physical
 * case (e.g. a fixed-position overlay pinned to a physical corner), it must be
 * listed here with a comment explaining why it stays physical.
 */
const ALLOWLIST: Record<string, string[]> = {};

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function run(): void {
  console.log('RTL/LTR Dashboard, POS, and common flow checks:');

  // 1. Batch screens use logical direction utilities (or are allowlisted).
  let totalPhysical = 0;
  for (const file of SCREEN_FILES) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const matches = src.match(PHYSICAL_UTIL_RE) ?? [];
    const allowed = ALLOWLIST[path.basename(file)] ?? [];
    const violations = matches.filter((m) => !allowed.includes(m));
    if (violations.length) {
      console.error(`\nPhysical direction utilities in ${file}:`);
      for (const v of violations) console.error(`  - ${v}`);
      assert(false, `physical direction utilities remain in ${file}`);
    }
    totalPhysical += matches.length;
  }
  console.log(`  ✓ batch screens use logical direction utilities (${totalPhysical} allowlisted physical cases)`);

  // 2. Directional icons carry `.rtl-flip`.
  const iconFiles = SCREEN_FILES.filter((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /\b(ArrowLeft|ArrowRight|ChevronLeft|ChevronRight)\b/.test(src);
  });
  for (const file of iconFiles) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Only flag JSX usage (`<Arrow…`, `<Chevron…`), not the lucide import statement.
      if (/<(ArrowLeft|ArrowRight|ChevronLeft|ChevronRight)\b/.test(line) && !line.includes('rtl-flip')) {
        assert(false, `${file}:${i + 1} uses a directional icon without rtl-flip: ${line.trim()}`);
      }
    });
  }
  console.log(`  ✓ directional icons carry rtl-flip (${iconFiles.length} file(s) with directional icons)`);

  // 3. Icons rendered before their label must use `me-*` (inline-end), never
  //    `ms-*` (inline-start). Match a lucide icon component with an `ms-*`
  //    class that is immediately followed by text/expression on the same line.
  const iconBeforeTextRe =
    /<[A-Z][A-Za-z]*\s+size=\{[0-9]+\}\s+className="[^"]*\bms-[0-9][^"]*"\s*\/>\s*(?:\{|[A-Za-z]|["'])/g;
  for (const file of SCREEN_FILES) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (iconBeforeTextRe.test(line)) {
        assert(false, `${file}:${i + 1} icon-before-text uses ms-* (inline-start) instead of me-*: ${line.trim()}`);
      }
    });
  }
  console.log('  ✓ icon-before-text gaps use me-* (inline-end), not ms-*');

  console.log('\n✅ All RTL/LTR Dashboard, POS, and common flow checks passed.');
}

run();
