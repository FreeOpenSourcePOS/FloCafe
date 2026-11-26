# Brief: lane B1, the pizza migration list and tables

Read decision D3 in [../decisions.md](../decisions.md) first: it says what the spike proved and what must not be missed. Then the "Tables" section of [../contract.md](../contract.md), [../README.md](../README.md), and `docs/architecture/data-and-migrations.md`. The spike is on `origin/spike/pizza-db` (commit `30650cf6`): read `git diff origin/main origin/spike/pizza-db -- main/` and its test `tests/spike-pizza-migrations.test.ts`. It is evidence, not code to merge; write the real thing.

## Outcome

1. `main/pizza/migrations.ts`: `PIZZA_MIGRATIONS`, with its own version counter in `_flo_meta` (`pizza_schema_version`), run right after upstream's migrations and whenever the reference schema is built. Version 1 creates `pizza_products`, `pizza_menu` and `pizza_quick_buttons` exactly as the contract defines them.
2. The hook in `main/db.ts`, as small as the spike's (about 14 lines).
3. Recovery: a database file at the same upstream version but an older pizza version must be accepted where upstream compares against the reference schema. Key `getRecoverySchemaReference` by the candidate's pizza version as well (call sites near `main/db.ts:1526, 1861, 5449`), so a backup taken before a later pizza migration is listed as valid for downgrade recovery. With only version 1 today, prove it in the test with a second, test-only pizza migration.
4. A pizza version newer than the build enters the same downgrade-recovery flow as a newer upstream version, not a plain error.
5. Currency reset: `captureCurrencyResetMenu` and `restoreCurrencyResetMenu` (`main/db.ts:3304, 3336`) carry a fixed list of menu tables. `pizza_products` and `pizza_menu` belong with them; `pizza_quick_buttons` is cleared with the menu it points at. Say in the report what you decided and why.

## Rules

- Every pizza migration is idempotent (`IF NOT EXISTS`, column checks) and creates only pizza tables.
- Never add to upstream's `MIGRATIONS` array, and never create a table outside `PIZZA_MIGRATIONS`.
- Keep `-pre-v` in the pre-migration backup's file name.
- Do not edit upstream tests. If one fails, stop and report.
- Update `docs/architecture/data-and-migrations.md` in the same change (present tense, no history).

## Tests to write first

`tests/pizza-migrations.test.ts`, run through `node tests/run-electron-node-test.cjs`, with a `test:pizza-migrations` script chained at the end of `"test"`. Cases are the `pizza-migrations` row in section 4 of [../plan.md](../plan.md). The "existing install" must be a database made by pristine upstream code, as the spike test does with `git archive` of upstream commit `b5928ec`.

Then run upstream's own suites that touch this code and show they still pass: `schema-health`, `schema-reference-cache`, `migration-registry`, `product-variants-db`, `upgrade-path`, `backup-restore-production`, `newer-db-downgrade-recovery` (find the script names in `package.json`).

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-migrations
npm run test:script-coverage
npx tsc --noEmit && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <report folder outside the checkout>
```

The last command is the full core suite under the machine lock; run it once at the end. No Playwright.

## Report

Branch and commit, red-then-green output, full-suite totals, the exact diff size in `main/db.ts`, the currency-reset decision, and anything about recovery you could not prove.
