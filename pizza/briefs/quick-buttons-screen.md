# Brief: lane F3, quick buttons on the POS

Read `docs/architecture/frontend.md` (the pizza sections), the "Quick buttons" section of [../contract.md](../contract.md) and of `docs/reference/api.md`, [../README.md](../README.md), and screen 4A in [../design/index.html](../design/index.html) with [../design/decision.md](../design/decision.md) and [../design/notes.md](../design/notes.md). **Open the wireframe in a headless browser at `index.html#4A` and look at it: that frame is what you are building.**

What exists: the routes under `/api/pizza/quick-buttons` (list with `usable` and `reason`, save, change, delete; `QuickButton`, `QuickButtonInput` and `QUICK_BUTTON_COLORS` in `shared/pizza/types.ts`); the POS pizza home and sheet (`frontend/src/components/pos/pizza/`); the cart store's `addItem(product, quantity, addons, note, variant, recipe)`.

## Problem

Staff make the same few pizzas all day, and regulars order "the usual". The server can store a configured item as a button, but no screen shows, adds or saves one.

## Outcome

With a pizza menu loaded:

1. **A "Quick Buttons" block** among the category blocks, with the number saved. It opens the quick buttons page in place of the product grid.
2. **The page (4A).** Shop-wide buttons in their order, each in its colour, showing label, what it holds in one or two lines, and its price worked out now from the product, size and add-ons (the server stores no price). A tap adds that line to the order exactly as saved (product, size, recipe, add-ons, note).
3. **A button the menu has changed under** (`usable: false`) is shown greyed with its `reason`, cannot be added, and can still be edited or deleted.
4. **The `⋯` menu** on a button: "Edit label & colour" (a small dialog), "Edit the item" (for a pizza button, opens the pizza sheet on it; saving updates the button, not the cart), "Delete button" (asks first).
5. **Saving a button.** From a cart line: an action on the line ("Save as quick button") opens the save dialog: a preview of the line's detail lines, a label (1 to 24 characters), the named colours as swatches with a tick on the chosen one, and "for the shop" or, when the order has a customer, "for <customer>". From the pizza sheet: a "Save as quick button" button that saves what the sheet holds without adding it to the order.
6. **A customer's favourites.** When the order has a customer (after the phone lookup), their buttons show as one row above the pizza grid on the POS home, and as their own section at the top of the page, with a tile to save an item from the order for them.
7. **Permissions.** Shop-wide save, edit and delete show only to a user with `catalog.manage`; a customer's buttons to anyone with `orders.create`. A refusal from the server shows its message.

The data side (fetch, the mapping between a cart line and a `QuickButtonInput`, between a `QuickButton` and an `addItem` call, and the price of a button) is a pure module under `frontend/src/lib/pizza/`, tested without a browser.

## Not in this lane

The deal configurator (a deal button can be tapped, saved from a cart line, relabelled and deleted like any other; "Edit the item" on a deal button is left out until the deal screen exists, and so is a save button inside the deal screen), the dips and drinks popup, folding cart action rows, reordering buttons by drag, anything in `main/`.

## Cases

Script (`tests/pizza-quick-buttons-ui.test.ts`): a cart line of each kind (plain pizza, half and half with a removal and a dip, a side with an add-on, a drink size) maps to the input the route accepts and back to the same cart line id; the price of a button; a stale button is not addable.

Browser (`frontend/e2e/pizza-quick-buttons.spec.ts`): (1) the block shows the count and opens the page; (2) save a half and half from a cart line for the shop, with a label and colour: it appears on the page; (3) tap it: the cart line equals the one it was saved from, and tapping twice gives `2x`; (4) save from the sheet without adding to the order; (5) relabel and recolour; (6) edit the item of a pizza button; (7) delete, with the confirm; (8) attach a customer, save a favourite for them: it shows in the row on the POS home and not for another customer; (9) remove a pizza from the menu (load an edited copy of the sample): its button is greyed with the reason and cannot be added; (10) a cashier (no `catalog.manage`) can add buttons and manage a customer's, and sees no shop-wide save, edit or delete; (11) keyboard only. Delete every button and customer the spec creates in `afterAll`.

Ports: `E2E_BASE_URL=http://127.0.0.1:3421 E2E_KDS_PORT=3422 E2E_SERVER_APP_PORT=3423`.

## Shared files, and two other lanes

Two other lanes are changing the POS pizza screens at the same time. All three touch `frontend/src/components/pos/pizza/usePizzaPos.tsx`, `PizzaHome.tsx`, `frontend/src/lib/i18n/messages-pizza/en.json` and `docs/architecture/frontend.md`. To keep the three mergeable:

- Put your logic in new files of your own (a hook, components, a pure module under `frontend/src/lib/pizza/`). In the shared files add the fewest lines that work, in one place, and do not reorder, rename or reformat anything already there.
- Do not build anything on the other two lanes' lists below, even where the wireframe shows it.

## Tests

Pure logic first, as a script test through `tsx` or `node tests/run-electron-node-test.cjs` like the other `tests/pizza-*.test.ts` files, with a `test:pizza-*` script chained at the end of `"test"` in `package.json`. Then a Playwright spec (the existing `chromium` project) for the screen.

- A spec that loads a menu uses `loadSampleMenu` in `beforeAll` and `clearPizzaMenu` in `afterAll` from `frontend/e2e/helpers/pizza-menu.ts`, never asserts "no menu" against the server (mock it), cancels or pays any order it places and removes anything else it creates, because every spec shares one database and later specs expect the upstream POS.
- Run Playwright only on your lane's ports (below), with a throwaway `HOME` and `PLAYWRIGHT_BROWSERS_PATH=/Users/anmolnoor/.cache/pizza-pos/ms-playwright`, from `frontend/`, after `npm run build` and `npm run build:frontend` in the repo root. Never run the Electron project.
- Before you finish, run your spec followed by `pizza-pos`, `pos-actions-menu`, `pos-keyboard-shortcuts` and `server-app-ordering` in one Playwright run, to show nothing you changed or left behind breaks them.
- **Screenshots** at 1180 × 820 to the folder named below, outside the checkout. Open each one yourself, compare it with the wireframe frame, fix what is clearly off (overflow, clipped text, targets under 48 px, unreadable contrast), and say in the report what still differs and why.

Every control is at least 48 px in both directions. Colour is never the only cue. Dialogs work with a keyboard, are labelled, and return focus. Text goes in `messages-pizza/en.json` (the `pizza` namespace, English only by design).

## Verify before pushing

```sh
npm run i18n:check
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base e71eeb0e
npm run docs:check
```

Then, each with a throwaway `HOME`: every `test:pizza-*` script, `test:dev-tooling`, `test:translations`, and every script in `package.json` whose name contains `pos` or `cart`. Do not run the full core suite; it runs in CI on both machines after you push. Update `docs/architecture/frontend.md` (present tense, no history).

## Report

Branch and commit; red-then-green for the script test; the Playwright result for each case; the screenshot paths and what differs from the wireframe; every upstream file and every shared pizza file edited, with line counts; the new strings; and anything on the screen you did not build.
