# Brief: a one-screen setup for a pizza shop

Read [../README.md](../README.md), [../decisions.md](../decisions.md) (D8, the `pizza` setup profile; D13, offline by default), `main/pizza/setup-profile.ts`, `tests/pizza-setup-profile.test.ts`, the setup route `POST /api/auth/setup/initialize` in `main/routes/auth.ts`, and the setup wizard in the frontend (find it from the "Welcome to FloCafe" screen: the page that shows when `GET /api/auth/setup/status` says `needsSetup`).

## Problem

The owner tried the POS for the first time and gave up on setup. What they met is upstream's six-step wizard, made for any restaurant in any country: thirty languages, every country, business type, service model, terms, and only then the account. The fork's "Pizza shop" option is one choice buried inside it. The owner's words: "setup is too big", "make the setup little easier please".

## Outcome

1. **A new install opens on one screen**, titled for a pizza shop: shop name; owner's name, email and password (with a show/hide control and upstream's own password rules shown as the owner types); a 4-digit manager PIN, typed twice; and one button, "Set up my shop". Nothing else is asked. Everything else is decided: English, Canada, British Columbia, Canadian dollars, Vancouver time, the `pizza` profile, counter service, offline mode as the install default already has it. A short line says so in plain words ("Set up for a pizza shop in British Columbia: Canadian dollars, GST and PST. You can change these later in Settings.").
2. **It uses the existing route and the existing profile**, with the same body the wizard would send for those choices, so the server is not changed unless a field the route requires cannot be defaulted (then stop and report). Whatever upstream requires the owner to accept (terms) is shown as one checkbox with a link to the text upstream shows, not dropped.
3. **After it succeeds** the owner is signed in and lands on the Pizza menu screen, which says no menu is loaded and offers the file control: loading the menu is the real second step. (If the app has a natural "what next" place, use it; otherwise go to `/pizza-menu`.)
4. **The full wizard is still there**, one link away ("Not a pizza shop in BC? Use the full setup"), and "Restore a backup" stays reachable from the one-screen setup, since a shop replacing a machine needs it. Upstream's wizard itself is not changed.
5. **Errors are plain**: a refused field is marked beside the field with the server's message; a server that cannot be reached says so and keeps what was typed.
6. The screen says "pizza POS", not FloCafe, in its own heading; do not rebrand anything else in this change.

Controls at least 48 px, labelled, keyboard-usable, works at 1180 x 820 and on a phone-width screen (an owner may do this from a phone). Text in `messages-pizza/en.json`.

## How

A new page or a new first view in the setup route's page, in new files; the smallest hook that makes it the default when the install is fresh (`needsSetup`) and leaves upstream's wizard reachable. How the fork decides to show it: always, since this fork is the pizza build; say in the report where that decision lives so it is easy to change.

## Tests

- Script (chained into `"test"`), if there is pure logic (the request body built from the form): the body equals the one `tests/pizza-setup-profile.test.ts` sends for BC, and the route accepts it.
- Playwright `frontend/e2e/pizza-quick-setup.spec.ts` (chromium). The shared e2e server is already set up, so this spec needs a fresh server: look at how `frontend/playwright.config.ts` starts the server and whether any existing spec runs against an un-set-up database (search for `needsSetup` or a setup spec); if one does, follow it; if none does, start a second server from the spec on its own ports and temporary data folder with the same entry point the config uses, and stop it in `afterAll`. Cases: a fresh install shows the one screen; a short password or mismatched PINs are refused beside the field; a valid form sets the shop up, signs in and lands on the Pizza menu screen; the store's settings read back as the BC pizza profile (country, currency, time zone, tax categories, `setup_profile`); the link opens the full wizard; keyboard only; phone width.
- Ports for anything you start: 3431–3433 and, for a second server, 3441–3443. Throwaway `HOME`, `PLAYWRIGHT_BROWSERS_PATH=/Users/anmolnoor/.cache/pizza-pos/ms-playwright`, chromium only, never Electron.
- Screenshots at 1180 x 820 and at 390 x 844, outside the checkout; open each and fix what is clearly off.

## Verify before pushing

Every `test:pizza-*`; any script with `setup`, `auth` or `onboarding` in its name; `test:dev-tooling`; `test:translations`; `npm run i18n:check`, `npm run test:script-coverage`, both `tsc --noEmit`, `npm run lint`, `npm run lint:budget`, `node scripts/ci/check-changed-format.cjs --base 81f54a5f`, `npm run docs:check`; one Playwright run of your spec plus every `e2e/pizza-*.spec.ts`, any upstream setup or login spec, pos-actions-menu and pos-keyboard-shortcuts with `--retries=0`. Do not run the full core suite. Update `pizza/headless.md` (first run) and `pizza/decisions.md` D8.

## Report

Branch and commit; red then green; the Playwright result per case; screenshot paths; what the screen defaults and where each default comes from; where the "show the one-screen setup" decision lives; every upstream file edited with line counts; new strings; anything not built or not verified.
