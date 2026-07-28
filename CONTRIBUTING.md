# Contributing to FloCafe

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- Node.js >= 22.0.0
- npm >= 10.0.0
- macOS, Windows, or Linux

## Development Setup

```bash
# Clone the repo
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe

# Install dependencies (rebuilds native modules)
npm install

# Start development
npm run dev
```

This launches both the Next.js dev server (port 3002) and the Electron app (port 3001 API).

### macOS Gatekeeper & the Electron dev binary

Electron 43 removed the old automatic postinstall download (a supply-chain
hardening change — see [electron/electron#49328](https://github.com/electron/electron/pull/49328)):
by default it now only fetches its binary lazily, the first time the
`electron` CLI itself is launched. Since nothing in `npm ci` (including CI)
launches `electron` directly, our `postinstall` explicitly runs the
replacement `install-electron` bin script first to force an eager download,
then runs a check (`npm run verify:electron`) against what landed in
`node_modules/electron/dist`. Two things are worth knowing about this:

- **`codesign --verify --deep --strict` failing against
  `node_modules/electron/dist/Electron.app` is expected and harmless.** The
  `electron` npm package ships an ad-hoc-signed dev binary with no sealed
  resources — this is true of every install, on every machine, for every
  recent Electron version we've checked. It is *not* what end users receive:
  `npm run build:mac` / `release:mac` re-sign the packaged app from scratch
  with the real Developer ID certificate, and that signed-and-notarized build
  is what CI verifies with `codesign --deep --strict`, `spctl`, and
  `stapler validate` (see `.github/workflows/release.yml`). Don't try to "fix"
  the dev binary's signature — there's nothing wrong with it.
- **If macOS shows an "Electron has been blocked" / "may reduce your
  privacy" dialog, or `npm run verify:electron` reports a
  `com.apple.quarantine` flag, do not run `spctl --master-disable` or
  otherwise disable Gatekeeper system-wide.** A plain `npm install` shouldn't
  quarantine anything; if it did, something in your download path (a proxy,
  an AV tool, a non-npm copy step) tagged it, and that's worth fixing at the
  source rather than papering over. The approved remediation is a clean
  reinstall: `rm -rf node_modules/electron && npm install`. If
  `verify:electron` still fails after that, it's a real problem — open an
  issue rather than bypassing Gatekeeper.

### macOS notarization credentials (#168)

`release-mac` notarizes via an App Store Connect **API key**, not Apple ID +
app-specific password. We switched after the password-based flow reliably
failed from GitHub Actions with a misleading `HTTP 401: Your Apple ID has
been locked` — `xcrun notarytool` with the identical credentials worked fine
run interactively from a trusted Mac, confirming it was CI/automation
fraud-detection on Apple's end, not an actual account or credential problem.
API keys don't expire and avoid this class of issue entirely (this is
Apple's and electron-builder's own recommended approach for CI, not a
workaround).

`APPLE_API_KEY` must be an **absolute file path** to the `.p8` key
(`@electron/notarize` reads it from disk, unlike `CSC_LINK` which
electron-builder accepts as base64 directly) — so the `APPLE_API_KEY` GitHub
secret holds the `.p8` file's contents base64-encoded, and a workflow step
decodes it to a runner temp path before `Build macOS` runs. To rotate the
key: generate a new one in **App Store Connect → Users and Access →
Integrations → App Store Connect API**, then update all three secrets
(`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) — Apple only lets
you download the `.p8` once, so save it before navigating away.

### Useful Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Full dev mode (Electron + Next.js) |
| `npm run dev:frontend` | Frontend only (browser dev) |
| `npm run build` | Build backend TypeScript |
| `npm run build:frontend` | Build frontend for production |
| `npm test` | Run all tests |
| `npm run test:tables-string-ids` | Run table ID tests |
| `npm run lint` | Lint backend + frontend |

## Project Structure

```
FloCafe/
├── main/              # Electron main process + Express API
│   ├── routes/        # API route handlers
│   ├── db.ts          # SQLite database + migrations
│   ├── server.ts      # Express server setup
│   └── ipc.ts         # Electron IPC handlers
├── frontend/          # Next.js frontend
│   ├── src/
│   │   ├── app/       # Next.js app router pages
│   │   ├── components/# React components
│   │   ├── store/     # Zustand state stores
│   │   └── lib/       # Utilities, types, API client
│   └── package.json
├── tests/             # Integration tests
└── .github/workflows/ # CI/CD pipelines
```

## Branch Naming

Use descriptive prefixes:

- `fix/issue-XX-description` — bug fixes (link to issue)
- `feat/description` — new features
- `chore/description` — maintenance, dependencies, tooling
- `docs/description` — documentation changes

Example: `fix/issue-27-dine-in-order-flow`

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

Longer description if needed.

Fixes #XX
```

Types: `fix`, `feat`, `chore`, `docs`, `test`, `refactor`, `style`

## Pull Request Process

1. Create a branch from `main`
2. Make your changes
3. Run tests: `npm test`
4. Run lint: `npm run lint`
5. Push and open a PR
6. Link the related issue in the PR description
7. Wait for CI to pass and at least 1 maintainer review

### PR Checklist

- [ ] Tests added/updated for new functionality
- [ ] No TypeScript errors (`npm run build`)
- [ ] Lint passes (`npm run lint`)
- [ ] Database migrations are non-destructive (UPDATE, not DROP)
- [ ] Breaking changes documented in PR description

## Testing

```bash
npm test                           # Run all tests
npm run test:tables-string-ids     # Table ID tests
```

Tests live in `tests/` and use Node's built-in test runner. When adding new features, add integration tests that verify the real behavior (not just mocks).

## Database Migrations

When modifying the SQLite schema:

1. Add a new migration in `main/db.ts` with the next version number
2. Use non-destructive operations (`UPDATE`, `ALTER TABLE ADD COLUMN`)
3. Never `DROP` columns or tables — mark them deprecated instead
4. Test with both fresh databases and databases at previous schema versions

## Internationalization (i18n)

We actively welcome community contributions for new language translations! To add or improve a language:
1. Navigate to `frontend/src/lib/i18n/`.
2. Duplicate `en.json` and rename it to your target locale code (e.g., `fr.json` for French).
3. Translate the string values while keeping all the JSON keys intact.
4. Register your new language file where the i18n store or provider is initialized.

## Code Style

- TypeScript strict mode
- 2-space indentation
- Single quotes for strings
- No unused imports (ESLint enforced)
- Components: React functional components with hooks
- State: Zustand stores (not Redux)
- API: Express routes with async error handling

## Getting Help

- Open a [Discussion](https://github.com/FreeOpenSourcePOS/FloCafe/discussions) for questions
- Check existing [Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues) before creating new ones
- Look for issues labeled `good first issue` for beginner-friendly tasks

## Code of Conduct

Be respectful, constructive, and inclusive. We're building this together.
