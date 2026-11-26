# Contract

What every lane builds against. The types are in `shared/pizza/types.ts`; this page adds the function signatures, the tables, the mapping onto FloCafe's own catalogue, and who owns which files. Change this page and the types in the same commit, and tell the other lanes.

## The menu file

A shop's menu is one JSON file in the shape of `tests/fixtures/pizza-sample-menu.json` (type `MenuFile`). That fixture is made up. A real shop's file is not kept in this repository; it is loaded into the POS at install and whenever it changes.

Rules the format carries:

- Every pizza costs the size price in `sizes.pizza`; there is no per-pizza price.
- A pizza's `description` is its ingredient list, separated by commas and a final `&`. An empty description means no removable ingredients.
- The side with id `dip` defines the dips: its modifier options, each at that side's price. The side with id `wings` defines the wing flavours a deal can ask for.
- A drink is sold in every entry of the drinks category's `variants`. `pst: true` on that category means drinks carry provincial sales tax.
- A deal has a fixed price and a list of picks. A `pop` pick is any cans adding up to its count. A `choice` pick is answered with one of its options, which then becomes a `pop` or `2l` pick.
- Prices in the file are dollars. The catalogue holds whole cents.

What `parseMenuFile` rejects, each with a `MenuError` naming the entry. Nothing is dropped silently:

- A category id other than `pizzas`, `sides`, `drinks` or `deals`, a category listed twice, or no `pizzas` category. `sides`, `drinks` and `deals` may be absent and are then empty.
- Duplicate ids within a category, and a pizza whose id is `half-and-half` (reserved for the half-and-half product).
- A side with more than one modifier, or a modifier that is not a required single choice (`required` true, `choose` 1 or absent), because the import always creates a required single-choice group.
- A deal with more than one drink pick (a `pop` pick and a `choice` pick count as one each), more than one `choice` pick, more than one `wing-flavour` pick, a `wing-flavour` pick whose count is not 1, a `2l` option whose count is not 1, a `pizza` pick with an unknown size, a `pizza` or `pop` pick whose count is below 1, a `choice` pick whose options are not exactly one `pop` and one `2l`, or a `wing-flavour` pick when there is no `wings` side.
- An id that does not match `^[a-z0-9][a-z0-9-]{0,39}$`: lower-case letters, digits and hyphens, starting with a letter or digit, at most 40 characters. This holds for every size, pizza, side, modifier, option, drink, drink variant and deal id. Ids become parts of database keys.
- A name, label or description longer than 240 characters, or holding a control character (a line break and a tab count). These are printed on tickets and receipts.
- A list longer than its limit:

  | List | Most entries |
  | :--- | ---: |
  | Pizzas | 200 |
  | Pizza sizes | 12 |
  | Ingredients in one pizza's description | 60 |
  | Sides | 50 |
  | Drinks | 50 |
  | Deals | 50 |
  | Any other list: drink variants, a modifier's options, a deal's picks, categories | 30 |

Unknown extra fields on any entry are ignored.

The `dip` side is two things: a product a customer can buy alone (with its required choice of dip), and the source of the Dips add-on group on pizzas.

## Pure functions (`shared/pizza/`, lane A)

```ts
// menu.ts
export class MenuError extends Error { readonly path: string }
export function parseMenuFile(raw: unknown): PizzaCatalog;      // validates; throws MenuError naming the bad entry
export function ingredientsOf(description: string): string[];   // "Ham, pineapple, cheese & tomato sauce" -> ["Ham", "Pineapple", "Cheese", "Tomato sauce"]
export function toCents(dollars: number): number;                // rejects values that are not whole cents

// recipe.ts
export class RecipeError extends Error {}                        // message is one a cashier can act on
export function validateRecipe(catalog: PizzaCatalog, raw: unknown): OrderLineRecipe; // normalised copy
export function recipeKey(recipe: OrderLineRecipe): string;      // same recipe, same key, whatever order removals and pops were tapped in
export function dealPickCount(deal: CatalogDeal): { pizzas: { sizeId: string }[]; pops: number; wingFlavour: boolean; choice: boolean };

// ticket.ts
export function ticketLines(catalog: PizzaCatalog, recipe: OrderLineRecipe, columns: number): TicketLines;
export const RECIPE_NOT_PRINTED = 'RECIPE NOT PRINTED - CHECK ORDER'; // the one detail line of a recipe that cannot be written out
```

Recipe rules:

- A pizza recipe has exactly one of `whole` and `halves`. Both halves may be the same pizza only if their removals differ. Two identical halves are rejected with a `RecipeError` telling the cashier to choose a whole pizza; nothing is converted, because a whole pizza and a half and half are different products.
- `removed` entries must be ingredients of that pizza. Duplicates are dropped and the list is sorted, so the key is stable.
- A deal recipe has one pizza recipe per pizza pick, each with the deal's size; its pops add up to the pick's count; a `choice` deal has either `pops` or `twoLitre`, never both.
- A recipe never changes the price. A pizza costs its size price, a half and half costs the size price, a deal costs the deal price.
- Order is kept, not sorted, wherever the ticket shows it: `halves[0]` is the first half and `halves[1]` the second, so `[A, B]` and `[B, A]` are different recipes with different keys. `DealRecipe.pizzas[i]` answers the i-th pizza of `dealPickCount(deal).pizzas`, in pick order.
- Inside a part, `removed` is sorted and de-duplicated. In `pops`, zero entries are dropped and keys are sorted, so a `pops` holding only zeros counts as absent. These are the only reorderings.
- A deal with a wing-flavour pick needs `wingFlavour`; a deal without one must not have it. The same holds for `pops` and `twoLitre` against the deal's drink pick.

Ticket text, at 42 and 48 columns. The print layer indents every detail line by 3 and re-wraps on whitespace anything wider than `columns - 3`, which would lose the nesting below. So `ticketLines` keeps every detail line at `columns - 3` display cells or fewer, wrapping at commas itself; an item still too wide (a long name with no comma) wraps on spaces; a continuation line starts at the same indent as the line it continues. The heading is not under this budget: the print layer wraps headings. No line ends in a lone `NO`. Text is upper-cased as written; a letter such as `Ñ` is kept, and the print layer decides how a printer shows it.

```text
heading:  LARGE GARDEN
detail:   NO OLIVES, NO ONIONS
          WELL DONE, SQUARE CUT

heading:  LARGE HALF & HALF
detail:   1ST: ISLAND
            NO PINEAPPLE
          2ND: CLASSIC PEPPERONI

heading:  LARGE PIZZAS & WINGS
detail:   1) LARGE GARDEN
             NO OLIVES
          2) LARGE HALF & HALF
             1ST: ISLAND
             2ND: PLAIN CHEESE
          3) LARGE CLASSIC PEPPERONI
          WINGS: SWEET CHILI
          INCLUDES: ANY 3 LARGE PIZZAS & 12 WINGS

heading:  PARTY PACK                      (the customer chose cans)
detail:   1) LARGE GARDEN
          ... 2) to 6) ...
          POP: 2 COLA, 1 GINGER ALE, 1 LEMON LIME
          INCLUDES: ANY 6 LARGE PIZZAS & 4 CAN
          POPS OR A 2L BOTTLE

heading:  PARTY PACK                      (the customer chose the bottle)
detail:   1) LARGE GARDEN
          ... 2) to 6) ...
          2L: COLA
          INCLUDES: ANY 6 LARGE PIZZAS & 4 CAN
          POPS OR A 2L BOTTLE

heading:  PASTA NIGHT                     (a deal with no pizzas)
detail:   POP: 3 COLA
          INCLUDES: 3 PASTA,
          3 GARLIC TOASTS & 3 POPS
```

The deals are drawn at 42 columns. At 48 the party pack's last two lines are
`INCLUDES: ANY 6 LARGE PIZZAS & 4 CAN POPS OR` and `A 2L BOTTLE`, and Pasta Night's are one line.

Layout rules behind the examples:

- A whole pizza: removals on one line (`NO A, NO B`), then cook and cut on one line (`WELL DONE, SQUARE CUT`). Either line is left out when empty.
- A half and half: `1ST: NAME`, that half's removals indented by 2, `2ND: NAME`, its removals indented by 2, then cook and cut.
- A deal: each pizza as `n) SIZE NAME` (or `n) SIZE HALF & HALF`), followed by that pizza's own detail lines indented by 3. Then, in this order and only when the deal has them: `POP: n NAME, ...`, `2L: NAME`, `WINGS: FLAVOUR`. The labels `POP`, `2L` and `WINGS` are fixed words, not taken from the menu. Last comes `INCLUDES: ` and the deal's `description` from the stored menu, with runs of white space made one space: what comes with the deal whatever is chosen, such as a pasta or garlic toast, which no pick names. It wraps as any line does, its continuation lines at no indent. A deal whose description is empty, and a deal in a catalogue stored without descriptions, has no such line; nor has a deal the menu no longer has.

Quantity (`2x`) is added by the print layer, not by `ticketLines`.

## How a menu maps onto FloCafe's catalogue (lane B2, `main/pizza/menu-import.ts`)

```ts
export function importMenu(db: Database, catalog: PizzaCatalog): { created: number; updated: number; unchanged: number; deactivated: number; untaxed: boolean };
```

| Menu | FloCafe | Ids |
| :--- | :--- | :--- |
| Category `pizzas` | Category "Pizzas"; one product per pizza; one variant per size at the size price | `cat-pizzas`; `pz-<pizza>`; `pz-<pizza>-<size>` |
| Half and half | One extra product "Half & Half" in "Pizzas" with the same size variants | `pz-half-and-half`; `pz-half-and-half-<size>` |
| Dips | An add-on group "Dips" linked to the "Pizzas" category, one add-on per dip at its price. Optional, any number, several of one kind: `is_required=0, min_selection=0, max_selection=NULL, allow_multiple_quantities=1` | `ag-dips`; `ad-dips-<option>` |
| Side with a modifier (the `dip` side included) | A product in "Sides" plus a required single-choice add-on group at price 0, linked to that product: `is_required=1, min_selection=1, max_selection=1` | `cat-sides`; `sd-<side>`; `ag-<side>-<modifier>`; `ad-<side>-<modifier>-<option>` |
| Side without | A product in "Sides" | `sd-<side>` |
| Drinks | Category "Drinks"; one product per drink; one variant per drink variant | `cat-drinks`; `dr-<drink>`; `dr-<drink>-<variant>` |
| Deals | Category "Deals"; one product per deal at the deal price | `cat-deals`; `dl-<deal>` |

All of FloCafe's id columns here are text, and an id is unique across its whole table, so `tests/pizza-menu-import.test.ts` asserts that the sample menu produces no duplicate id in any table. Because every id is derived from the menu's ids, importing the same file twice changes nothing and a changed price updates one row. Category colours are colour names. Money is converted from cents with `getCurrencyMinorUnitFactor`.

Tax: drinks get the tax category with code `soda` when `drinksPst`; every other imported product gets `food`. Lane C's setup profile creates both. If a category does not exist (tax not set up), the import does not write the product's tax category: a new product has none, which FloCafe treats as untaxed, a product that already has one keeps it, and the import summary says so.

`importMenu` also writes the parsed catalogue to `pizza_menu`, with the list of catalogue rows this load or an earlier one made (`owned_rows`), and one `pizza_products` row per pizza, for the half-and-half product, and per deal. A row stays on the list after it leaves the menu, so that a later file can bring it back.

The next load switches off the rows the previous load wrote that it no longer writes, worked out from the stored catalogue. A row that left the file and was switched on again by hand therefore stays on. While the stored catalogue is unreadable, every row on the list that the load does not write is switched off.

The file is the master of the rows on that list while it has them: a load puts back a name or price changed by hand, switches on a row switched off by hand, restores one deleted in the back office and makes again one removed from the database. A load never takes over a row that is not on the list. When the menu derives the id of a category, product, variant, add-on group or add-on that exists and no load made, `importMenu` throws a `MenuImportError` that names it ("A product with the id pz-garden already exists and was not made by a menu load. Give that item a different id in the menu file, then load it again.") and writes nothing; a row deleted in the back office still exists and still refuses. For a row under an id reserved for a section of the menu (`cat-pizzas`, `cat-sides`, `cat-drinks`, `cat-deals`, `pz-half-and-half`, `ag-dips`) the message names the section and says instead that support has to rename or remove the row. A product with a `pizza_products` row counts as made by a load, with its variants, even when the list does not name it. Those are the only rows from before the list kept what left the menu that a load adopts: a pizza, the half-and-half product or a deal, and the sizes of one. A side, a drink or its size, an add-on group or an add-on that left the menu before then is not adopted, and a file that has it again is refused.

## Tables (lane B1, `main/pizza/migrations.ts`)

Created by the pizza migration list, which has its own counter (decision D3). Every statement is idempotent. Every table name starts with `pizza_`, so an upstream table can never take the same name.

```sql
CREATE TABLE IF NOT EXISTS pizza_products (
  product_id  TEXT PRIMARY KEY,
  menu_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('pizza', 'half-and-half', 'deal')),
  ingredients TEXT,            -- JSON string array, kind 'pizza'
  picks       TEXT,            -- JSON MenuDealPick array, kind 'deal'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- One row: the catalogue parsed from the last menu file loaded, and the catalogue rows menu loads have made.
CREATE TABLE IF NOT EXISTS pizza_menu (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  catalog     TEXT NOT NULL,   -- JSON PizzaCatalog
  owned_rows  TEXT NOT NULL DEFAULT '[]',   -- JSON array of "<table>:<id>", sorted: the categories, products, variants, add-on groups and add-ons a load wrote
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pizza_quick_buttons (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  color       TEXT,
  customer_id TEXT,            -- null: a shop-wide button
  product_id  TEXT NOT NULL,
  variant_id  TEXT,
  recipe      TEXT,            -- JSON OrderLineRecipe
  addons      TEXT,            -- JSON, the cart's add-on shape: [{ id, quantity }]
  note        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

## Order lines (lane E, after A and B)

- A recipe travels as `modifier_selection` on the order line. The server validates and normalises it with `validateRecipe` against the catalogue stored in `pizza_menu`, at order create, add items and replacement edit.
- A recipe is optional on a pizza product: a plain pizza is just the product, its size variant and its dips. A half-and-half product and a deal product require one. A pizza and a half-and-half line need a size variant; without one the line is refused with "Pick a size for this pizza".
- A product that is switched off or deleted, as a menu load leaves an item that left the file, cannot be sold: order create, add items, a quantity increase and a replacement that is a new sale answer 400 with "<name> is not on the menu. Pick another item". A reduction, a void and a refund of a line already sold still work.
- The line's product and variant must agree with the recipe, checked through `pizza_products` and the derived ids: `sizeId` matches the variant; `whole.pizzaId` is the product's menu id and `whole` is never on the half-and-half product; `halves` only on the half-and-half product; `dealId` is the deal product's menu id.
- A replacement edit keeps the stored recipe only when the `modifier_selection` field is absent and the product is unchanged. A kept pizza recipe takes its `sizeId` from the replacement's variant (the variant id with the `<product id>-` prefix removed) and is then validated as usual. An explicit `modifier_selection: null` means no recipe: it clears the recipe of a plain pizza and is refused, as any missing recipe is, on the half-and-half product and on deals.
- A replacement that names the line's own product, variant, quantity and add-ons, and sends no `price_override`, changes only the recipe or the note (`changesRecipeOnly` in `main/pizza/sold-line.ts`). The new line is the saved line with that recipe or note: unit price, add-ons with their prices and stock deductions, item discount amount, price override and tax are copied from the saved row, with no look at the current catalogue or the tax engine. It is therefore accepted when the pizza, its size or a dip has since been retired. Two recipes are the same when their `recipeKey` is the same, so key order and the order of removals and pops do not matter. A recipe that differs from the saved one, an explicit `null` that clears it included, is checked against the menu and refused when the pizza has been retired; the saved recipe sent back is not checked. Any other replacement, a new size or one more dip included, is a new sale priced and validated from the current catalogue.
- In an edit's idempotency hash, a replacement that leaves `modifier_selection` out and one that sends `null` are different requests: reusing the key with the other answers 409.
- A line amount is unit price plus add-ons, times quantity, less the item discount, in decimal arithmetic, rounded half-up to the cent (`lineSubtotal` in `main/services/tax.ts`). Three at 10.70 are 32.10, and 5% GST on them is 1.61. A discount is worked out the same way by `discountOn`: 5% off 32.10 is 1.61 on the line, the order, the bill and in the tax preview. An item discount and an order discount of the same percentage can still differ by a cent in tax (1.52 against 1.53 on 3 x 10.70 at 5%): an item discount taxes the discounted line, while an order discount prorates tax that was already rounded per line. That is upstream's behaviour. A line stored before amounts were rounded (32.099999999999994) is read as 32.10 when an order's lines are added up for a discount or a tax roll-up.
- When the `pizza_menu` row is missing or unreadable, a line with a recipe answers 503 with "The pizza menu is not loaded. Load the menu file again."; lines without a recipe are unaffected.
- A recipe is not validated against the menu at print time: an order sold before a menu change still prints, with an id the menu no longer has printed as the id. A recipe that cannot be printed (the stored menu cannot be read, `ticketLines` throws, or a pizza lacks one whole or two halves each with a `removed` list) prints the one detail line `RECIPE NOT PRINTED - CHECK ORDER`, never nothing.
- A restricted kitchen display station gets `modifier_selection` only when it is a recipe, and `null` otherwise.
- Every kitchen display item whose `modifier_selection` is a recipe carries `recipe_lines`: the `detailLines` of `ticketLines` at 48 columns, or the one warning line in the cases above. An item with no recipe has no such field. The display draws the lines as given and needs no menu in the browser.
- Print data gets `detailLines` from `ticketLines`, called with the printer's layout column count. The item heading stays FloCafe's own product and variant name. The kitchen ticket and the classic, compact, merchant and tax-pack receipts all print them.
- `POST /api/printers/print-kot` prints the order's saved lines. The `items` in the request only choose lines by `id`; name, quantity, recipe, note and add-ons come from the database. The print test sends `sample: true` and gets the server's own sample ticket; no order is read for it.

## Quick buttons (lane G, `main/pizza/quick-buttons.ts`)

A quick button is one cart line saved under a label, for the whole shop or for one customer. The routes are in `main/routes/pizza.ts`, under `/api/pizza`.

| Route | Permission | Body | Answer |
| :--- | :--- | :--- | :--- |
| `GET /quick-buttons` | `catalog.view`, and `orders.create` as well when `customer_id` is given | none; query `customer_id` is optional | `200 { buttons: QuickButton[] }` |
| `POST /quick-buttons` | `orders.create` with a `customer_id`, `catalog.manage` without | `QuickButtonInput` | `201 { button: QuickButton }` |
| `PUT /quick-buttons/:id` | by the stored button: `orders.create` for a customer's, `catalog.manage` for a shop-wide one | any fields of `QuickButtonInput` except `customer_id` | `200 { button: QuickButton }` |
| `DELETE /quick-buttons/:id` | as `PUT` | none | `200 { success: true }` |

`QuickButtonInput` and `QuickButton` are in `shared/pizza/types.ts`. A `QuickButton` has, in this order: `id`, `label`, `color`, `customer_id` (null on a shop-wide button), `product_id`, `variant_id`, `recipe` (normalised, or null), `addons` (`[{ id, quantity }]`, empty when there are none), `note`, `sort_order`, `created_at`, `updated_at`, `usable` and `reason` (null when usable).

Rules:

- `label` is required, trimmed, 1 to 24 characters. `color` is required and is one of `QUICK_BUTTON_COLORS`, the colour names the POS gives categories. `note` is trimmed, at most 140 characters, and stored as null when empty.
- The list has the shop-wide buttons first, in `sort_order`, then the customer's in theirs. Buttons of a customer who does not exist or is not active are not listed.
- Saving checks the button as an order line is checked: the product is active, the variant is resolved by `resolveOrderItemVariant`, the recipe by `checkLineRecipe` (the half-and-half product and deals need one), the add-ons by `resolveItemAddons` without the stock check. A refusal answers `400 { error }` with a message for the cashier and writes nothing; a recipe checked while `pizza_menu` cannot be read answers 503.
- A `PUT` changes only the fields it names. Naming any of `product_id`, `variant_id`, `recipe` or `addons` checks all four together, the stored values standing in for the ones left out. A button never moves to another customer.
- No price is stored or returned.
- A stored button is never rewritten by a menu change. `usable` and `reason` are worked out each time a button is returned, by running the save checks against the current menu. `reason` is the refusal's message; when the recipe names a pizza the menu no longer has, or removes an ingredient its pizza no longer has, it names that pizza or ingredient.
- One customer keeps at most 24 buttons and the shop at most 48 shop-wide ones. A `POST` beyond either answers `400 { error }` telling the cashier to delete one first. A `PUT` is not counted.
- `PUT` and `DELETE` first need `orders.create` or `catalog.manage`. A user with neither gets the same 403 for every id, so the answer does not say whether a button exists. For a user with either, a missing id answers `404 { error }`.

## Lanes and file ownership

| Lane | Builds | Owns |
| :--- | :--- | :--- |
| A, core | `parseMenuFile`, `validateRecipe`, `recipeKey`, `ticketLines` | `shared/pizza/*.ts` except `types.ts`; `tests/pizza-menu.test.ts`, `tests/pizza-recipe.test.ts`, `tests/pizza-ticket.test.ts` |
| B1, tables | The pizza migration list and its three tables | `main/pizza/migrations.ts`; the hook in `main/db.ts`; `tests/pizza-migrations.test.ts` |
| C, shop mode | The `pizza` setup profile, BC tax, wizard pre-fill, the English-only strings file | `main/pizza/setup-profile.ts`; hooks in `main/routes/auth.ts`, `main/setup/seed-data.ts`, `frontend/src/app/setup/page.tsx`, `frontend/src/lib/i18n/`; `tests/pizza-setup-profile.test.ts`, `tests/pizza-tax-bc.test.ts`, `tests/pizza-i18n.test.ts` |
| B2, import | `importMenu` and its route | `main/pizza/menu-import.ts`, `main/routes/pizza.ts` and its one-line mount in the server's route index; `tests/pizza-menu-import.test.ts` |
| E, order lines | Recipe validation at the API, print wiring, kitchen display | `main/pizza/order-recipe.ts`; hooks in `main/routes/orders.ts`, the print data builders and the kitchen display views; `tests/pizza-order-recipe.test.ts`, `tests/pizza-order-print.test.ts` |
| F, POS screens | Pizza sheet, deal configurator, quick buttons, "Customize 1", category popups | `frontend/src/components/pos/pizza/`; hooks in the POS page and cart files; `tests/pizza-cart-store.test.ts`, the Playwright `pizza-*.spec.ts` files |
| G, quick buttons | The quick-button routes, the save checks and the staleness answer | `main/pizza/quick-buttons.ts`; the routes in `main/routes/pizza.ts`; one-word exports in `main/pizza/order-recipe.ts` (`readCatalog`) and `main/routes/orders.ts` (`resolveItemAddons`); `tests/pizza-quick-buttons.test.ts` |

Every lane adds its `test:pizza-*` scripts at the end of the `"test"` chain in `package.json`; whoever merges second resolves that one-line conflict by keeping both.
