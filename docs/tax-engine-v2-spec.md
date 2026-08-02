# Tax Engine v2, Country Packs, and Plugin Boundary

Status: Finalized

Related issues: [#142](https://github.com/FreeOpenSourcePOS/FloCafe/issues/142), [#143](https://github.com/FreeOpenSourcePOS/FloCafe/issues/143)

The key decision is: **country tax packs are versioned, immutable data; merchant changes are separate overrides; executable integrations remain plugins.**

## Distribution

- One FloCafe installer per OS and CPU architecture.
- All supported UI translations remain bundled.
- No language-specific installers.
- FloCafe must install and operate without internet access.
- Installer includes:
  - Generic tax engine
  - English/Spanish/Portuguese translations
  - Generic manual tax profile
  - Initially supported official country profiles
  - Public keys needed to verify future country-pack downloads

Verified: 280KB translations vs 230MB installer.

### Amendment — 2026-07-31

The distribution and first-run recommendations above are retained as finalized design
history but are superseded for country-specific packs. New installers bundle and
auto-activate only the generic/manual no-tax profile. They do not bundle, install, or
activate an official country profile, including India or Thailand.

Country selection during first-run setup remains an offline locale, currency, and
timezone choice; setup does not contact the tax-pack catalog or display tax-pack
availability. An owner who wants official rules explicitly chooses **Enable taxes**
in Settings → Tax Configuration. FloCafe then checks the signed catalog for the
store country, downloads and verifies the matching pack, and activates it through
the existing owner-only flow. Stores may instead remain on the generic profile or
use manual configuration indefinitely.

This changes only new/default installations. Upgrades must preserve every installed
pack, active version, override, and historical tax snapshot; startup must never
delete or deactivate an existing country pack as part of this change.

### Upgrade safety guarantee

Taxation changes must be safe for every supported installation that upgrades from an older
FloCafe version:

- Create a verified database backup before any schema migration and retain the pre-migration
  copy for rollback.
- Use only additive, versioned migrations. Never delete or rename legacy tax columns in the
  first rollout, and never edit an already-applied migration.
- Preserve existing products, orders, bills, tax breakdowns, active pack, merchant overrides,
  open/held orders, and historical tax snapshots unless a documented migration adds a nullable
  field or audit record.
- Do not automatically activate a newly downloaded tax pack on an existing store. Download,
  validation, and activation remain separate; activation requires owner approval.
- Keep the legacy adapter for products using `tax_type`/`tax_rate`. Ambiguous products remain
  usable and appear in a review queue; migration must not silently make them tax-free.
- Historical finalized transactions always use their stored snapshot, never current rules.
- If migration or pack activation fails, keep the prior active configuration and allow the
  store to continue operating offline while surfacing recovery instructions.

Existing installations should therefore keep their data and remain usable after upgrading,
provided the implementation follows this contract and passes fresh-database, oldest-supported
fixture, interrupted-migration, rollback, and mixed legacy/new tax tests. The application
upgrade itself must not silently change a store's tax outcome.

## Architecture layering

Core (generic tax engine + translations + manual config + offline fallback) → Country profiles (signed, versioned, bundled + updatable data) → Capability plugins (#142, executable, isolated `utilityProcess`: fiscal auth, payments, delivery, complex jurisdiction lookups) → optional external paid services, never required.

Sequence: build #143's engine before #142's plugin seam — #142's own contracts already name `TaxEngine.calculate()` as the seam plugins hook into.

Country tax packs remain data-only.

Use the isolated plugin system from #142 only for:

- Fiscal authorization
- Payment providers
- Delivery providers
- External jurisdiction lookup
- Other executable compliance integrations

The initial release should be a curated **Country Pack Manager**, not a public marketplace.

## Country tax packs

A country pack is signed data, not executable JavaScript.

It can define:

- Country and jurisdiction
- Tax categories
- Inclusive/exclusive pricing defaults
- Percentage, fixed and compound taxes
- Category exemptions and reduced rates
- State/province rules
- Tax-on-tax dependencies
- Discount tax treatment
- Packaging, delivery, service-charge and add-on treatment
- Rounding rules
- Registration-number label
- Receipt tax labels
- Effective start/end dates
- Pack version, source and publication date
- Minimum compatible FloCafe version

It must not:

- Run scripts
- access SQLite directly
- change the database schema
- call arbitrary network endpoints
- silently change active tax behaviour

## Update lifecycle

The flow should be:

```text
Check catalog
→ download signed pack
→ verify signature and checksum
→ stage pack
→ validate rules
→ show changes
→ owner approves
→ activate atomically
→ retain previous version for rollback
```

Downloading can happen automatically. Activation cannot.

If FloCafe is offline, it continues using the installed profile without interruption.

## Merchant overrides

Country-pack records are never edited directly.

The effective configuration is:

```text
Official country pack
→ merchant override layer
→ resolved configuration
→ transaction snapshot
```

Update behaviour:

- Non-overridden values can adopt new official values after approval.
- Merchant overrides remain unchanged.
- If an official value beneath an override changes, show a conflict warning.
- Deleted or renamed rules require explicit resolution.
- “Reset to official value” removes the override.
- Every activation, override, reset and rollback is audited.

When updating a pack:

- Unmodified settings adopt the proposed new values after owner approval.
- Merchant overrides remain untouched.
- Conflicts are highlighted: “Official rate changed from 5% to 6%; your override remains 4%.”
- Removed or renamed rules require explicit resolution.
- Show a clear before/after summary and effective date.
- Preserve the previous pack version for rollback.
- Record installation, approval, overrides, and rollback in an audit log.

Resolved tax configuration becomes:

`versioned country pack → merchant overrides → transaction snapshot`

Every completed transaction must retain the exact applied rules/rates, so later pack updates never alter historical bills.

This is safer than merging JSON or copying pack values into editable settings. It also keeps support simple: reset an override to immediately return that setting to the official country-pack value.

One refinement: downloading an update may be automatic, but **activating tax changes must require approval**.

## Tax engine contract

Replace the `IN/TH/default` switch in `main/services/tax.ts` with a generic engine.

Suggested contract:

```ts
TaxEngine.calculate({
  country,
  jurisdiction,
  businessType,
  transactionDate,
  customer,
  lines,
  charges,
  activePackVersion,
}): TaxCalculation
```

Each line should supply:

- Product or charge identifier
- Tax category
- Quantity
- Unit price
- Discount
- Inclusive/exclusive behaviour
- Customer exemption information, if applicable

The result should include:

- Taxable base
- Individual tax components
- Compound-tax dependencies
- Inclusive and exclusive amounts
- Rounding adjustment
- Applied country-pack version
- Applied rule IDs
- Complete audit snapshot

All authoritative tax calculations must happen in the backend. The frontend only displays backend results.

### One source of truth for charge taxation

There will be only one calculation mechanism:

> Every taxable product, add-on or charge becomes a tax line with exactly one resolved `tax_category_id`. The country pack maps that category to rules.

The pack must not contain a second independent “charge calculation” path.

Category resolution order:

1. Transaction-specific legally permitted override or exemption
2. Merchant override assigning a category to that charge/product
3. Explicit category stored on the product or add-on
4. Parent-product category for an add-on configured to inherit
5. Country-pack default category for the charge kind:
   - `packaging`
   - `delivery`
   - `service_charge`
   - `addon`
6. Pack-defined `unclassified` category

Activation validation must reject a pack without required defaults. The engine must never silently treat an unresolved category as tax-free.

During migration, products still using `tax_rate` are handled by a clearly identified legacy adapter. New configuration must use categories.

## Rounding policies

Tax rounding and payable-total rounding are separate policies.

Every country pack must declare:

```json
{
  "taxRounding": {
    "scope": "unit | line | document",
    "method": "half_up | half_even | floor | ceiling",
    "decimalPlaces": 2,
    "remainderAllocation": "largest_remainder"
  },
  "payableRounding": {
    "increment": "0.01",
    "method": "half_up"
  }
}
```

Semantics:

- `unit`: round each unit’s tax before multiplying by quantity.
- `line`: calculate the complete line and round each tax component.
- `document`: aggregate each component at high precision and round once.
- `remainderAllocation` deterministically reconciles line/component totals with the document total.
- `payableRounding` handles cash or final-total rounding independently of tax calculation.

Implementation requirements:

- Use decimal/fixed-point arithmetic, not ordinary floating-point calculations for authoritative tax.
- Pack activation fails if the rounding policy is absent or invalid.
- Transaction snapshots store the complete rounding policy and any allocated remainder.
- Receipts and reports use the stored results rather than recalculating them.
- Replace the current unconditional whole-number `Math.round()` behaviour with the active pack’s payable-rounding policy.

Currency-decimal default: no new boolean flag — reuse `payableRounding.increment`, seed it from ISO 4217 minor-unit digits via `Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits` (confirmed works, zero dependency), pack can override for real cash-rounding rules (Swiss/AU 5c rounding).

Confirmed this replaces a real live bug — `tax.ts:170`, `orders.ts:333/521/876/1062`, `bills.ts:491` currently do unconditional whole-number rounding, wrong for every non-INR/THB currency already listed in `countries.ts`.

## Product tax model

Products should no longer primarily store a manually entered percentage.

Add:

- `tax_category_id`
- `tax_behavior`: `country_default`, `inclusive`, `exclusive`, or `exempt`

Examples of categories:

- Prepared food
- Non-prepared food
- Alcohol
- Tobacco
- General merchandise
- Service
- Delivery
- Packaging
- Exempt

Keep the existing `tax_type` and `tax_rate` temporarily for upgrade compatibility. Do not remove them in the initial migration.

Add-ons, packaging, delivery and service charges also need tax-category handling. They cannot always inherit the main product’s rate.

## Historical integrity

Existing `tax_breakdown` stores only labels, rates and amounts. That is not enough for regulatory auditing.

Each finalized transaction needs a tax snapshot containing:

- Pack ID and version
- Pack signature/digest
- Effective date
- Rule IDs
- Category used for every line
- Taxable base
- Rate and calculation type
- Inclusive/exclusive behaviour
- Merchant overrides applied
- Rounding
- Final component amounts

Later pack updates must never alter existing orders, bills, refunds or reports.

Refunds must use the original transaction snapshot—not current tax rules.

## Database changes and migration mechanics

Use additive, non-destructive migrations in `main/db.ts`.

Likely new tables:

- `country_packs`
- `country_pack_versions`
- `tax_categories`
- `tax_rules`
- `tax_overrides`
- `tax_config_audit`

Likely new columns:

- `products.tax_category_id`
- `products.tax_behavior`
- Equivalent category fields for add-ons and charges
- `orders.tax_snapshot`
- `order_items.tax_snapshot`
- `bills.tax_snapshot`

Legacy tax fields remain until all existing installations and CSV workflows are safely migrated.

Every tax schema change must be added to the `MIGRATIONS` registry in `db.ts`. Editing `createSchema()` alone is insufficient.

Requirements:

- Append migrations after the current latest version; never edit an existing migration.
- Determine the next version from the current branch rather than assuming it remains v35.
- Use `CREATE TABLE IF NOT EXISTS`.
- Before every added column, check `getColumns()` and use guarded `ALTER TABLE … ADD COLUMN`.
- Never drop or rename legacy tax columns during the initial rollout.
- Use a separate version increment for each logical schema change.
- Keep `createSchema()` updated for clarity, while migrations remain authoritative for upgrades.
- Let the existing migration runner transaction, backup, and `PRAGMA user_version` handling apply normally.

Required verification:

- Fresh installation produces the complete schema.
- Upgrade from the oldest supported fixture produces the same schema.
- Upgrade preserves existing products, orders, bills and tax breakdowns.
- Re-running startup is idempotent.
- `tests/upgrade-path.test.ts` and schema-health tests explicitly cover every new table and column.

## POS changes

### First-run setup

Update `frontend/src/app/setup/page.tsx`:

- Keep language selection.
- Country selection recommends the matching bundled profile.
- Display a simple message such as:
  - “India tax profile included”
  - “No official profile available—manual tax setup will be used”
- Check for updates after setup without blocking completion.
- Never require internet access.

### Settings → Tax

The current tax settings are only registration, GSTIN, state and scheme. Replace them with a dedicated Tax Configuration area:

- Active country profile
- Installed and available version
- Publication/effective date
- Tax registration and jurisdiction
- Profile status: Official, Customized, Update available
- Check for updates
- Review update
- Activate
- Roll back
- View merchant overrides
- Reset individual override
- Test calculation
- Audit history

Activation and rollback should be owner-only. Managers can view and run test calculations.

Relevant files:

- `frontend/src/app/(dashboard)/settings/page.tsx`
- `main/routes/settings.ts`

### Products

Update `frontend/src/app/(dashboard)/products/page.tsx`:

- Replace the normal tax-rate input with a tax-category selector.
- Keep inclusive/exclusive as a pricing-behaviour option.
- Show the currently resolved rate as read-only information.
- Allow explicit product overrides only in an advanced section.
- Add bulk category assignment.
- Warn when a product remains on legacy `tax_rate`.

CSV import/export in `main/routes/menu-csv.ts` should add:

- `tax_category`
- `tax_behavior`

Continue accepting `tax_type` and `tax_rate` from old CSV files during the transition.

### Cart and checkout

- Keep using `/tax/preview`, but return richer rule information.
- Show the combined tax normally, with expandable details.
- Recalculate when customer, jurisdiction, discount, packaging or delivery changes.
- Prevent checkout if authoritative tax calculation fails.
- Do not fall back silently to zero tax.
- If rules change while an order is open, warn before repricing.
- Store the final immutable snapshot during checkout.

Relevant areas:

- `frontend/src/hooks/use-tax-preview.ts`
- `main/routes/orders.ts`
- `main/routes/bills.ts`
- Payment and checkout modals

### Customers

For jurisdictions that require it, support:

- Tax registration number
- State/province/jurisdiction
- Exempt status
- Exemption reason or certificate reference

These fields should only appear when required by the active country profile.

### Receipts and invoices

Current printing contains assumptions such as `GSTIN`, `CGST` and `SGST`. Printing must become profile-driven.

Change:

- Registration-number label
- Tax component names
- Inclusive-tax wording
- Required jurisdiction fields
- Rounding display
- Exemption messages

Fiscal authorization—ARCA, Indian IRN and similar—is not part of the tax pack. That remains an executable capability plugin under #142.

Relevant files:

- `main/printers/thermal.ts`
- `frontend/src/lib/printer/receipt-encoder.ts`
- `frontend/src/lib/printer/gst-bill-encoder.ts`
- `frontend/src/app/(dashboard)/print-test/page.tsx`

### Reports

Add reporting by:

- Tax component
- Tax category
- Jurisdiction
- Country-pack version
- Merchant override
- Exempt sales
- Inclusive versus exclusive tax

Reports must use stored transaction snapshots rather than recalculating historical data.

## Decisions A–N

### A — Catalog and signing

**Original question:** Where is the pack catalog hosted, who actually holds/rotates the signing key?

**Exact rationale:** Real infra decision — I flagged this earlier as something I can't invent for you. Nothing built depends on it yet, but "signed pack" is meaningless without an answer.

**Final decision:** Host curated tax-pack artifacts, and future capability-plugin artifacts, in the public [`FreeOpenSourcePOS/FloCafe-Plugins`](https://github.com/FreeOpenSourcePOS/FloCafe-Plugins) repository using GitHub Releases for immutable assets. Pack source JSON, signing code, and the publishing workflow stay in FloCafe, whose Releases tab remains for application installers. FloCafe pins offline root public keys. An offline root key authorizes a delegated release-signing key used through a protected GitHub Actions environment with required reviewer approval. Use Ed25519 signatures and SHA-256 artifact digests.

### B — Revocation

**Original question:** Key compromise/revocation process?

**Exact rationale:** Not mentioned at all so far.

**Final decision:** Publish a signed, monotonically versioned revocation list covering signing keys, pack versions and artifact digests. Revoked packs cannot be installed, activated or rolled back to. An already-active revoked data pack is marked prominently and cannot be selected for new activation, but FloCafe does not silently replace its rules or interrupt an active sale. A replacement requires explicit approval. Historical snapshots remain valid. Release-key rotation is authorized by the offline root key; root-key compromise requires an application release containing a new trust root.

### C — Fixed inclusive tax

**Original question:** Compound tax under **inclusive** pricing when a rule is `type: fixed` (not percent)?

**Exact rationale:** Percent+compound-percent is solvable in closed form (linear). Fixed-amount rules mixed with inclusive pricing aren't well-defined yet.

**Final decision:** A fixed inclusive tax declares `amount` and `appliesPer: unit | line`. It is subtracted from the gross amount before solving percentage-based inclusive taxes. A percentage rule may include a fixed rule in `baseRuleIds`. A fixed rule may not depend on another tax rule; validation rejects this as ambiguous. Fixed tax exceeding the gross taxable amount is an error.

### D — Remainder tie-break

**Original question:** Largest-remainder tie-break when two components have equal remainder?

**Exact rationale:** I suggested "break ties by rule ID" — never confirmed.

**Final decision:** Largest-remainder allocation sorts by remainder descending, then stable `ruleId` lexicographically, then stable `lineId` lexicographically. This guarantees identical results on every platform and retry.

### E — Fixed-point implementation

**Original question:** Fixed-point implementation: integer minor-units vs a decimal library (e.g. decimal.js)?

**Exact rationale:** Flagged as "pick the tool," never picked. No such dependency exists in `package.json` today.

**Final decision:** Use `decimal.js` for authoritative calculations. Integer minor units are insufficient for inclusive extraction, compound percentages and intermediate precision. Never calculate tax using JavaScript `number`. Amounts inside snapshots and APIs use canonical decimal strings; convert to legacy numeric database fields only at compatibility boundaries.

### F — Manual configuration

**Original question:** How does "manual tax setup" (no official profile available) relate to the override layer?

**Exact rationale:** Is manual config just a synthetic one-off pack, or a separate code path? Not stated.

**Final decision:** Manual setup creates a synthetic local country pack using the same schema and engine. It is identified as `publisher: local`, cannot be distributed, and does not require a signature. Every edit produces a new immutable local-pack version plus an audit entry. There is no separate manual calculation path. Switching to an official profile retains the local profile for rollback but does not automatically overlay it onto the official pack.

### G — Multi-location

**Original question:** Multi-location / multi-country per install?

**Exact rationale:** Spec assumes one active jurisdiction ("restaurant computer," per #142). Franchise-with-many-locations scenario never ruled in or out.

**Final decision:** Version 1 supports one active store, country and jurisdiction per FloCafe database. Multiple terminals may use that store. Franchises use separate databases/installations per location. Contracts retain `storeId` so multi-location can be added later, but simultaneous multi-country taxation is out of scope.

### H — Pack/plugin boundary

**Original question:** Exact line between "pack can express this jurisdiction" vs "needs a #142 plugin"?

**Exact rationale:** US address-level tax was assigned to plugins, but where simple state-rate tables stop and rooftop lookup starts isn't drawn precisely — this is literally one of #143's own open questions, still open.

**Final decision:** A country pack may express deterministic rules that can be calculated offline from known transaction data: country, state/province, category, customer status, date and locally stored jurisdiction identifiers. A #142 plugin is required when functionality needs external resolution, credentials, network access, provider interaction, licensed/very large address datasets, digital signing, submission or authorization. Simple state/province rate tables belong in packs; US rooftop/address resolution belongs in a plugin.

### I — Held orders

**Original question:** A held/parked order that spans a pack activation?

**Exact rationale:** "Warn before repricing" was stated for *open* orders at checkout; held orders aren't addressed.

**Final decision:** A pack declares `taxPoint: order_created | finalized_at`. Orders store their tax context. Pack activation never rewrites open or held orders. With `order_created`, the original context remains authoritative. With `finalized_at`, resuming or checking out a stale order requires mandatory recalculation using the rules effective at finalization; the POS clearly displays the changed total before payment.

### J — Mixed historical reports

**Original question:** Reports over mixed history (old orders with only `tax_breakdown`, new ones with full snapshot)?

**Exact rationale:** Not addressed.

**Final decision:** Reports use full snapshots when present. Pre-migration transactions are wrapped in a minimal `legacy` snapshot using their stored `tax_breakdown`, totals and dates—never recalculated or guessed from current rules. Reports label category, rule and pack information as “Unknown/Legacy” where unavailable and can filter Snapshot-backed versus Legacy records.

### K — Existing-product migration

**Original question:** On migration, do existing products get an automatic best-effort category mapping from `tax_type`/`tax_rate`, or does every product start `unclassified`?

**Exact rationale:** Determines how disruptive the upgrade feels to an existing restaurant.

**Final decision:** Perform automatic mapping only when `(country, tax_type, tax_rate)` maps uniquely to one official category. Record the mapping in the migration audit. Ambiguous products remain on the named legacy adapter and continue working unchanged. The UI presents a migration-review list; it must not guess or silently make products exempt.

### L — Pack validation

**Original question:** Exact fields "activation validation" must check before accepting a pack?

**Exact rationale:** Stated as a requirement, fields never enumerated.

**Final decision:** Validation must cover the exact checklist below. A failure prevents staging from becoming activatable.

### M — Newer required FloCafe version

**Original question:** Behavior when a downloaded pack's `minFloVersion` exceeds the installed app version?

**Exact rationale:** Reject, warn, or block the whole update — not stated.

**Final decision:** The catalog selects the newest compatible pack by default. A pack whose `minFloVersion` is newer may be downloaded to staging, but cannot be activated. Show “Update FloCafe to use this profile.” It never replaces or disables the current profile and never blocks normal POS operation.

### N — Cross-line compounding

**Original question:** Is compound tax ever cross-line (e.g. a service charge taxed on the order subtotal's tax), or always within one line?

**Exact rationale:** The engine signature takes the whole cart, but `baseRuleIds` only reference other *rules*, not other *lines* — cross-line compounding isn't modeled either way.

**Final decision:** Version 1 tax dependencies are line-local. `baseRuleIds` may reference rules applied to the same taxable line only. Packaging, delivery and service charges become separate taxable lines after their charge amount is calculated. Document-level rounding is supported, but document-level tax-on-tax across unrelated lines is not. Pack validation rejects it; a jurisdiction requiring it needs a future engine-contract revision, not an improvised formula.

## Exact activation validation

A staged pack is activatable only when all of these pass:

1. Manifest and schema versions are supported.
2. Pack ID, publisher, country and jurisdiction scope are valid.
3. Version and effective-date ranges are valid and non-conflicting.
4. `minFloVersion` and optional maximum compatibility are satisfied.
5. Artifact SHA-256 matches the signed manifest.
6. Manifest signature chains to a trusted, non-revoked key.
7. Pack version and digest are not revoked.
8. Category and rule IDs are unique and stable.
9. Required `unclassified`, packaging, delivery, service-charge and add-on defaults exist.
10. All category and rule references resolve.
11. Rule dependency graph is acyclic.
12. Dependencies are line-local.
13. Rates, fixed amounts, precision and increments are within valid bounds.
14. Fixed rules do not depend on other tax rules.
15. Inclusive fixed-tax combinations can produce a non-negative net amount.
16. Every tax behaviour and jurisdiction selector is recognized.
17. Tax and payable-rounding policies are complete.
18. Currency and decimal settings are valid.
19. Renamed or removed IDs provide aliases/migration metadata for existing overrides.
20. Merchant-override conflicts have been reviewed.
21. Required default-language labels exist.
22. The pack contains data files only—no executables, scripts or unsafe archive paths.
23. Mandatory signed test vectors produce the expected component amounts, totals and rounding.
24. Activation can be completed atomically without modifying historical transactions.

## Four additional POS implications

These decisions add four concrete POS requirements:

- Tax Settings must show trust status: **Official**, **Local**, **Revoked**, **Incompatible**, or **Customized**.
- Held/open orders must display their pinned tax profile and stale-context warnings.
- Product Settings needs a “Review legacy tax mappings” workflow after upgrade.
- Reports must visibly distinguish full-snapshot records from legacy tax records.

## Implementation sequence

1. Specify tax engine and country-pack schemas.
2. Create India, Thailand and generic reference packs.
3. Add non-destructive database migration.
4. Implement the generic backend engine.
5. Migrate products to categories while preserving legacy fields.
6. Integrate preview, ordering, billing and refunds.
7. Update setup, tax settings and product screens.
8. Make receipts and reports profile-driven.
9. Add signed pack download, review, activation and rollback.
10. Add the executable plugin seam from #142 afterward.

Catalog naming, root-key custodians and GitHub environment ownership still require project-owner setup, but their technical model is defined and they do not block the engine or migration design.
