# FloCafe documentation

`docs/` describes the current supported system: how it is put together, what contracts it holds,
and how to perform a recurring task against it. It does not preserve development history. Plans,
research notes, audits, verification transcripts, and future proposals live in issues, pull
requests, and git history.

**Current code and tests define what FloCafe does.** Existing documentation is research material,
not authority. When code and documentation disagree, the code wins and the documentation is wrong.
Before writing a behavioral claim, verify it against the code, the tests, or the configuration.

**Update the page that owns the subject.** Create a new page only when no current page owns it.
Replace stale text in place; do not append corrections, date sections, or phase notes. The authoring
rules are in [`DOCUMENTATION.md`](../DOCUMENTATION.md), and `npm run docs:check` validates the
tree.

## Start here

| Page | Read it when |
| --- | --- |
| [architecture/overview.md](architecture/overview.md) | You need the map: one process, three ports, three windows, and how they connect. |
| [reference/product-invariants.md](reference/product-invariants.md) | You are about to change authorization, access control, defaults, refunds, or stock. Read this first. |
| [AGENTS.md](../AGENTS.md) | You are an agent working in this repository. |

## Architecture

How the system is put together and why its boundaries sit where they do.

| Page | Subject |
| --- | --- |
| [overview.md](architecture/overview.md) | Processes, ports, the window set, the KDS WebSocket, and the Server App proxy. |
| [runtime-and-lifecycle.md](architecture/runtime-and-lifecycle.md) | Startup and shutdown order, the relaunch gate, and the `dev-server.js` divergence. |
| [desktop-build.md](architecture/desktop-build.md) | The static-export boundary, the IPC surface, and native title-bar behaviour. |
| [data-and-migrations.md](architecture/data-and-migrations.md) | Database path, the migration array, the two fail-closed rules, and backups. |
| [business-time.md](architecture/business-time.md) | UTC storage, business-local presentation, and day and shift boundaries. |
| [authentication-and-authorization.md](architecture/authentication-and-authorization.md) | Roles, JWT lifecycle, the route-level authorization surface, and the boundaries the product does not harden. |
| [printing.md](architecture/printing.md) | The print kernel, document model, language domains, renderers, transports, and printer profiles. |
| [internationalization.md](architecture/internationalization.md) | The message catalogue, the language registry, the loader, and the derived print-label table. |
| [regional-settings.md](architecture/regional-settings.md) | How country and currency become a regional snapshot, and who consumes it. |
| [taxation.md](architecture/taxation.md) | The single tax calculation path, category resolution, rounding, and pack activation. |
| [cloud-integrations.md](architecture/cloud-integrations.md) | The optional network features, what each talks to, and how each degrades offline. |

## Reference

Contracts a caller must satisfy. Looked up, not read through.

| Page | Subject |
| --- | --- |
| [api.md](reference/api.md) | Endpoint reference for the three servers, and the KDS WebSocket contract. |
| [product-invariants.md](reference/product-invariants.md) | The deliberate product rules, each with where it is enforced and how to verify it. |
| [roles-and-permissions.md](reference/roles-and-permissions.md) | The in-app UI capability matrix. Not the authorization reference; see the architecture page. |
| [tax-packs.md](reference/tax-packs.md) | The `CountryPack` schema, the trust model, and the install path. |
| [merchant-print-templates.md](reference/merchant-print-templates.md) | The merchant receipt-template wire contract, validation, and trust model. |
| [print-templates-compliance.md](reference/print-templates-compliance.md) | The `escpos-line-template-v1` authoring contract used by signed tax packs. |
| [daily-sales-export.md](reference/daily-sales-export.md) | The owner-only accounting export, its reconciliation identities, and file formats. |
| [translation-terminology.md](reference/translation-terminology.md) | Script-level contracts a translation must not violate, and POS terminology. |

## Guides

Recurring procedures with an outcome.

| Page | Subject |
| --- | --- |
| [adding-a-language.md](guides/adding-a-language.md) | Adding a locale, from scaffolding to the verification commands. |
| [adding-a-tax-pack.md](guides/adding-a-tax-pack.md) | Authoring and shipping a country tax pack. |
| [testing-printers.md](guides/testing-printers.md) | Validating a physical printer against the print pipeline. |

## Maintainers

Procedures for people with release credentials.

| Page | Subject |
| --- | --- |
| [releases.md](maintainers/releases.md) | Channels, promotion, artifact naming, and the manual pre-release checks. |
| [mac-app-store.md](maintainers/mac-app-store.md) | The Mac App Store workflow, its secrets, and its release notes. |
| [upgrade-testing.md](maintainers/upgrade-testing.md) | What an upgrade test proves, and the platforms CI cannot cover. |

## Architecture decisions

Choices made once, with consequences that outlive the change. Each records the alternative that
was rejected, so a future reader does not re-open a settled question.

| Decision | Subject |
| --- | --- |
| [0001-offline-first-core.md](decisions/0001-offline-first-core.md) | Core POS operation is offline-first; network features are optional and fail gracefully. |
| [0002-backend-authoritative-security-and-tax.md](decisions/0002-backend-authoritative-security-and-tax.md) | The renderer never decides authorization, payment, or tax. |
| [0003-desktop-static-export.md](decisions/0003-desktop-static-export.md) | The desktop build is a static export served by Express, with no Next.js server runtime. |
| [0004-data-only-tax-packs.md](decisions/0004-data-only-tax-packs.md) | Country tax packs are data, never executable plugins. |

## Operator guides

These sit at flat paths under `docs/` because they are referenced from outside this tree: the
top-level READMEs, a merchant-visible string in the translation files, and the Linux packaging
metadata. Do not move them without a coordinated change to those references.

| Page | Audience |
| --- | --- |
| [printers.md](printers.md) | Merchants and support: connecting a printer and diagnosing the queue. |
| [linux.md](linux.md) | Merchants and support: Linux packages, printing permissions, and the tray. |
| [google-drive-setup.md](google-drive-setup.md) | Maintainers: provisioning the optional Drive backup OAuth client. |

## Other repository assets

- [`images/flo-cafe-pos.webp`](images/flo-cafe-pos.webp): the POS screenshot used in `README.md`
  and in the Linux AppStream metadata. Do not move it.
