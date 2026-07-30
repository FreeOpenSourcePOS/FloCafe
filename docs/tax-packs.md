# Tax packs: developer guide

FloCafe's tax system is split in two, per [`docs/tax-engine-v2-spec.md`](tax-engine-v2-spec.md):

- **Tax packs** (this document) — signed, versioned **data**. No executable code. Covers rate tables, categories, rounding, and jurisdiction rules that are computable offline from information already on the transaction (country, state/province, category, customer status, date).
- **Capability plugins** (tracked in [#142](https://github.com/FreeOpenSourcePOS/FloCafe/issues/142)) — isolated, executable integrations for things a pack cannot express: fiscal authorization (e.g. ARCA, IRN), payment providers, delivery providers, and address-level jurisdiction lookups. Not yet built; see the note at the bottom of this file.

If you're adding tax support for a new country, you almost always want a **pack**, not a plugin. A pack is enough to cover a state/province rate table (India's CGST/SGST/IGST, for example) or a flat VAT (Thailand). You only need a plugin if the calculation requires calling an external service, holding credentials, or resolving something (like a US address to a rooftop-level rate) that isn't decidable from data already in FloCafe.

## What a pack can and can't do

A pack is one JSON file matching `main/tax-packs/types.ts`'s `CountryPack` shape. It can declare:

- Tax categories (`categories`) and the rules attached to each (`rules`)
- Percentage or fixed tax rules, including compound rules that depend on other rules (`baseRuleIds`)
- Interstate vs. intrastate conditions, exemptions, business-type conditions
- Default categories for packaging, delivery, service charges, and add-ons (`defaultCategories`), plus a required `unclassifiedCategoryId`
- Inclusive/exclusive pricing default, registration-number label, tax rounding policy, and payable (cash) rounding policy
- Effective dates, publisher, minimum compatible FloCafe version

It must not embed scripts, call network endpoints, or introduce a second tax-calculation path. If a category has zero declared rules, that's a legitimate "no tax" category — a category with rules that never produce a component is what activation validation rejects.

## Authoring a new pack

1. Copy the shape of an existing pack — `main/tax-packs/in.json` (state-split GST) or `main/tax-packs/th.json` (flat VAT) — as your starting point.
2. Give it a unique `id` (lowercase, hyphenated, e.g. `official-ar`), set `publisher` to your name/org (anything other than `local` — `local` is reserved for the in-app manual/unbundled pack and can never be published), and fill in `country`, `jurisdiction`, `currency`, `taxRounding`, `payableRounding`.
3. Define `categories` and `rules`. Every category referenced by `defaultCategories` or by a product must exist. `unclassifiedCategoryId` must point at a real category (usually a zero-rate one).
4. Add the file to `main/tax-packs/` in this repo (not a new repo — see "Where packs live" below) and open a PR. You do **not** need to add it to `main/tax-packs/bundled.ts` unless you want it shipped inside the installer by default (currently only India, Thailand, and the generic/manual pack are bundled, to keep the installer small — verified at 280KB of translations vs. a 230MB installer, the same size discipline applies to bundled packs). An unbundled pack is still fully installable — it just gets fetched from the catalog instead of shipping in every install.
5. Add test vectors: extend `tests/tax-pack-management.test.ts` (activation validation) and, ideally, `tests/tax-engine.test.ts` / `tests/integration-tax.test.ts` with a scenario proving your rules produce the expected components, totals, and rounding for at least one representative order.
6. Run `npm run test:tax-engine` and the full `npm test` before opening the PR.

## Where packs live, how they get signed, and how they're published

There is no separate plugin/pack repository. Everything — the pack JSON, the signing workflow, and the catalog — lives in this repo:

- Pack source JSON: `main/tax-packs/*.json`
- Schema: `main/tax-packs/types.ts`
- Signing script: `scripts/tax-packs/prepare-release.cjs`
- Release workflow: `.github/workflows/tax-pack-release.yml`
- Catalog + install/verify logic the app uses at runtime: `main/tax-packs/catalog.ts`
- Trusted public key baked into the app: `main/tax-packs/trusted-signing-key.ts`

Publishing is maintainer-only, because it requires pushing a tag, which triggers CI to sign with the private key held only in the `TAX_PACK_SIGNING_KEY` GitHub Actions secret. **No one — including AI assistants working in this repo — should ever generate, request, or handle that private key directly**; it exists only as a GitHub secret, read solely by the release workflow.

To publish a reviewed pack:

```sh
git tag tax-pack-<pack-id>-v<X.Y.Z>
git push origin tax-pack-<pack-id>-v<X.Y.Z>
```

The tag must match the `id` and `version` fields already committed in the pack's JSON file. The workflow then:

1. Downloads the previous cumulative `catalog.json` (if one exists) from the repo's own releases.
2. Signs the exact pack JSON bytes with the Ed25519 signing key (`scripts/tax-packs/prepare-release.cjs`).
3. Publishes the pack JSON, a detached `.sig`, and the updated `catalog.json` as immutable release assets under that tag.

At runtime, FloCafe fetches `catalog.json` from this repo's GitHub Releases, downloads any pack a store wants to install, verifies its Ed25519 signature against the hardcoded public key and its SHA-256 digest, and runs it through the same 24-point activation checklist used for bundled packs (`validationChecklist()` in `main/routes/tax-packs.ts`) before an owner can activate it. Downloading can happen automatically or on demand; **activation is always an explicit, owner-only action**, and a previous version stays available for rollback.

## Testing your pack locally

- `npm run test:tax-engine` — unit coverage for the calculation engine and rounding.
- `npm test` — includes `tests/tax-pack-management.test.ts` (activation validation, install/download/audit, role-gating) and `tests/integration-tax.test.ts` (end-to-end order → bill → payment scenarios).
- In the running app: Settings → Tax Configuration has a **Test calculation** action (owner or manager) that runs a sample cart through the active pack without creating a real order.
- To dry-run a not-yet-published pack against the activation checklist without pushing a release tag, install it as a local/manual pack (`publisher: "local"`) through Settings, which uses the identical validation and engine code path, just skipping signature verification.

## Capability plugins (#142) — not built yet

The pack system above covers steps 1–9 of the implementation sequence in `docs/tax-engine-v2-spec.md`. Step 10 — the executable plugin seam for fiscal authorization, payment providers, delivery providers, and address-level jurisdiction lookups — has not been implemented. [PR #147](https://github.com/FreeOpenSourcePOS/FloCafe/pull/147) is an open draft proposing one approach; see that PR's discussion for current status before starting new work in this area, since it materially overlaps with the pack system described here.
