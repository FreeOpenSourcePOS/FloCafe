# Brief: lane C, pizza shop mode

Read decisions D7, D8, D12 and D13 in [../decisions.md](../decisions.md), then [../README.md](../README.md) and the lane table in [../contract.md](../contract.md). The English-only strings mechanism was proven on `origin/spike/pizza-ui` (commit `09a9e922`): read `git diff origin/main origin/spike/pizza-ui -- frontend/src/lib/i18n tests/translations.test.ts`. It is evidence, not code to merge.

## Outcome

**1. A setup profile `pizza`** beside `empty`, `express` and `demo` (`main/routes/auth.ts:116`, `seedSetupProfile` in `main/setup/seed-data.ts`). Its logic lives in a new file, `main/pizza/setup-profile.ts`; upstream files get one-line hooks. It seeds no menu (a later lane loads the shop's menu file). It sets:

| Setting | Value |
| :--- | :--- |
| Service model | counter service (`qsr`), which also turns tables off |
| `kds_enabled`, `server_app_enabled` | off |
| `auto_print_kot` | on |
| `cash_drawer_pulse_enabled`, `cash_drawer_pulse_methods` | on, `["cash"]` |
| `kot_show_customer_contact` | on |
| `taxes_enabled` | on |
| `offline_mode` | untouched: it stays on |

**2. British Columbia tax**, configured by the profile through the code behind `POST /api/tax-packs/manual-config` (`main/routes/tax-packs.ts:1262-1402`), not a new tax pack file:

- Tax category `food`: GST 5%.
- Tax category `soda`: GST 5% and PST 7%.
- Prices are tax-exclusive (`inclusive: false`; that path defaults to inclusive).
- Both GST lines carry the same label, so reports merge them (`main/services/tax-components.ts:124`).
- A product with no tax category must stay untaxed (upstream's tax invariant test).

**3. The setup wizard** (`frontend/src/app/setup/page.tsx`): a "Pizza shop" profile card. Choosing it pre-fills Canada, CAD and `America/Vancouver`; the owner can still change them. A profile cannot set the region on the server, so the pre-fill is in the wizard and the request carries the values.

**4. English-only pizza strings** (decision D7): `frontend/src/lib/i18n/messages-pizza/en.json`, merged as the `pizza` namespace into whichever language is active, with `messages.d.ts` extended so a wrong key is a compile error, and the four-line addition to `tests/translations.test.ts` that adds the pizza file's keys to the known set. The wizard card's text is the first user of it. This is the only upstream test this lane may edit, and only by those lines.

## Rules

- No new text in the 32 language files.
- No real shop's name, address or phone number.
- Do not seed printers, stations, permission overrides or menu items.
- Update the `docs/` pages that describe setup profiles, tax configuration and the string catalogue in the same change (present tense, no history).

## Tests to write first

Each with a `test:pizza-*` script chained at the end of `"test"`. Cases are the rows `pizza-setup-profile`, `pizza-tax-bc` and `pizza-i18n` in section 4 of [../plan.md](../plan.md).

- `tests/pizza-setup-profile.test.ts`: complete setup through the real setup route with profile `pizza`; assert every setting in the table, that no menu items were seeded, and that offline mode is still on and nothing outbound was attempted (see `tests/pizza-offline-default.test.ts` for how).
- `tests/pizza-tax-bc.test.ts`: after the profile, a product in `food` is charged GST only; a product in `soda` GST and PST; a $23.00 food item plus a $1.75 soda item gives subtotal $24.75, GST $1.24, PST $0.12, total $26.11 through the real tax path; a product with no category is untaxed.
- `tests/pizza-i18n.test.ts`: a `pizza.*` key resolves under two non-English languages; the strings file has valid ICU message syntax and no duplicate keys.

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-setup-profile && HOME=$(mktemp -d) npm run test:pizza-tax-bc && HOME=$(mktemp -d) npm run test:pizza-i18n
npm run i18n:check
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <report folder outside the checkout>
```

The last command is the full core suite under the machine lock; run it once at the end. No Playwright, and never the Electron app.

## Report

Branch and commit, red-then-green output of each test, full-suite totals, every upstream file edited with line counts, how you worked out the tax arithmetic above if it differs, and anything the wizard pre-fill could not do.
