# Contributing to FloCafe

FloCafe accepts code, tests, documentation, translations, and bug reports. Start with an [open issue](https://github.com/FreeOpenSourcePOS/FloCafe/issues) so you do not duplicate work or build against a direction the project is not taking. For a substantial feature, discuss the approach in an issue before writing code.

All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up a development copy

Use Node.js 22 or later and npm. Clone your fork, then install dependencies:

```sh
git clone https://github.com/YOUR-USERNAME/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev` clears FloCafe's local development ports, builds the frontend and backend, then starts Electron. For faster backend work without Electron:

```sh
node dev-server.js
```

To work on the frontend in a browser:

```sh
npm run dev:frontend
```

## Make a change

Create a branch from `main`. Use a name that explains the work:

```sh
git switch -c fix/receipt-printer-timeout
```

Use `fix/`, `feat/`, `docs/`, `test/`, `refactor/`, or `chore/` as appropriate. Keep commits focused and use Conventional Commit-style messages when they help explain the change:

```text
fix(printer): handle USB disconnect
```

Match the surrounding code. TypeScript is strict, formatting uses two spaces and single quotes, React state uses Zustand where shared state is needed, and API handlers belong in `main/routes/`.

## Check your work

Run these before opening a pull request:

```sh
npm run lint
npm run build
npm test
```

Add or update tests for behavior changes. A bug fix should demonstrate the bug in a test when practical. Update documentation and translations when the interface or workflow changes.

### Database changes

FloCafe runs against existing customer data. Schema migrations must be additive and safe to run on an existing database.

- Give every migration a new version.
- Use guarded `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE ADD COLUMN` changes.
- Do not drop tables or columns.
- Test a fresh database and an existing database before opening the pull request.

## Open a pull request

Explain the user-visible change, why it is needed, and how you tested it. Link the relevant issue. Keep unrelated formatting, refactors, or generated files out of the pull request.

Maintainers may ask for changes, tests, or a narrower scope before merging. Do not commit credentials, API keys, customer data, backups, or local `.env` files.

## Help and translations

Questions belong in [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions); bugs and feature proposals belong in [Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues).

Translation contributions are welcome. Add the locale under `frontend/src/lib/i18n/`, preserve existing keys, and register it with the i18n provider. Keep product names, commands, and technical identifiers unchanged unless the target language has an established equivalent.
