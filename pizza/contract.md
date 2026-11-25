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
```

Recipe rules:

- A pizza recipe has exactly one of `whole` and `halves`. Both halves may be the same pizza only if their removals differ. Two identical halves are rejected with a `RecipeError` telling the cashier to choose a whole pizza; nothing is converted, because a whole pizza and a half and half are different products.
- `removed` entries must be ingredients of that pizza. Duplicates are dropped and the list is sorted, so the key is stable.
- A deal recipe has one pizza recipe per pizza pick, each with the deal's size; its pops add up to the pick's count; a `choice` deal has either `pops` or `twoLitre`, never both.
- A recipe never changes the price. A pizza costs its size price, a half and half costs the size price, a deal costs the deal price.
- Order is kept, not sorted, wherever the ticket shows it: `halves[0]` is the first half and `halves[1]` the second, so `[A, B]` and `[B, A]` are different recipes with different keys. `DealRecipe.pizzas[i]` answers the i-th pizza of `dealPickCount(deal).pizzas`, in pick order.
- Inside a part, `removed` is sorted and de-duplicated. In `pops`, zero entries are dropped and keys are sorted. These are the only reorderings.
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

heading:  PARTY PACK                      (the customer chose cans)
detail:   1) LARGE GARDEN
          ... 2) to 6) ...
          POP: 2 COLA, 1 GINGER ALE, 1 LEMON LIME

heading:  PARTY PACK                      (the customer chose the bottle)
detail:   1) LARGE GARDEN
          ... 2) to 6) ...
          2L: COLA

heading:  PASTA NIGHT                     (a deal with no pizzas)
detail:   POP: 3 COLA
```

Layout rules behind the examples:

- A whole pizza: removals on one line (`NO A, NO B`), then cook and cut on one line (`WELL DONE, SQUARE CUT`). Either line is left out when empty.
- A half and half: `1ST: NAME`, that half's removals indented by 2, `2ND: NAME`, its removals indented by 2, then cook and cut.
- A deal: each pizza as `n) SIZE NAME` (or `n) SIZE HALF & HALF`), followed by that pizza's own detail lines indented by 3. Then, in this order and only when the deal has them: `POP: n NAME, ...`, `2L: NAME`, `WINGS: FLAVOUR`. The labels `POP`, `2L` and `WINGS` are fixed words, not taken from the menu.

Quantity (`2x`) is added by the print layer, not by `ticketLines`.

## How a menu maps onto FloCafe's catalogue (lane B2, `main/pizza/menu-import.ts`)

```ts
export function importMenu(db: Database, catalog: PizzaCatalog): { created: number; updated: number; unchanged: number };
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

Tax: drinks get the tax category with code `soda` when `drinksPst`; every other imported product gets `food`. Lane C's setup profile creates both. If a category does not exist (tax not set up), the product is left without one, which FloCafe treats as untaxed, and the import summary says so.

`importMenu` also writes the parsed catalogue to `pizza_menu`, and one `pizza_products` row per pizza, for the half-and-half product, and per deal. That stored catalogue is what the server validates recipes against.

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

-- One row: the catalogue parsed from the last menu file loaded.
CREATE TABLE IF NOT EXISTS pizza_menu (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  catalog     TEXT NOT NULL,   -- JSON PizzaCatalog
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
  addons      TEXT,            -- JSON, the cart's add-on shape
  note        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

## Order lines (lane E, after A and B)

- A recipe travels as `modifier_selection` on the order line. The server validates and normalises it with `validateRecipe` against the catalogue stored in `pizza_menu`, at order create, add items and replacement edit.
- A recipe is optional on a pizza product: a plain pizza is just the product, its size variant and its dips. A half-and-half product and a deal product require one.
- The line's product and variant must agree with the recipe, checked through `pizza_products` and the derived ids: `sizeId` matches the variant; `whole.pizzaId` is the product's menu id and `whole` is never on the half-and-half product; `halves` only on the half-and-half product; `dealId` is the deal product's menu id.
- A replacement edit that sends no recipe keeps the stored one.
- Print data gets `detailLines` and the heading from `ticketLines`.

## Lanes and file ownership

| Lane | Builds | Owns |
| :--- | :--- | :--- |
| A, core | `parseMenuFile`, `validateRecipe`, `recipeKey`, `ticketLines` | `shared/pizza/*.ts` except `types.ts`; `tests/pizza-menu.test.ts`, `tests/pizza-recipe.test.ts`, `tests/pizza-ticket.test.ts` |
| B1, tables | The pizza migration list and its three tables | `main/pizza/migrations.ts`; the hook in `main/db.ts`; `tests/pizza-migrations.test.ts` |
| C, shop mode | The `pizza` setup profile, BC tax, wizard pre-fill, the English-only strings file | `main/pizza/setup-profile.ts`; hooks in `main/routes/auth.ts`, `main/setup/seed-data.ts`, `frontend/src/app/setup/page.tsx`, `frontend/src/lib/i18n/`; `tests/pizza-setup-profile.test.ts`, `tests/pizza-tax-bc.test.ts`, `tests/pizza-i18n.test.ts` |
| B2, import | `importMenu` and its route | `main/pizza/menu-import.ts`, `main/routes/pizza.ts` and its one-line mount in the server's route index; `tests/pizza-menu-import.test.ts` |
| E, order lines | Recipe validation at the API, print wiring, kitchen display | `main/pizza/order-recipe.ts`; hooks in `main/routes/orders.ts`, the print data builders and the kitchen display views; `tests/pizza-order-recipe.test.ts`, `tests/pizza-order-print.test.ts` |
| F, POS screens | Pizza sheet, deal configurator, quick buttons, "Customize 1", category popups | `frontend/src/components/pos/pizza/`; hooks in the POS page and cart files; `tests/pizza-cart-store.test.ts`, the Playwright `pizza-*.spec.ts` files |

Every lane adds its `test:pizza-*` scripts at the end of the `"test"` chain in `package.json`; whoever merges second resolves that one-line conflict by keeping both.
