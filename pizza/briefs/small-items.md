# Brief: lane F4, the dips and drinks popup, and a tidier cart

Read `docs/architecture/frontend.md` (the pizza sections), [../contract.md](../contract.md) (how sides, dips and drinks map onto the catalogue), [../README.md](../README.md), and screen 5B in [../design/index.html](../design/index.html) with [../design/decision.md](../design/decision.md) and [../design/notes.md](../design/notes.md). **Open the wireframe in a headless browser at `index.html#5B` and look at it: that frame is what you are building.**

What exists: the POS pizza home with its category blocks (`frontend/src/components/pos/pizza/PizzaHome.tsx`), the POS hook `usePizzaPos.tsx`, the pizza cart line (`PizzaCartLine.tsx`), and the cart store.

## Problem

Dips and drinks are the fastest things a pizza shop sells, and they are asked for in the middle of an order ("and two ranch, and four colas"). Today they are ordinary product tiles behind a category, so adding them means leaving the pizzas, and a drink with sizes opens a dialog for every can.

## Outcome

With a pizza menu loaded:

1. **A "Dips & drinks" popup (screen 5B)**, opened from the Dips and Drinks blocks. It is a sheet over the lower part of the product area; the order stays visible and usable beside it.
2. **One row per kind** (dips, then each drink size such as cans and 2-litres), labelled with the kind and its price; one tile per choice in the row.
3. **Each tap is an ordinary add of one** to the cart: the same product, size and add-on the product grid would add, so the order's lines, prices and taxes are exactly FloCafe's. A tile whose item is in the order shows how many, and a minus that takes one off.
4. **The line just added is highlighted in the cart** with an "added" mark, in words as well as colour, until the next change.
5. **Done**, Escape and a tap on the dimmed area close the popup. Nothing is pending when it closes: every tap already happened.
6. **A tidier cart.** Once an order has more than three lines, the action row of a pizza line (stepper, "Customize 1", Edit) is folded away on every pizza line except the one last touched or added; a tap on a folded line unfolds it and folds the others. With three lines or fewer, every row shows, as now.

Work out the rows from the loaded catalogue and the POS product list (the dip product and its options, the drink products and their size variants); nothing is hard-coded to the sample menu's names. If the menu has no dips or no drinks, that part of the popup is absent, and with neither the blocks behave as plain categories.

The mapping from the catalogue to rows and tiles, and "how many of this tile are in the order", is a pure module under `frontend/src/lib/pizza/`, tested without a browser.

## Not in this lane

The deal configurator, quick buttons, pops inside a deal, sides other than dips (wings, salads and toast keep their tiles), anything in `main/`.

## Cases

Script (`tests/pizza-small-items.test.ts`): the rows and tiles for the sample menu; the cart line a tile adds, by id, equals the line the product grid adds for the same item; counts per tile from a cart holding dips as add-ons on a pizza (not counted) and dips as their own lines (counted); a menu with no drinks.

Browser (`frontend/e2e/pizza-small-items.spec.ts`): (1) the Dips block opens the popup and the order stays visible; (2) two taps on a dip: one `2x` line, the tile shows 2, the line is marked "added"; (3) minus takes one off, and at zero the line is gone; (4) a can and a 2-litre of the same drink are separate lines at their own prices; (5) Done, Escape and the dimmed area close it and the order is unchanged by closing; (6) an order with five lines folds pizza action rows except the last touched, and a tap unfolds another; with three lines nothing folds; (7) place and pay: totals and tax equal those of the same items added from the product grid; (8) keyboard only.

Ports: `E2E_BASE_URL=http://127.0.0.1:3431 E2E_KDS_PORT=3432 E2E_SERVER_APP_PORT=3433`.

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
