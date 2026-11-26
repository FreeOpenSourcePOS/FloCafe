# Brief: hardening after the security pass

A read-only security review of everything the fork added found no high-severity problem, three medium and three low ones worth fixing now. Read [../README.md](../README.md), [../contract.md](../contract.md) and [../headless.md](../headless.md) first. Each fix gets a test that fails before it.

## Fixes

1. **Headless files are readable by other accounts** (`scripts/pizza/headless/`). On a headless box the JWT signing secret sits in the database, and the database, the backups and the pre-restore copies are created with default modes. Add `UMask=0077` to both units (`write-units.cjs`); in `install.sh` make the data folder mode 700; create the backup folder with mode 700 and write backup and pre-restore copies with mode 600 (`backup.cjs`, `restore.cjs`, `common.cjs`). In `pizza/headless.md` say plainly that a backup file is a credential (it holds the signing secret, PIN hashes and customer phone numbers) and how to store it. Tests: the units test asserts the umask; the backup and restore tests assert the modes of the folder and the copies.

2. **Control bytes can reach the kitchen printer from the browser print path.** `kotContactLines` (`shared/print/kot-contact.ts`) only collapses whitespace, and the browser encoder's detail lines (`frontend/src/lib/printer/kot-encoder.ts`, `readDetailLines` or its equivalent) pass text through, so ESC (0x1B) or GS (0x1D) in a delivery note, an address or a menu name can cut paper or change the print. The server path already strips them. Strip C0 control bytes and DEL (`/[\x00-\x1F\x7F]/g`) where contact lines and detail lines are built, so every renderer gets clean text. First write the test that settles whether the hole is real: an order with `delivery_note: "a\x1B@b\x1DV\x00"` and a detail line holding `\x1B`; assert the browser ESC/POS bytes, the server bytes and the browser HTML contain none of those bytes from the text (only the encoder's own commands). If the test shows the browser path was already safe, keep the test, make no code change, and say so.

3. **The menu file has no limits** (`shared/pizza/menu.ts`). In the parser: every id matches `/^[a-z0-9][a-z0-9-]{0,39}$/`; names, labels and descriptions are at most 120 characters and hold no control bytes; lists are capped (200 pizzas, 12 sizes, 60 ingredients per pizza, 50 sides, 50 drinks, 50 deals, 30 options or picks in any one list). Each refusal names the path, like the parser's other messages. Tests: `__proto__`, an id with a space, a colon, an upper-case letter, 41 characters; a name over the cap and one with a control byte; each list over its cap. Add one timing-free size test: a menu of 200 pizzas by 12 sizes parses and imports. Update `pizza/contract.md` (the menu file section) with the limits.
   - Before settling the id pattern, check the owner's real menu still parses: run `parseMenuFile` on `/Users/anmolnoor/Developer/richmond-pizza/docs/menu.json` from a script in the scratchpad (never copy that file, its names or its prices into this repository, a test, a commit message or your report; read nothing else in that project). If the real file breaks a limit, widen the limit just enough and tell me which limit, without quoting the menu.

4. **Kitchen staff can read a customer's quick buttons** (`main/routes/pizza.ts`). `GET /api/pizza/quick-buttons?customer_id=` needs only `catalog.view`. When `customer_id` is given, require `orders.create` as well (the rule `mayKeepButton` applies). Test: a kitchen-role request with a customer id gets 403; without one it still gets the shop's buttons; a cashier gets both. Check the POS screen still works for a cashier (it has `orders.create`).

5. **No cap on quick buttons** (`main/pizza/quick-buttons.ts`). Refuse a save beyond 24 buttons for one customer and beyond 48 shop-wide, with a message a cashier can act on. Test both. Add the limits to `pizza/contract.md` and `docs/reference/api.md`.

6. **Quick button edit and delete look up the button before the permission check** (`main/routes/pizza.ts`): a signed-in user with no rights can tell whether an id exists. Check a permission either kind of button would need before the lookup, or answer the same for both. Smallest change; one test.

## Not in this change

The import reviving a soft-deleted product or taking over a hand-made row with a derived id, and customer contact on every kitchen ticket by default: both are decisions for the owner.

## Verify before pushing

Every `test:pizza-*` script, the print suites you touched and any upstream suite with `print`, `kot` or `escpos` in its name (each with a throwaway `HOME`), then:

```sh
npm run i18n:check
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
```

Do not run the full core suite; CI runs it on both machines. If you run Playwright (only if a fix needs it), chromium only, ports 3411–3413.

## Report

Branch and commit; for each of the six, red then green; whether fix 2's hole was real; which limit, if any, the real menu forced; every upstream file edited with line counts; anything not done.
