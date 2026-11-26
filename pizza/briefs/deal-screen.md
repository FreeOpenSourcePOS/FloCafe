# Brief: lane F2, the deal configurator

Read `docs/architecture/frontend.md` (the pizza sections), [../contract.md](../contract.md) (`DealRecipe`, `dealPickCount`, `validateRecipe`, the ticket lines of a deal, and the order-line rules: a deal needs a recipe), [../README.md](../README.md), and screen 3A in [../design/index.html](../design/index.html) with [../design/decision.md](../design/decision.md) and [../design/notes.md](../design/notes.md). **Open the wireframe in a headless browser at `index.html#3A` and look at it: that frame is what you are building.**

What exists: the pizza sheet (`frontend/src/components/pos/pizza/PizzaSheet.tsx`) over `sheetReducer` and `sheetLine` (`frontend/src/lib/pizza/sheet-state.ts`); the POS hook `usePizzaPos.tsx`, whose `open` refuses a deal product today with the message "Deals cannot be added from this screen yet."; `cartLineDetailLines`, which already prints a deal's lines in the cart; and the server, which validates every deal recipe.

## Problem

A deal ("any 3 large pizzas and 12 wings") is a product whose recipe says which pizzas, and what is changed on each, plus the deal's other choices. Nothing on the POS can build that recipe, so a deal cannot be sold.

## Outcome

1. **Tapping a deal opens the deal configurator (screen 3A)**, a dialog: the deal's name, what it includes, its fixed price, and "N of M chosen".
2. **One tab per choice the deal asks for**, worked out from the catalogue for that deal (`dealPickCount` and the deal's entry): one per pizza, then one each for whatever else the deal has to be told (wing flavour, pops, a 2-litre). A tab shows a tick and a one-line summary when done, and `!` with "Choose a pizza" (or the like) when not.
3. **A pizza tab is the pizza editor from the sheet**, with the size fixed by the deal ("Large · set by the deal"): whole or half and half, the pizza on each half, ingredient removals, cook and cut. No dips, note or quantity on a deal's pizza. Reuse the sheet's editor; do not write a second one. If that needs the editor body pulled out of `PizzaSheet.tsx` into a component both use, do that with the smallest move that keeps the sheet's behaviour and its spec (`frontend/e2e/pizza-pos.spec.ts`) unchanged.
4. **The right-hand column**: "Summary · prints as" (the deal's ticket lines so far, with the missing ones marked in words), a "Still missing" box whose buttons jump to the tab, the deal price, and the Add button, which is off and says "N choices left to add" until the recipe is complete and valid. The message for an invalid choice comes from `validateRecipe`.
5. **Add** puts one cart line: the deal product with the recipe. **Edit** on a deal line in the cart opens the configurator loaded with that line; saving replaces the line (`replaceCartLine`). A deal's price is the product's price; the recipe never changes it.
6. The deal guard and its string go away.

The state is a pure reducer in a new module beside `sheet-state.ts` (for example `deal-state.ts`: `newDeal`, `dealReducer`, `dealLine`), built on the sheet's reducer for each pizza, so it can be tested without a browser.

## Not in this lane

Quick buttons (leave "Save as quick button" out of the configurator), the dips and drinks popup, folding cart action rows, a pasta choice inside a deal (the menu file does not ask), split wing flavours, anything in `main/`.

## Cases

Script (`tests/pizza-deal-state.test.ts`): the tabs a deal asks for, for each deal in the sample menu; a complete recipe passes `validateRecipe` and equals the hand-written recipe; each kind of missing choice is counted and named; identical halves on one pizza are refused with the contract's message; loading a stored recipe and saving it unchanged gives the same recipe.

Browser (`frontend/e2e/pizza-deal.spec.ts`): (1) a deal tile opens the configurator with the right tabs; (2) Add is off with the count until every choice is made; (3) the three-pizza deal with one removal, one half and half and a wing flavour: the summary lines, then the cart line's detail lines; (4) "Still missing" jumps to the tab; (5) Edit a deal line, change one pizza, save: one line, new lines; (6) place the order and read it back through the API: `modifier_selection` is the recipe built; (7) the largest deal in the sample (most pizzas) fits at 1180 × 820 without sideways scrolling of the page; (8) keyboard only.

Ports: `E2E_BASE_URL=http://127.0.0.1:3411 E2E_KDS_PORT=3412 E2E_SERVER_APP_PORT=3413`.

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
