# Brief: the screens with a full-size menu, and what is in a deal on the ticket

Read `docs/architecture/frontend.md` (the pizza sections), [../contract.md](../contract.md) (the menu file, a deal's definition, and the ticket text rules), [../README.md](../README.md) and [../design/notes.md](../design/notes.md).

A rehearsal with a real shop's menu (26 pizzas, 8 deals, long names) passed on money but showed four problems the five-pizza sample hides. None of that menu's names or prices may appear in this repository; every test here uses the made-up sample or a larger menu generated from it inside the test.

## Problems and outcomes

1. **Too much scrolling on the POS home.** With 26 pizzas the tiles are in two columns at 1180 × 820, three rows to a screen: about four and a half screens, and the Half & Half tile is last, at the very bottom.
   - Outcome: at 1180 × 820 with FloCafe's sidebar open, at least 12 pizzas are fully visible without scrolling and 26 need at most about two screens. Do it by making the tile denser (for example the name with its number and the three size buttons on fewer rows, the ingredient line dropped or cut to one short line, Customize as a compact control), and more columns if they fit. Every size button and Customize stay at least 48 px in both directions and keep their accessible names; names up to about 40 characters wrap to two lines and are not cut mid-word with an ellipsis.
   - The Half & Half tile comes first, before pizza number 1.
2. **Choosing a pizza inside the sheet and the deal configurator pushes everything else off screen.** Each half lists every pizza as a large button, so with 26 pizzas the ingredient chips, cook, cut and dips are below the fold, and a half-and-half tab in a deal needs about two screens.
   - Outcome: once a half has a pizza, its list collapses to that pizza with a "Change" control, and the chips are visible without scrolling at 1180 × 820; choosing "Change" shows the list again. With no pizza chosen the list shows, as a compact grid (number and name; at least 48 px high). The same component serves the sheet and the deal tabs. With the five-pizza sample nothing may get worse, and the existing specs (`e2e/pizza-pos.spec.ts`, `e2e/pizza-deal.spec.ts`, `e2e/pizza-quick-buttons.spec.ts`) keep passing, changed only where a step now needs "Change".
3. **A deal tile does not say what the deal contains**, and deal tiles are upstream's large placeholder tiles (eight deals take three screens).
   - Outcome: with a pizza menu loaded, a deal product gets a compact tile of the fork's own: name, price, and the deal's description from the menu (two lines at most, the full text reachable, for example in the configurator header where it already shows). Eight deals fit one screen at 1180 × 820.
4. **What comes with a deal never reaches the kitchen.** A deal's fixed contents (a lasagna, garlic toast, how many wings) exist only in its description text, so a kitchen ticket for a deal lists the pizzas and pops and nothing else; a deal with no pizzas prints only its pops.
   - Outcome: the ticket lines of a deal (`ticketLines` in `shared/pizza/ticket.ts`, so every printer path, the kitchen display and the cart get it) end with the deal's description from the stored menu, on a line of its own starting `INCLUDES: `, upper-cased like the other lines and wrapped by the same rules. A deal with no description gets no such line. Update the contract's examples and every test that pins a deal's lines. If the stored catalogue does not carry the description, add it to the catalogue the import stores (`shared/pizza/menu.ts`, `main/pizza/menu-import.ts`), keeping a stored catalogue from before this change readable (no description, no line).

## Not in this change

A pasta choice inside a deal, tax on pops inside a deal, search by pizza number, pictures on tiles, anything on the Orders page.

## Tests

- Script: `ticketLines` for each sample deal with the new line, at 42 and 48 columns, including a long description that wraps and a deal with none; an old stored catalogue without descriptions still prints.
- Playwright `frontend/e2e/pizza-full-menu.spec.ts` (the `chromium` project): in `beforeAll` build a 26-pizza menu from the sample inside the test (made-up names such as "Sample Pizza 7", a few of them 35 to 40 characters long, 8 deals) and load it with `loadSampleMenu(request, menu)`; `clearPizzaMenu` in `afterAll`. Cases at 1180 × 820: (1) at least 12 pizza tiles fully inside the viewport, the Half & Half tile first, no horizontal overflow, every size button and Customize at least 48 px; (2) the pizza list height is at most about two screens; (3) a long name is shown whole; (4) in the sheet, half and half with both halves chosen: the ingredient chips of both halves are inside the viewport without scrolling, and "Change" brings the list back; (5) the same inside a deal's pizza tab; (6) the Deals category shows all 8 deals without scrolling and each tile shows its description; (7) place a deal and read the kitchen display or the print data: the `INCLUDES:` line is there.
- Ports: `E2E_BASE_URL=http://127.0.0.1:3431 E2E_KDS_PORT=3432 E2E_SERVER_APP_PORT=3433`, throwaway `HOME`, `PLAYWRIGHT_BROWSERS_PATH=/Users/anmolnoor/.cache/pizza-pos/ms-playwright`, from `frontend/` after `npm run build` and `npm run build:frontend`. Finish with one run of your spec plus `e2e/pizza-pos.spec.ts`, `e2e/pizza-deal.spec.ts`, `e2e/pizza-quick-buttons.spec.ts`, `e2e/pizza-small-items.spec.ts`, `e2e/pizza-kds.spec.ts`, pos-actions-menu, pos-keyboard-shortcuts and server-app-ordering.
- Screenshots at 1180 × 820, outside the checkout: the POS home with 26 pizzas, the sheet with both halves chosen, a deal's half-and-half tab, the Deals category. Open each and fix what is clearly off.

## Verify before pushing

Every `test:pizza-*` script, `test:dev-tooling`, `test:translations`, every script with `pos`, `cart`, `print` or `kot` in its name (each with a throwaway `HOME`), then:

```sh
npm run i18n:check
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
```

Do not run the full core suite; CI runs it. Update `docs/architecture/frontend.md`, `docs/architecture/printing.md` where it shows a deal's lines, and `pizza/contract.md` (present tense, no history).

## Report

Branch and commit; red-then-green; the Playwright result per case; measured numbers (pizzas visible, list height, sheet content height) before and after; screenshot paths; every upstream file edited with line counts; new strings; anything not built or not verified.
