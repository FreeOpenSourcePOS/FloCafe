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
2. Give it a unique `id` using the lowercase, hyphenated full country name (for example, `official-india`, `official-thailand`, or `official-united-states`). Keep `country` as its ISO alpha-2 code (for example, `IN`, `TH`, or `US`), because FloCafe uses that field to match the store. Set `publisher` to your name/org (anything other than `local` — `local` is reserved for the in-app manual/unbundled pack and can never be published), and fill in `jurisdiction`, `currency`, `taxRounding`, `payableRounding`.
3. Define `categories` and `rules`. Every category referenced by `defaultCategories` or by a product must exist. `unclassifiedCategoryId` must point at a real category (usually a zero-rate one).
4. Add the file to `main/tax-packs/` in this repo (not a new repo — see "Where packs live" below) and open a PR. Only the generic/manual no-tax pack is bundled with and auto-activated by a new installation. India, Thailand, and every other official country pack are catalog-only: an owner explicitly enables the matching pack from Settings → Tax Configuration, where FloCafe downloads, verifies, installs, and activates it.
5. Add test vectors: extend `tests/tax-pack-management.test.ts` (activation validation) and, ideally, `tests/tax-engine.test.ts` / `tests/integration-tax.test.ts` with a scenario proving your rules produce the expected components, totals, and rounding for at least one representative order.
6. Run `npm run test:tax-engine` and the full `npm test` before opening the PR.

## Country pack scopes

This section records the merchant scope, legal source, and intentional exclusions for each official country pack. A pack's JSON only encodes what its scope covers — anything listed under "intentionally unsupported" is *not* a bug, *not* a placeholder for a future update, and *not* something to add to the same pack without a scope bump and a new version.

### Argentina (`official-argentina`)

- **Approved merchant scope:** AR merchants' domestic sales of standard supplies to *consumidor final* (end consumer) at the general 21% IVA rate — the everyday restaurant POS case, which covers roughly 99% of transactions. The pack computes the 21% that the consumer-facing price already includes (Factura B-style, IVA embedded in the displayed total). The same 21% rate also applies to B2B Factura A transactions between *Responsables Inscriptos* (same number, different invoice presentation), so this pack is also usable there — invoicing presentation is an upstream concern, not a tax-calculation one. Default pricing stays tax-inclusive because Argentina consumer-price-display law (Secretariat of Industry and Commerce Resolution 4/2025) requires the displayed price to be the total and final amount paid by the consumer; individual products can still be marked exclusive per-item.
- **Tax covered:** one IVA rule at the general rate of **21%** applied across every category (`standard`, `packaging`, `delivery`, `service_charge`, `addon`, `unclassified`). Inclusive-of-IVA consumer display is the default; exclusive pricing can be selected per product, per add-on, or per configurable charge.
- **Legal source:** Ley de Impuesto al Valor Agregado, texto ordenado en 1997 (Ley N° 23.349 t.o. **Decreto N° 280/1997**, Anexo I), **Artículo 28**: *“La alícuota del impuesto será del veintiuno por ciento (21 %).”* Continuously in force since publication in Boletín Oficial 15/04/1997. Cross-references: ARCA / AFIP *Biblioteca* cuadro legislativo de alícuotas de IVA; InfoLeg norma 42701; SAIJ.
- **Intentional unsupported (do not add to this pack without a scope bump):**
  - **IIBB (Ingresos Brutos).** Provincial — administered by each *Dirección General de Rentas* — with rates that vary by province, registered activity, and registration status (typical bands: commercial services up to ~4.5%, industry up to ~3%, others up to ~6%). FloCafe does not model province-level merchant activity or customer registration status, so IIBB cannot be calculated correctly from data already on a transaction. No IIBB component is emitted under any breakdown or snapshot. Adding IIBB to this pack without those inputs would silently under- or over-report.
  - **Reduced-rate IVA (10.5%).** Applies to specific unprocessed goods (meat, fruit, vegetables, agricultural services, transport, housing construction, some medical services, Tierra del Fuego electronics). Requires per-product NCM/activity classification FloCafe does not model.
  - **Incremented-rate IVA (27%).** Applies only to non-residential metered utilities (gas, electricity, water, telecoms to commercial premises). Out of scope for restaurant supplies.
  - **2.5% super-reduced (printed newspapers/magazines)** and **0% (exports).** Not applicable to domestic restaurant sales.
  - **Monotributo.** Simplified-regime merchants issue *Factura C* without itemized IVA and follow a separate monthly unified payment. This pack assumes the standard IVA-registered regime (Responsable Inscripto issuing Factura A/B with IVA at 21%); a Monotributo merchant would need a separate zero-IVA pack variant because the invoicing and tax-registration paths are structurally different.
  - **Withholding and perception regimes** (RG 4240 IVA perception, etc.) and **fiscal-invoice authorization (CAE via ARCA)**: both require external authorizations and are part of the executable capability-plugin seam tracked in [#142](https://github.com/FreeOpenSourcePOS/FloCafe/issues/142), not a tax-pack concern.
- **Upgrade path for provincial IIBB.** A future pack version `official-argentina@1.x.0` (or a successor pack) may add IIBB *only after* FloCafe models the inputs it needs: the merchant's registered province (ARCA jurisdiction), the IIBB activity code(s), and the customer's tax-status (Responsable Inscripto vs Monotributo vs Exento). Until those inputs exist end-to-end, a pack cannot compute IIBB correctly and must not claim to.
- **Sources checked:** ARCA *Biblioteca* cuadro legislativo (alícuotas Art. 28); InfoLeg norma 42701 with notas Infoleg (Ley 27.702 extension to 2027, Decreto 567/2019 0% canasta); SAIJ texto actualizado; Secretaría de Industria y Comercio Resolución 4/2025 (price display); Avalara Argentina VAT compliance guide.

## Where packs live, how they get signed, and how they're published

Pack source and release artifacts have separate homes. Reviewable source, signing code, and the release workflow stay in this repository; signed tax-pack artifacts (and future capability-plugin artifacts) are published to [`FreeOpenSourcePOS/FloCafe-Plugins`](https://github.com/FreeOpenSourcePOS/FloCafe-Plugins), keeping FloCafe's Releases tab for application installers.

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

1. Downloads the previous cumulative `catalog.json` (if one exists) from the `FloCafe-Plugins` releases.
2. Signs the exact pack JSON bytes with the Ed25519 signing key (`scripts/tax-packs/prepare-release.cjs`).
3. Publishes the pack JSON, a detached `.sig`, and the updated `catalog.json` as immutable release assets under that tag.

At runtime, FloCafe fetches `catalog.json` from the `FloCafe-Plugins` GitHub Releases when an owner requests a pack or checks for updates. It downloads the selected pack, verifies its Ed25519 signature against the hardcoded public key and its SHA-256 digest, and runs it through the same 24-point activation checklist used for the generic bundled pack (`validationChecklist()` in `main/routes/tax-packs.ts`). The first country-specific installation and activation is an explicit, owner-only action, and a previous version stays available for rollback.

## Testing your pack locally

- `npm run test:tax-engine` — unit coverage for the calculation engine and rounding.
- `npm test` — includes `tests/tax-pack-management.test.ts` (activation validation, install/download/audit, role-gating) and `tests/integration-tax.test.ts` (end-to-end order → bill → payment scenarios).
- In the running app: Settings → Tax Configuration has a **Test calculation** action (owner or manager) that runs a sample cart through the active pack without creating a real order.
- To dry-run a not-yet-published pack against the activation checklist without pushing a release tag, install it as a local/manual pack (`publisher: "local"`) through Settings, which uses the identical validation and engine code path, just skipping signature verification.

## Capability plugins (#142) — not built yet

The pack system above covers steps 1–9 of the implementation sequence in `docs/tax-engine-v2-spec.md`. Step 10 — the executable plugin seam for fiscal authorization, payment providers, delivery providers, and address-level jurisdiction lookups — has not been implemented. [PR #147](https://github.com/FreeOpenSourcePOS/FloCafe/pull/147) is an open draft proposing one approach; see that PR's discussion for current status before starting new work in this area, since it materially overlaps with the pack system described here.
