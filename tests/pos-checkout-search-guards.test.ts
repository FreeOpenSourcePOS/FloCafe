/**
 * Source-level guards for the catalog/inventory search and checkout surfaces:
 *
 *   - Products (products / categories / add-ons) and Inventory (recipes /
 *     movements) must offer search, and every search must run over the whole
 *     collection rather than the first loaded page;
 *   - the Products tab strip must use the shared Tabs component that
 *     Inventory already uses;
 *   - a split-check-enabled store must be able to split a dine-in check from
 *     the payment dialog, and pay each resulting check;
 *   - a short tender must be collectable as a deliberate partial payment
 *     instead of being blocked in the UI;
 *   - the Orders detail pane must fill the space next to the master list.
 *
 * These are UI contracts asserted against the rendered markup's own class and
 * call contract, in the same shape as the other guards in this directory.
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/pos-checkout-search-guards.test.ts
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

// ── Products: shared tabs + one search over the full catalog ────────────────
{
  const products = source('frontend/src/app/(dashboard)/products/page.tsx');
  const inventory = source('frontend/src/app/(dashboard)/inventory/page.tsx');

  assert.match(
    products,
    /import \{ Tabs, TabsContent, TabsList, TabsTrigger \} from '@\/components\/ui\/tabs';/,
    'the products page uses the same Tabs component as the inventory page',
  );
  assert.match(
    inventory,
    /from '@\/components\/ui\/tabs';/,
    'the inventory page still uses the shared Tabs component',
  );
  for (const tab of ['products', 'categories', 'addons'] as const) {
    assert.match(
      products,
      new RegExp(`<TabsTrigger value="${tab}">`),
      `the ${tab} tab is a shared TabsTrigger`,
    );
    assert.match(
      products,
      new RegExp(`<TabsContent value="${tab}">`),
      `the ${tab} tab body is a shared TabsContent`,
    );
  }

  // Every list is filtered client-side from the complete API response, so a
  // search can never stop at a paginated subset.
  assert.match(
    products,
    /const visibleProducts = normalizedSearch === ''\n    \? products\n    : products\.filter/,
    'product search filters the complete product list',
  );
  assert.match(
    products,
    /const visibleCategories = normalizedSearch === ''\n    \? categories\n    : categories\.filter/,
    'category search filters the complete category list',
  );
  assert.match(
    products,
    /const visibleAddonGroups = normalizedSearch === ''\n    \? addonGroups\n    : addonGroups\.filter/,
    'add-on search filters the complete add-on group list',
  );
  for (const list of ['visibleProducts', 'visibleCategories', 'visibleAddonGroups'] as const) {
    assert.match(products, new RegExp(`${list}\\.map`), `${list} renders the filtered rows`);
  }
  assert.match(
    products,
    /placeholder=\{tCommon\('search'\)\}/,
    'the catalog search box is labelled by the shared search translation',
  );
}

// ── Inventory: recipe search client-side, movement search server-side ───────
{
  const inventory = source('frontend/src/app/(dashboard)/inventory/page.tsx');

  assert.match(
    inventory,
    /const visibleRecipes = normalizedRecipeSearch === ''\n    \? recipes\n    : recipes\.filter/,
    'recipe search filters the complete, unpaginated recipe list',
  );
  assert.match(inventory, /visibleRecipes\.map/, 'the recipe table renders the filtered rows');
  assert.match(
    inventory,
    /if \(movementSearch\.trim\(\)\) params\.search = movementSearch\.trim\(\);/,
    'movement search is sent to the API, so it spans every page, not just the loaded rows',
  );
  assert.match(
    inventory,
    /value=\{movementSearch\} onChange=\{\(e\) => setMovementSearch\(e\.target\.value\)\}/,
    'the movements tab shows its own search box',
  );
  assert.match(
    inventory,
    /value=\{recipeSearch\} onChange=\{\(e\) => setRecipeSearch\(e\.target\.value\)\}/,
    'the recipes tab shows its own search box',
  );
  assert.match(inventory, /tCommon\('noResults'\)/, 'filtered-to-empty lists say so instead of showing the empty-store copy');
}

// ── Payment dialog: split checks and deliberate partial payments ────────────
{
  const modal = source('frontend/src/components/pos/PaymentModal.tsx');

  assert.match(
    modal,
    /api\.get\('\/settings\/split_checks_enabled'\)/,
    'the payment dialog reads the split-checks setting instead of assuming it',
  );
  assert.match(
    modal,
    /const canSplitCheck = splitChecksEnabled[\s\S]{0,220}bill\.order\?\.type === 'dine_in'/,
    'split check is offered only for an untouched dine-in bill',
  );
  assert.match(modal, /<SplitCheckModal/, 'the split check dialog opens from payment');
  assert.match(modal, /if \(onSplit\) onSplit\(\);/, 'splitting hands control back to the page that owns the order');

  // The old guard refused any short tender outright; it is now an explicit,
  // confirmed partial payment.
  assert.ok(
    !modal.includes("toast.error(t('paymentBelowBalance'))"),
    'a short tender is no longer refused outright',
  );
  assert.match(
    modal,
    /const proceed = await confirm\(\n        t\('partialPaymentConfirm', \{ amount: currencyFmt\(collected\), remaining: currencyFmt\(stillDue\) \}\),/,
    'a short tender is confirmed as a partial payment before it is recorded',
  );
  assert.ok(
    !modal.includes('|| chargeStateUncertain || totalPaymentMinor < remainingMinor}'),
    'the pay button is no longer disabled for every amount below the balance',
  );
  assert.match(
    modal,
    /disabled=\{processing[\s\S]{0,140}\(totalPaymentMinor === 0 && remainingMinor > 0\)\}/,
    'the pay button stays disabled when nothing has been entered on a bill with a balance',
  );
}

// ── Orders: split checks are payable, and the detail pane fills the row ─────
{
  const panel = source('frontend/src/components/orders/OrderDetailPanel.tsx');
  const orders = source('frontend/src/app/(dashboard)/orders/page.tsx');

  assert.match(
    panel,
    /const splitBills = orderBills\.filter\(\(candidate\) => Boolean\(candidate\.split_group_id\)\);/,
    'the detail panel lists the order split checks',
  );
  assert.match(panel, /onPayBill\?: \(bill: Bill\) => void;/, 'the detail panel can hand a single split check to payment');
  assert.match(
    panel,
    /onPayBill\(\{ \.\.\.splitBill, order \}\)/,
    'each unpaid split check carries its order context into payment',
  );
  assert.match(
    orders,
    /onPayBill=\{\(bill\) => setPaymentBill\(bill\)\}/,
    'the Orders page opens payment for the picked split check',
  );

  assert.match(
    orders,
    /'w-full md:flex-1 min-w-0'/,
    'the detail pane fills the space next to the master list instead of stopping at a share of the row',
  );
  assert.match(
    orders,
    /'w-full md:w-\[360px\] lg:w-\[400px\] xl:w-\[440px\] min-w-0 flex-col/,
    'the master list stays a fixed reading column so the detail pane keeps the rest',
  );
  assert.match(
    orders,
    /onSplit=\{\(\) => \{\n            setPaymentBill\(null\);/,
    'a completed split closes payment and refreshes the order list',
  );
}

console.log('pos-checkout-search-guards: catalog search, split checks, partial payments, and orders width contracts hold');
