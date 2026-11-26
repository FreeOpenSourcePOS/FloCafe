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
- `toppings` is optional: `{ "price": 2.25, "items": [{ "id": "bacon", "name": "Bacon" }, ...] }`. Every topping costs the one `price`, on any pizza of any size. A menu without it sells no extras and no added toppings. The price lives here and nowhere else in the file: a load writes it onto the two topping add-ons (see the mapping table), and whatever changes the price later changes this value and loads again, as a price set in the POS does (see Prices set in the POS).
- Prices in the file are dollars. The catalogue holds whole cents.

What `parseMenuFile` rejects, each with a `MenuError` naming the entry. Nothing is dropped silently:

- A category id other than `pizzas`, `sides`, `drinks` or `deals`, a category listed twice, or no `pizzas` category. `sides`, `drinks` and `deals` may be absent and are then empty.
- Duplicate ids within a category, and a pizza whose id is `half-and-half` (reserved for the half-and-half product).
- A side with more than one modifier, or a modifier that is not a required single choice (`required` true, `choose` 1 or absent), because the import always creates a required single-choice group.
- A deal with more than one drink pick (a `pop` pick and a `choice` pick count as one each), more than one `choice` pick, more than one `wing-flavour` pick, a `wing-flavour` pick whose count is not 1, a `2l` option whose count is not 1, a `pizza` pick with an unknown size, a `pizza` or `pop` pick whose count is below 1, a `choice` pick whose options are not exactly one `pop` and one `2l`, or a `wing-flavour` pick when there is no `wings` side.
- A deal whose `pizza` picks add up to more than 8 pizzas, or a `pop` pick or `pop` option of more than 99 cans. The fullest recipe of a deal within these limits fits the size an order line allows (see the recipe rules).
- Two entries that would derive the same catalogue id, because the ids in the mapping table below are joined with hyphens: pizza `a` in size `b-c` and pizza `a-b` in size `c` are both `pz-a-b-c`. The same holds for a pizza and the half and half, a drink and its variant, a side and its modifier, a modifier and its option, and a dip and a side's option. The error names both entries and the id, at path `menu`.
- `toppings` that is not an object, a `toppings.price` that is not whole cents, 0 or more, a topping id used twice, or more than 60 toppings.
- An id that does not match `^[a-z0-9][a-z0-9-]{0,39}$`: lower-case letters, digits and hyphens, starting with a letter or digit, at most 40 characters. This holds for every size, pizza, side, modifier, option, drink, drink variant, deal and topping id. Ids become parts of database keys.
- A name, label or description longer than 240 characters, or holding a control character (a line break and a tab count) or half of a character pair (a lone surrogate). These are printed on tickets and receipts.
- A list longer than its limit:

  | List | Most entries |
  | :--- | ---: |
  | Pizzas | 200 |
  | Pizza sizes | 12 |
  | Ingredients in one pizza's description | 60 |
  | Sides | 50 |
  | Drinks | 50 |
  | Deals | 50 |
  | Toppings | 60 |
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

// toppings.ts
export const TOPPING_ADDON = 'ad-topping';                       // one topping on a whole pizza
export const HALF_TOPPING_ADDON = 'ad-topping-half';             // one topping on one half
export const MAX_ADDED_TOPPINGS = 10;                            // added to one pizza or one half
export function toppingCounts(recipe: OrderLineRecipe | null | undefined): { whole: number; half: number }; // what one of a line is charged
export function kitchenAddons<T>(addons: T): T;                  // a line's add-ons without the two topping add-ons

// ticket.ts
export function ticketLines(catalog: PizzaCatalog, recipe: OrderLineRecipe, columns: number): TicketLines;
export const RECIPE_NOT_PRINTED = 'RECIPE NOT PRINTED - CHECK ORDER'; // the one detail line of a recipe that cannot be written out
```

Recipe rules:

- A pizza recipe has exactly one of `whole` and `halves`. Both halves may be the same pizza only if the halves differ in what is removed, made extra or added. Two identical halves are rejected with a `RecipeError` telling the cashier to choose a whole pizza; nothing is converted, because a whole pizza and a half and half are different products.
- `removed` entries must be ingredients of that pizza. Duplicates are dropped and the list is sorted, so the key is stable.
- A whole pizza or a half also carries `extra`, the ingredients the customer wants more of, and `added`, ids from the menu's `toppings`. Both are optional and an absent one means none, so a recipe stored before they existed is valid, means the same, and has the same key. Each is sorted and de-duplicated, and an empty one is left out of the normalised copy. Refused, each with a message for the cashier: an extra of an ingredient that pizza does not have; an ingredient both removed and extra; an extra on a menu without `toppings`, which has no price for it; an added topping the menu does not list; an added topping whose name is an ingredient of that pizza, whatever its case ("Garden already has Mushrooms. Choose extra Mushrooms instead"); and more than 10 toppings added to one pizza or half.
- A deal recipe has one pizza recipe per pizza pick, each with the deal's size; its pops add up to the pick's count; a `choice` deal has either `pops` or `twoLitre`, never both.
- A recipe is at most 28,000 bytes as stored (its JSON in UTF-8), unknown fields included. The largest recipe a menu allows is a deal of 8 pizzas, each a half and half with all 60 ingredients of a 240-character description removed from or made extra on both halves and ten toppings added to each half, with every id 40 characters long, cans of all 50 drinks and a wing flavour: 26,125 bytes. The description the server stores with a sold deal (`includes`, see Order lines) adds at most 734 bytes.
- A recipe never changes the unit price. A pizza costs its size price, a half and half costs the size price, a deal costs the deal price. Extras and added toppings are charged as FloCafe add-ons on the line: `toppingCounts` says how many of each a recipe needs, every extra and added topping of a whole pizza counting as one `ad-topping` and every one on a half as one `ad-topping-half`, a deal adding up its pizzas. No price is ever worked out from a recipe.
- Order is kept, not sorted, wherever the ticket shows it: `halves[0]` is the first half and `halves[1]` the second, so `[A, B]` and `[B, A]` are different recipes with different keys. `DealRecipe.pizzas[i]` answers the i-th pizza of `dealPickCount(deal).pizzas`, in pick order.
- Inside a part, `removed`, `extra` and `added` are sorted and de-duplicated. In `pops`, zero entries are dropped and keys are sorted, so a `pops` holding only zeros counts as absent. These are the only reorderings.
- A deal with a wing-flavour pick needs `wingFlavour`; a deal without one must not have it. The same holds for `pops` and `twoLitre` against the deal's drink pick.
- A deal recipe may carry `includes`, the deal's description when it was sold. Only the server writes it: `validateRecipe` drops it from what it is given, and `recipeKey` leaves it out, so two recipes that differ only there are the same recipe.

Ticket text, at 42 and 48 columns. The print layer indents every detail line by 3 and re-wraps on whitespace anything wider than `columns - 3`, which would lose the nesting below. So `ticketLines` keeps every detail line at `columns - 3` display cells or fewer, wrapping at commas itself; an item still too wide (a long name with no comma) wraps on spaces; a continuation line starts at the same indent as the line it continues. The heading is not under this budget: the print layer wraps headings. No line ends in a lone `NO`, `EXTRA` or `ADD`. Text is upper-cased as written; a letter such as `Ñ` is kept, and the print layer decides how a printer shows it.

```text
heading:  LARGE GARDEN
detail:   NO OLIVES, NO ONIONS
          EXTRA CHEESE
          ADD BACON, ADD FETA
          WELL DONE, SQUARE CUT

heading:  LARGE HALF & HALF
detail:   1ST: ISLAND
            NO PINEAPPLE
            EXTRA HAM
          2ND: CLASSIC PEPPERONI
            ADD BACON

heading:  LARGE PIZZAS & WINGS
detail:   1) LARGE GARDEN
             NO OLIVES
             EXTRA CHEESE
          2) LARGE HALF & HALF
             1ST: ISLAND
               ADD FETA
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

- A whole pizza: removals on one line (`NO A, NO B`), then extras (`EXTRA A, EXTRA B`), then added toppings by their menu name (`ADD A, ADD B`), then cook and cut on one line (`WELL DONE, SQUARE CUT`). Each line is left out when empty and wraps as the `NO` line does. A topping the menu no longer lists prints as its id.
- A half and half: `1ST: NAME`, that half's removals, extras and added toppings indented by 2, `2ND: NAME`, its own indented by 2, then cook and cut.
- A deal: each pizza as `n) SIZE NAME` (or `n) SIZE HALF & HALF`), followed by that pizza's own detail lines indented by 3. Then, in this order and only when the deal has them: `POP: n NAME, ...`, `2L: NAME`, `WINGS: FLAVOUR`. The labels `POP`, `2L` and `WINGS` are fixed words, not taken from the menu. Last comes `INCLUDES: ` and the recipe's `includes`, or, for a recipe without one, the deal's `description` from the stored menu, with runs of white space made one space: what comes with the deal whatever is chosen, such as a pasta or garlic toast, which no pick names. It wraps as any line does, its continuation lines at no indent. An empty one has no such line, nor has a recipe without `includes` whose deal has no description, is in a catalogue stored without descriptions, or is no longer on the menu.

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
| Toppings | An add-on group "Toppings" with the same settings, linked to the "Pizzas" category, which holds the half-and-half product, and to the "Deals" category when the menu has deals. Two add-ons whatever the list holds: "Topping" at `toppings.price` and "Half topping" at half of it | `ag-toppings`; `ad-topping`; `ad-topping-half` |
| Side with a modifier (the `dip` side included) | A product in "Sides" plus a required single-choice add-on group at price 0, linked to that product: `is_required=1, min_selection=1, max_selection=1` | `cat-sides`; `sd-<side>`; `ag-<side>-<modifier>`; `ad-<side>-<modifier>-<option>` |
| Side without | A product in "Sides" | `sd-<side>` |
| Drinks | Category "Drinks"; one product per drink; one variant per drink variant | `cat-drinks`; `dr-<drink>`; `dr-<drink>-<variant>` |
| Deals | Category "Deals"; one product per deal at the deal price | `cat-deals`; `dl-<deal>` |

All of FloCafe's id columns here are text, and an id is unique across its whole table, so `tests/pizza-menu-import.test.ts` asserts that the sample menu produces no duplicate id in any table. Because every id is derived from the menu's ids, importing the same file twice changes nothing and a changed price updates one row. A derived id stays with the entry it was first made for: a menu that would put a stored variant under another product, a stored add-on under another group, or a side's stored add-on group under another side throws a `MenuError` at path `menu` and writes nothing. The same holds when the group is already linked to both sides: the load is refused, naming both, until one of the two links is removed. Category colours are colour names. Money is converted from cents with `getCurrencyMinorUnitFactor`.

Half the topping price is worked out once, by the load, in decimal arithmetic (`lineSubtotal` in `main/services/tax.ts`) and rounded half-up to the cent: half of 2.25 is 1.13, so two halves cost a cent more than one whole topping. The browser and the order routes read both prices from the add-on rows and never halve anything. A menu without `toppings` writes none of these rows, and a load after one that had them switches the group and both add-ons off.

Tax: drinks get the tax category with code `soda` when `drinksPst`; every other imported product gets `food`. Lane C's setup profile creates both. If a category does not exist (tax not set up), the import does not write the product's tax category: a new product has none, which FloCafe treats as untaxed, a product that already has one keeps it, and the import summary says so.

`importMenu` also writes the parsed catalogue to `pizza_menu`, with the list of catalogue rows this load or an earlier one made (`owned_rows`), and one `pizza_products` row per pizza, for the half-and-half product, and per deal. A row stays on the list after it leaves the menu, so that a later file can bring it back.

The next load switches off the rows the previous load wrote that it no longer writes, worked out from the stored catalogue. A row that left the file and was switched on again by hand therefore stays on. A category is the exception: every load judges every category on the list that the menu no longer has, and switches it off unless it still holds an active product or an active sub-category (a product is shown only while every category above it is on). Categories nested by hand are judged child first, so a parent and child that both left the menu are switched off by the same load. So a category kept on for a hand-made product is switched off by the first load after that product is gone or switched off. While the stored catalogue is unreadable, every row on the list that the load does not write is switched off.

The file is the master of the rows on that list while it has them, except for a price set in the POS (next section): a load puts back a name or price changed by hand in the product screen, switches on a row switched off by hand, restores one deleted in the back office and makes again one removed from the database. A load never takes over a row that is not on the list. When the menu derives the id of a category, product, variant, add-on group or add-on that exists and no load made, `importMenu` throws a `MenuImportError` that names it ("A product with the id pz-garden already exists and was not made by a menu load. Give that item a different id in the menu file, then load it again.") and writes nothing; a row deleted in the back office still exists and still refuses. For a row under an id reserved for a section of the menu (`cat-pizzas`, `cat-sides`, `cat-drinks`, `cat-deals`, `pz-half-and-half`, `ag-dips`, `ag-toppings`, `ad-topping`, `ad-topping-half`) the message names the section and says instead that support has to rename or remove the row. A product with a `pizza_products` row counts as made by a load, with its variants, even when the list does not name it. Those are the only rows from before the list kept what left the menu that a load adopts: a pizza, the half-and-half product or a deal, and the sizes of one. A side, a drink or its size, an add-on group or an add-on that left the menu before then is not adopted, and a file that has it again is refused.

## Prices set in the POS (`shared/pizza/prices.ts`, `main/pizza/prices.ts`)

```ts
// shared/pizza/prices.ts
export function menuPrices(catalog: PizzaCatalog): MenuPrice[];   // every price of a catalogue: { key, group, label, priceCents, count }
export function withPrices(catalog: PizzaCatalog, cents: ReadonlyMap<string, number>): PizzaCatalog; // a copy at those prices, by key

// main/pizza/prices.ts
export function readPrices(db: Database): PriceList;                   // { prices: PriceRow[]; unused: { key, price }[] }
export function savePrices(db: Database, changes: unknown): PriceList; // { "<key>": amount | null }; throws with a statusCode and a message for the owner
```

A price is keyed by what the owner counts as one price, not by a catalogue row:

| Key | The price of | In the catalogue | Rows a load writes at it |
| :--- | :--- | :--- | :--- |
| `size:<size id>` | One pizza size | `sizes[].priceCents` | `pz-<pizza>-<size>` of every pizza and `pz-half-and-half-<size>` |
| `topping` | An extra or an added topping | `toppings.priceCents` | `ad-topping`, and `ad-topping-half` at half of it |
| `dip` | A dip | the `dip` side's `priceCents` and every `dips[].priceCents` | `sd-dip` and every `ad-dips-<option>` |
| `side:<side id>` | A side other than `dip` | `sides[].priceCents` | `sd-<side>` |
| `drink:<variant id>` | One drink size | `drinkVariants[].priceCents` | `dr-<drink>-<variant>` of every drink |
| `deal:<deal id>` | A deal | `deals[].priceCents` | `dl-<deal>` |

A drink has no price of its own in the menu format: every drink is sold in every variant at the variant's price. So the key is the variant, and one cola cannot cost more than another can.

Rules:

- `importMenu` reads `pizza_price_overrides` and applies it to the parsed file with `withPrices` before it works out a single row. Everything it writes, the `pizza_menu` catalogue included, is at the price in force, so the browser, the order routes and the ticket code need no knowledge of overrides. A product with variants still carries its lowest variant price, worked out from the prices in force.
- The same load writes, beside each override, what the file charges for that key (`file_cents`), or null when the file has no such price. A null one is an override that is kept and not used; the list returns it under `unused`, and a later file that has the item again is loaded at the stored price.
- `savePrices` is one transaction: it rebuilds the catalogue as the file had it (the stored catalogue with each override's `file_cents` put back), writes the changes to `pizza_price_overrides`, and calls `importMenu` with that catalogue. A price is therefore changed by the same code as a menu load and on every row at once. A refusal by the load (a store currency not counted in hundredths) rolls the change back.
- An amount is a number from 0 to 99,999.99 that is whole minor units of the store's currency, checked in decimal arithmetic (`lineSubtotal`); text, a negative amount and 23.005 are refused. A key that is not a price of the loaded menu is refused for an amount and accepted for `null`, so an unused override can be taken off. One bad entry refuses the whole request with `400 { error }`, the message naming the price and the currency.
- Nothing sold changes: order lines hold their own prices. A till picks a new price up as it picks up a menu load, because the stored catalogue changed (`refreshPizzaCatalog`), and the order routes charge from the catalogue rows whatever the till showed.
- A currency reset does not carry `pizza_price_overrides` across: the amounts are in the old currency.

| Route | Permission | Body | Answer |
| :--- | :--- | :--- | :--- |
| `GET /api/pizza/prices` | `catalog.view` | none | `200 PriceList`; `404` when no menu is loaded; `503` when the stored menu cannot be read |
| `PUT /api/pizza/prices` | `catalog.manage` | `{ prices: { "<key>": amount or null } }` | `200 PriceList` after the change; `400 { error }` for a bad entry |

In a `PriceList`, amounts are in the store's currency, not cents. A `PriceRow` has `key`, `group` (`size`, `topping`, `dip`, `side`, `drink` or `deal`), `label`, `count` (how many pizzas, dips or drinks the price is on; 1 otherwise), `file`, `price` and `overridden`.

The Pizza menu screen (`/pizza-menu`, opened with `catalog.import-export`) shows the Prices section to a user who also has `catalog.manage`.

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

-- Pizza migration 2. One row per price set in the POS.
CREATE TABLE IF NOT EXISTS pizza_price_overrides (
  key         TEXT PRIMARY KEY,   -- size:<id>, topping, dip, side:<id>, drink:<variant id>, deal:<id>
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  file_cents  INTEGER,            -- what the last menu file loaded charges for it; null: the file has no such price
  updated_at  TEXT NOT NULL
);
```

## Order lines (lane E, after A and B)

- A recipe travels as `modifier_selection` on the order line. The server validates and normalises it with `validateRecipe` against the catalogue stored in `pizza_menu`, at order create, add items and replacement edit.
- A recipe is optional on a pizza product: a plain pizza is just the product, its size variant and its dips. A half-and-half product and a deal product require one. A pizza and a half-and-half line need a size variant; without one the line is refused with "Pick a size for this pizza".
- A line's topping add-ons must equal what its recipe derives (`toppingCounts`): the summed quantity of `ad-topping` and of `ad-topping-half` on the line, no fewer and no more. This holds for every line of every product, a line with no recipe and a product no menu load made included, at order create, add items, a quantity increase and a replacement, and when a quick button is saved. A line that disagrees answers 400 with "The toppings on this item do not match what it is charged. Remove it and add it again", so a browser can neither forget the charge nor invent one. The price of each add-on is FloCafe's own add-on price, resolved by `resolveItemAddons`, and the line is taxed on its total as for any add-on. A replacement that leaves `modifier_selection` out keeps the stored recipe, so it must send that recipe's topping add-ons too.
- A product that is switched off or deleted, as a menu load leaves an item that left the file, cannot be sold: order create, add items, a quantity increase and a replacement that is a new sale answer 400 with "<name> is not on the menu. Pick another item". A reduction, a void and a refund of a line already sold still work.
- The line's product and variant must agree with the recipe, checked through `pizza_products` and the derived ids: `sizeId` matches the variant; `whole.pizzaId` is the product's menu id and `whole` is never on the half-and-half product; `halves` only on the half-and-half product; `dealId` is the deal product's menu id.
- A replacement edit keeps the stored recipe only when the `modifier_selection` field is absent and the product is unchanged. A kept pizza recipe takes its `sizeId` from the replacement's variant (the variant id with the `<product id>-` prefix removed) and is then validated as usual. An explicit `modifier_selection: null` means no recipe: it clears the recipe of a plain pizza and is refused, as any missing recipe is, on the half-and-half product and on deals.
- A replacement that names the line's own product, variant, quantity and add-ons, and sends no `price_override`, changes only the recipe or the note (`changesRecipeOnly` in `main/pizza/sold-line.ts`). The new line is the saved line with that recipe or note: unit price, add-ons with their prices and stock deductions, item discount amount, price override and tax are copied from the saved row, with no look at the current catalogue or the tax engine. It is therefore accepted when the pizza, its size or a dip has since been retired. Two recipes are the same when their `recipeKey` is the same, so key order and the order of removals and pops do not matter. A recipe that differs from the saved one, an explicit `null` that clears it included, is checked against the menu and refused when the pizza has been retired; the saved recipe sent back is not checked. Any other replacement, a new size, one more dip or another count of toppings included, is a new sale priced and validated from the current catalogue. A change of recipe that keeps the same number of toppings, a removal or one topping swapped for another, is therefore a recipe-only change at the prices sold.
- In an edit's idempotency hash, a replacement that leaves `modifier_selection` out and one that sends `null` are different requests: reusing the key with the other answers 409.
- A line amount is unit price plus add-ons, times quantity, less the item discount, in decimal arithmetic, rounded half-up to the cent (`lineSubtotal` in `main/services/tax.ts`). Three at 10.70 are 32.10, and 5% GST on them is 1.61. A discount is worked out the same way by `discountOn`: 5% off 32.10 is 1.61 on the line, the order, the bill and in the tax preview. An item discount and an order discount of the same percentage can still differ by a cent in tax (1.52 against 1.53 on 3 x 10.70 at 5%): an item discount taxes the discounted line, while an order discount prorates tax that was already rounded per line. That is upstream's behaviour. A line stored before amounts were rounded (32.099999999999994) is read as 32.10 when an order's lines are added up for a discount or a tax roll-up.
- Order create and add items take an optional `expected_subtotal`: the amount the till showed for the lines of that request before tax, order discounts and charges. When it differs by a cent or more from the sum of the server's line amounts for those lines, the request answers 409 with `code: "PRICES_CHANGED"` and "Prices have changed. Check the order and place it again.", and nothing is written (`assertExpectedSubtotal` in `main/pizza/price-guard.ts`, thrown inside the route's transaction). A value that is not a finite number answers 400. Without the field the routes behave as before; the Server App, the Orders page's windows and quick buttons do not send it. The POS sends `cartExpectedSubtotal` (`frontend/src/lib/pizza/price-guard.ts`) on every create and add-items request: unit price (the owner's override, or the platform price when the order has a platform) plus add-ons, times quantity, each line rounded half-up as `lineSubtotal` rounds it. On the refusal the POS fetches the menu, products and categories again, prices the cart from them with every line kept, marks a line whose product, size or add-on is gone, and leaves the cashier to place the order again.
- When the `pizza_menu` row is missing or unreadable, a line with a recipe answers 503 with "The pizza menu is not loaded. Load the menu file again."; lines without a recipe are unaffected.
- A deal line stores the deal's menu description in its recipe as `includes` (an empty one when the deal has none) when the order routes sell it: at order create, add items, and a replacement that is a new sale. What the client sends there is ignored. A recipe-only or note-only replacement and a quantity change keep the `includes` the saved line has, or its absence on a line stored before it was kept, which then prints the menu's description. A quick button stores no `includes`; a tap is a sale like any other. So a menu reload that changes a deal's description changes nothing printed or shown for an order already sold: kitchen tickets, receipts, the kitchen display and the sent-line view all print `includes`, through `ticketLines`.
- A recipe is not validated against the menu at print time: an order sold before a menu change still prints, with an id the menu no longer has printed as the id. A recipe that cannot be printed (the stored menu cannot be read, `ticketLines` throws, or a pizza lacks one whole or two halves each with a `removed` list) prints the one detail line `RECIPE NOT PRINTED - CHECK ORDER`, never nothing. The browser print paths print the ready-made `detailLines` an item carries as they are, write the recipe out from the catalogue the browser holds only when it carries none, and print the same warning line when they cannot.
- A restricted kitchen display station gets only the recipe fields of `modifier_selection` (the fields of `PizzaRecipe` and `DealRecipe`), whatever else was stored with them, as text when the selection is stored text. It gets `null` when the selection is not a pizza or deal recipe of version 1 with every field of its own type: ids and removals are text, `extra` and `added` are absent or lists of text, `cook` and `cut` are absent or one of the format's values, and `pops` is absent or a plain record of whole can counts, 0 or more.
- The kitchen is not shown the two topping add-ons: `kitchenAddons` in `shared/pizza/toppings.ts` takes `ad-topping` and `ad-topping-half` out of the add-ons of a kitchen ticket item, on the server and in the browser, and of a kitchen display item that holds a recipe. Receipts and bills print them.
- Every kitchen display item whose `modifier_selection` is a recipe carries `recipe_lines`: the `detailLines` of `ticketLines` at 48 columns, or the one warning line in the cases above. An item with no recipe has no such field. The display draws the lines as given and needs no menu in the browser.
- Print data gets `detailLines` from `ticketLines`, called with the printer's layout column count. The item heading stays FloCafe's own product and variant name. The kitchen ticket and the classic, compact, merchant and tax-pack receipts all print them.
- `POST /api/printers/print-kot` prints the order's saved lines. The `items` in the request only choose lines by `id`; name, quantity, recipe, note and add-ons come from the database. A cancelled, voided, void-adjustment or refunded line never prints. When the ids give no line to print while the order has others for the kitchen, as when another device replaced the line first, the route answers 409 with `code: "KOT_ITEMS_CHANGED"`, and the POS reads the order again and asks once more for its pending lines from the first id it asked for on (`printKotWithRefresh`). The Orders page and the Server App show the failure. The print test sends `sample: true` and gets the server's own sample ticket; no order is read for it.

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

- `label` is required, trimmed, 1 to 24 characters. `color` is required and is one of `QUICK_BUTTON_COLORS`, the colour names the POS gives categories. `note` is trimmed, at most 140 characters, and stored as null when empty. A tap sends it as the order line's note, so it is also held to the order route's own rule, `validateItemNotes`: the store's `max_item_notes_length` setting, 100 by default.
- The list has the shop-wide buttons first, in `sort_order`, then the customer's in theirs. Buttons of a customer who does not exist or is not active are not listed.
- Saving checks the button as an order line is checked: the product is active, the variant is resolved by `resolveOrderItemVariant`, the recipe by `checkLineRecipe` (the half-and-half product and deals need one, and the button's topping add-ons must equal what its recipe derives), the add-ons by `resolveItemAddons` without the stock check. A refusal answers `400 { error }` with a message for the cashier and writes nothing; a recipe checked while `pizza_menu` cannot be read answers 503.
- A `PUT` changes only the fields it names. Naming any of `product_id`, `variant_id`, `recipe` or `addons` checks all four together, the stored values standing in for the ones left out. A button never moves to another customer.
- No price is stored or returned.
- A stored button is never rewritten by a menu change. A new topping price changes neither its recipe nor its add-on quantities, so it stays usable and a tap is charged the price of the day. `usable` and `reason` are worked out each time a button is returned, by running the save checks against the current menu and the note check against the current setting. `reason` is the refusal's message; when the recipe names a pizza the menu no longer has, or removes an ingredient its pizza no longer has, it names that pizza or ingredient.
- One customer keeps at most 24 buttons and the shop at most 48 shop-wide ones. A `POST` beyond either answers `400 { error }` telling the cashier to delete one first. A `PUT` is not counted.
- `PUT` and `DELETE` first need `orders.create` or `catalog.manage`. A user with neither gets the same 403 for every id, so the answer does not say whether a button exists. For a user with either, a missing id answers `404 { error }`.

## Lanes and file ownership

| Lane | Builds | Owns |
| :--- | :--- | :--- |
| A, core | `parseMenuFile`, `validateRecipe`, `recipeKey`, `ticketLines`, `toppingCounts` | `shared/pizza/*.ts` except `types.ts`; `tests/pizza-menu.test.ts`, `tests/pizza-recipe.test.ts`, `tests/pizza-ticket.test.ts`, `tests/pizza-toppings.test.ts` |
| B1, tables | The pizza migration list and its four tables | `main/pizza/migrations.ts`; the hook in `main/db.ts`; `tests/pizza-migrations.test.ts` |
| C, shop mode | The `pizza` setup profile, BC tax, wizard pre-fill, the English-only strings file | `main/pizza/setup-profile.ts`; hooks in `main/routes/auth.ts`, `main/setup/seed-data.ts`, `frontend/src/app/setup/page.tsx`, `frontend/src/lib/i18n/`; `tests/pizza-setup-profile.test.ts`, `tests/pizza-tax-bc.test.ts`, `tests/pizza-i18n.test.ts` |
| B2, import | `importMenu` and its route | `main/pizza/menu-import.ts`, `main/routes/pizza.ts` and its one-line mount in the server's route index; `tests/pizza-menu-import.test.ts` |
| E, order lines | Recipe validation at the API, print wiring, kitchen display | `main/pizza/order-recipe.ts`; hooks in `main/routes/orders.ts`, the print data builders and the kitchen display views; `tests/pizza-order-recipe.test.ts`, `tests/pizza-order-print.test.ts` |
| F, POS screens | Pizza sheet, deal configurator, quick buttons, "Customize 1", category popups | `frontend/src/components/pos/pizza/`; hooks in the POS page and cart files; `tests/pizza-cart-store.test.ts`, the Playwright `pizza-*.spec.ts` files |
| G, quick buttons | The quick-button routes, the save checks and the staleness answer | `main/pizza/quick-buttons.ts`; the routes in `main/routes/pizza.ts`; one-word exports in `main/pizza/order-recipe.ts` (`readCatalog`) and `main/routes/orders.ts` (`resolveItemAddons`); `tests/pizza-quick-buttons.test.ts` |

Every lane adds its `test:pizza-*` scripts at the end of the `"test"` chain in `package.json`; whoever merges second resolves that one-line conflict by keeping both.
