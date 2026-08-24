# FloCafe documentation index

This index classifies documentation in `docs/` so contributors and AI agents know which documents describe current runtime behavior, which describe planned designs, and which are historical records.

## Document authority

- **CURRENT**: Primary documentation for current supported behavior, setup, and developer workflows.
- **ACTIVE DESIGN**: Approved architecture currently being implemented. These describe target states that may be partially ahead of current code.
- **FORWARD-LOOKING**: Architecture proposals and plans that do not yet represent runtime contracts.
- **HISTORICAL**: Point-in-time audits, design records, or superseded specifications retained for context. Do not use these to drive new implementation unless an approved task or issue explicitly directs it.

> **Source of truth principle**: Current code and automated tests define what FloCafe does now. Approved task descriptions and GitHub issues define what a specific change is intended to accomplish. Cross-project invariants in `AGENTS.md` and `CURRENT` documentation govern broader constraints.

---

## Documentation catalog

### Current documentation

| Document | Description | Scope |
| --- | --- | --- |
| [API.md](API.md) | Endpoint and WebSocket reference for the local Express and KDS servers (`:3001` and `:3002`). | CURRENT |
| [linux.md](linux.md) | Linux package formats (AppImage, deb, rpm, Snap), FUSE setup, CUPS printing, and system tray behavior. | CURRENT |
| [printers.md](printers.md) | ESC/POS printer configuration, network/USB/OS-queue/WebUSB connection types, kitchen stations, and troubleshooting. | CURRENT |
| [printing-architecture.md](printing-architecture.md) | Multilingual print pipeline architecture (epic #438): shared print kernel, PrintDocument v1 model, renderer/transport map, language policy and canonical label flow, template trust models, capability/warning semantics, testing guide, and contributor recipes. | CURRENT |
| [google-drive-setup.md](google-drive-setup.md) | Maintainer setup for the optional Google Drive backup OAuth client. | CURRENT |
| [mac-app-store-publishing.md](mac-app-store-publishing.md) | Fastlane, Transporter, and GitHub Actions publishing workflow for the Mac App Store build. | CURRENT |
| [release-process.md](release-process.md) | Desktop release channels, draft verification gates, artifact naming, and explicit stable promotion. | CURRENT |
| [upgrade-support-matrix.md](upgrade-support-matrix.md) | Evidence matrix for real installed-artifact N → N+1 upgrade coverage and explicit NOT-RUN platform cells. | CURRENT |
| [tax-packs.md](tax-packs.md) | Tax pack schema, authoring guide, cryptographic signing, and catalog distribution workflow. | CURRENT |
| [i18n.md](i18n.md) | Internationalization guide, translation editing, language scaffolding (`npm run i18n:add`), and RTL layout support. | CURRENT |
| [merchant-print-templates.md](merchant-print-templates.md) | Merchant print template schema (v1), validation/compatibility policy, provenance and trust model, and bill-template selection identity. Cross-links the compliance `escpos-line-template-v1` contract (#445). | CURRENT |
| [title-bar-phase1.md](title-bar-phase1.md) | Native-controls title-bar implementation note for the main POS Electron window, including Phase 2 Linux verification and HTML fallback controls (#457). | CURRENT |
| [roles-and-permissions.md](roles-and-permissions.md) | Fixed staff roles, the read-only in-app permission matrix, and its code source of truth. | CURRENT |

### Active design & forward-looking plans

| Document | Description | Status |
| --- | --- | --- |
| [tax-engine-v2-spec.md](tax-engine-v2-spec.md) | Architectural specification for Tax Engine v2, data-only country packs, and future capability plugin boundaries. *(Note: 2026-07-31 amendment establishes that country packs are catalog-only and not auto-bundled).* | ACTIVE DESIGN |
| [cloud-v2-plan.md](cloud-v2-plan.md) | Client integration plan for FloAdmin v2 cloud coordination. Phase 1 client work is implemented in code; forward-looking multi-device sync and FloAdmin contracts remain in design/specs. | ACTIVE DESIGN / FORWARD-LOOKING |
| [printing-nonlatin-capabilities.md](printing-nonlatin-capabilities.md) | Capability study and decision record for non-Latin scripts (Arabic/Persian, Hebrew, CJK, Indic) on ESC/POS hardware: approach comparison, recommended capability-tiered raster-fallback architecture (#446), community hardware-test matrix, and test-page raster probe spec. Not yet implemented. | FORWARD-LOOKING |

### Historical records

| Document | Description | Status |
| --- | --- | --- |
| [security-audit-2.7.0.md](security-audit-2.7.0.md) | Security audit report for FloCafe v2.7.0 dated 2026-08-04. | HISTORICAL |

---

## Other repository assets

- [social-preview.html](social-preview.html): HTML template used to render Open Graph preview card graphics.
- `images/flo-cafe-pos.webp`: Screenshot of the FloCafe point-of-sale interface used in `README.md`.
