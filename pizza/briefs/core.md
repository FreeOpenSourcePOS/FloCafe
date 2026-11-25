# Brief: lane A, the pizza core

Read [../contract.md](../contract.md) first; it is the specification. Then [../README.md](../README.md) and decisions D1, D4, D17 and D18 in [../decisions.md](../decisions.md).

## Outcome

Three pure modules in `shared/pizza/`, with the exact exports the contract lists:

- `menu.ts`: `MenuError`, `parseMenuFile`, `ingredientsOf`, `toCents`
- `recipe.ts`: `RecipeError`, `validateRecipe`, `recipeKey`, `dealPickCount`
- `ticket.ts`: `ticketLines`

The types are already in `shared/pizza/types.ts`. If a type is wrong or missing, change it and `contract.md` in the same commit and say so in your report; two other lanes build against them.

## Rules

- Pure TypeScript. `shared/` may not import Node built-ins, Electron, React, `main/` or `frontend/` (upstream's lint enforces it), and may not use `any`.
- Money is whole cents inside the catalogue. `toCents` rejects a dollar amount that is not a whole number of cents.
- Unknown extra fields in a menu file are ignored (a real file carries photos, hours and notes).
- Every `MenuError` names the bad entry by path, for example `categories.deals.items[1].picks[0].size`. Every `RecipeError` message is one a cashier can act on, for example `Pick the second half`.
- `validateRecipe` returns a normalised copy and never mutates its input. It rejects a value that is not a plain object, has unknown `kind`, or is larger than a deal could need.
- `ticketLines` takes the paper width. No detail line is wider than `columns - 3` (the print layer indents by three). Lines wrap at commas and never end in a lone `+` or `NO`. Text is upper case, as in the contract's examples.
- Use only `tests/fixtures/pizza-sample-menu.json`. No real shop's names or prices.

## Tests to write first

`tests/pizza-menu.test.ts`, `tests/pizza-recipe.test.ts`, `tests/pizza-ticket.test.ts`, run with `tsx` like `tests/charges-calculation.test.ts`, using the `assert*OrThrow` helpers. One `test:pizza-*` script each, chained at the end of `"test"` in `package.json`. The cases are the three rows `pizza-menu`, `pizza-recipe` and `pizza-ticket` in section 4 of [../plan.md](../plan.md); the three ticket examples in the contract are asserted line for line at 42 and 48 columns. Each case fails before the code exists and passes after.

Add a purity case in the style of `tests/kernel-purity.test.ts`: nothing under `shared/pizza/` imports outside `shared/`.

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-menu && HOME=$(mktemp -d) npm run test:pizza-recipe && HOME=$(mktemp -d) npm run test:pizza-ticket
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
```

No full suite, no Playwright: the orchestrator runs those.

## Report

Branch and commit, red-then-green output of each test file, any change to `types.ts` or `contract.md`, and anything in the contract you found ambiguous and how you resolved it.
