# Taxation

FloCafe has one tax calculation engine and data-only country tax packs. A pack describes a
jurisdiction's categories and rules; the engine decides what a transaction owes. There is no
per-jurisdiction code path, and the host never executes pack content. The reasoning behind that
split is in [0004: data-only tax packs](../decisions/0004-data-only-tax-packs.md).

The pack schema, the trust model, and the install mechanics are in the
[tax pack reference](../reference/tax-packs.md). How to author one is in
[adding a tax pack](../guides/adding-a-tax-pack.md).

## One calculation path

`TaxEngine.calculate()` in [`main/services/tax-engine.ts`](../../main/services/tax-engine.ts) is
the only authoritative calculation. Every caller that owes a tax amount goes through it, whether
the result lands on a bill, a receipt, a refund, or a report.

`previewCategoryRate()` in [`main/services/tax.ts`](../../main/services/tax.ts) is the one
deliberate exception, and the code says so at the definition:

> Computes a display-only preview tax rate for UI category pickers. Authoritative calculation
> always goes through TaxEngine.calculate.

It returns a `number` for a category picker and is never used to decide what is owed.

Money is arithmetic in `decimal.js`, never a JavaScript `number`. The engine clones the decimal
constructor once, at module load, with 40 significant digits and `ROUND_HALF_UP` as the default, and
every amount enters and leaves the engine as a string. A preview rate being a `number` is the
documented display exception, not a general licence.

## Category resolution

`resolveTaxCategory()` in `main/services/tax-engine.ts` picks the tax category for a line by
walking seven precedence steps and returning at the first that applies. `CategoryResolution` names
each step in its `source` field.

| Step | `source` | Condition | Result |
| --- | --- | --- | --- |
| 1 | `transaction_exemption` | The line is marked exempt on this transaction. | No category, no tax. |
| 2 | `transaction_override` | The line carries `transactionCategoryId`. | That category. |
| 3 | `merchant_override` | The line carries `merchantCategoryId`. | That category. |
| 4 | `explicit` | The line carries `taxCategoryId` or `productCategoryId`. | That category. |
| 5 | `parent` | The line is an `addon` with `inheritParentCategory` set and a `parentProductCategoryId`. | The parent product's category. |
| 6 | `charge_default` | The pack declares a default category for the line's `kind`. | The kind's default. |
| 7 | `unclassified` | None of the above. | The pack's `unclassifiedCategoryId`. |

The order is load-bearing in two places. A transaction exemption outranks everything, so a line
marked exempt cannot be taxed by a later step. The `parent` step is narrow on purpose: an add-on
inherits its parent product's category only when it says so, so a pack can treat add-ons
separately where a jurisdiction does.

A resolved category id that the pack does not define is an error, not a silent zero. The engine
throws rather than falling through to `unclassified`.

## Rounding

Two independent policies decide how amounts round, and they are set separately on the pack.

**Tax rounding** is `taxRounding`, applied to the tax components themselves. It has a `scope`, a
`method`, a `decimalPlaces`, and a `remainderAllocation` of `largest_remainder`.

| `scope` | What is rounded |
| --- | --- |
| `unit` | Each component is divided by the line quantity, rounded, then multiplied back. A `fixed` rule with `appliesPer: 'line'` is the exception and rounds per line regardless. |
| `line` | Each component on each line is rounded on its own. |
| `document` | Every component across the whole document is floored, and the units needed to reach the document total are handed out by largest remainder. |

`method` is one of `half_up`, `half_even`, `floor`, or `ceiling`.

In `document` scope the tie-break order is fixed and deterministic: remainder descending, then
`ruleId` ascending, then `lineId` ascending. The same transaction therefore allocates the same
extra units on every machine and on every run.

**Payable rounding** is `payableRounding`, which has its own `increment` and its own `method`. It
decides the smallest amount a customer can actually be charged, which is a cash-handling question
rather than a tax-arithmetic one, so it is never inferred from `taxRounding`. A pack that declares
`currency: 'XXX'` and a configured currency with more fraction digits resolves its increment from
the configured currency instead, so a placeholder-currency pack still produces a payable amount in
real minor units.

`decimalPlaces` is bounded at install: an integer from 0 to 6. The payable increment must be finite,
positive, and at most 1000.

## Input shape

`TaxEngineInput` is the whole contract:

```ts
interface TaxEngineInput {
  pack: CountryPack;
  currency?: string;
  country: string;
  jurisdiction?: string;
  businessType?: string;
  storeStateCode?: string;
  transactionDate: string;
  customer?: TaxCustomer | null;
  lines: TaxEngineLine[];
}
```

Two things follow from that shape and are worth stating because they are easy to assume otherwise.

**There is no `charges` array.** Everything billed is a `lines` entry with a `kind` of `product`,
`addon`, `packaging`, `delivery`, or `service_charge`. Step 6 of category resolution looks up
`defaultCategories[line.kind]`, which is why the pack declares a default for each of those kinds.

**There is no `activePackVersion` field.** The version being applied is `pack.version`, and the
version's identity string is the caller's to track, not the engine's.

A `TaxEngineLine` carries its own identity (`lineId`), amounts as strings, and a set of narrowing
category hints. The engine rejects a non-positive quantity, a negative price or discount, and a
discount larger than the gross amount. A discount exceeding the gross amount is clamped to zero
with a warning rather than rejected, because a discount row that is temporarily larger than the
price is a data-entry state, not a tax problem.

## Fixed and percent rules together

A `percent` rule may name `baseRuleIds`, making it compound: the base rules are solved first and the
compounding rule applies to the result. The dependency graph is resolved at calculation time and
must be acyclic; a cycle throws. A `baseRuleIds` entry may not contain `:` or `/`, and must name a
rule on the same tax line.

A `fixed` rule may not declare `baseRuleIds` at all. A fixed amount is a flat charge, and letting it
compound would make the result depend on evaluation order in a way no jurisdiction means.

For inclusive pricing, the engine removes the total of all fixed components from the line gross
first, then solves the percent rules against what remains, and divides by the resulting divisor to
recover the pre-tax base. A fixed inclusive total larger than the line gross, or inclusive taxes
that drive the taxable base negative, are errors rather than clamped values.

## Where the amount came from

Three layers, in precedence order: the versioned pack, then a merchant override, then the
immutable snapshot written onto the transaction.

A merchant override is keyed to an entity (product, add-on, packaging, delivery, or service charge)
and must resolve against the pack version being evaluated. Activation check 20 refuses a version
that any live merchant override would not resolve against, so an override can never silently point
at a category the new version dropped.

Once a transaction is written, its tax is a snapshot, not a live calculation. `tax_snapshot` is
stored on `orders`, `order_items`, and `bills`, holding the item-level line amounts as strings.
`aggregateTaxSnapshots()` in `main/services/tax.ts` folds the item snapshots into an order or bill
level array, and `invertTaxSnapshot()` negates the line amounts for a void or refund adjustment
row, so an adjustment reverses the recorded numbers rather than recomputing them.

A split bill produces child snapshots carrying `splitAllocation: 'minor-unit-v1'`, recorded by
`SPLIT_TAX_SNAPSHOT_VERSION` in `main/routes/bills.ts` and read back in
`main/services/tax-components.ts`. That discriminator exists so a reader can tell a split
allocation apart from an ordinary snapshot, and so the split's minor-unit arithmetic is not
reinterpreted as a per-line amount.

Refunds read the snapshot. Recomputing tax at refund time would produce a different answer if the
pack had been updated in between, which is the exact failure the snapshot exists to prevent.

The reporting counterpart is `GET /api/reports/tax-components`, backed by
[`main/services/tax-components.ts`](../../main/services/tax-components.ts). It derives components
item by item so a bill that mixes categorized and uncategorized lines cannot double-count the
categorized portion against the bill-level `tax_breakdown`.

## Bundled packs

`BUNDLED_COUNTRY_PACKS` in [`main/tax-packs/bundled.ts`](../../main/tax-packs/bundled.ts) contains
exactly one entry: `main/tax-packs/generic.json`. It is a placeholder pack with a hidden zero-rate
`unclassified` category, not a country profile. `getBundledCountryPack()` falls back to it for any
country without a bundled match.

Fourteen community packs also ship in the repository under
`main/tax-packs/community-*.json`. They are reference data in the source tree, not bundled
installables: `BUNDLED_COUNTRY_PACKS` does not include them.

First-run setup never contacts the catalog. The catalog is fetched by the best-effort startup
update check in `main/index.ts` and by the tax-pack routes, so a store with no network completes
setup and starts with the generic pack.

## Trust model

Four paths can make a pack version valid at activation. Check 6 in
[`main/routes/tax-packs.ts`](../../main/routes/tax-packs.ts) decides between them:

1. **Bundled.** The artifact is byte-identical to a bundled definition.
2. **Local.** The pack declares `publisher: 'local'` and has no signature. This is the path manual
   tax configuration takes, and the catalog path refuses it, so a pack cannot claim local publisher
   status to bypass signing.
3. **Signed.** A valid Ed25519 signature against
   `TRUSTED_TAX_PACK_SIGNING_PUBLIC_KEY`, verified over the signed artifact JSON.
4. **Legacy digest.** An unsigned artifact whose SHA-256 matches a pinned entry in
   `LEGACY_TRUSTED_PACK_DIGESTS`.

The legacy digest path is a deliberate, test-pinned compatibility exception, and it is the one part
of the trust model worth calling out as a security-relevant decision. `LEGACY_TRUSTED_PACK_DIGESTS`
in `main/routes/tax-packs.ts` pins four digests, for `official-india`, `official-thailand`,
`official-in`, and `official-th`, of pre-signing artifacts. An unsigned artifact that hashes
exactly to one of them stays trusted. `tests/legacy-tax-pack-digest.test.ts` pins the behaviour so it
cannot be removed by accident. Any new pack must go through signing; the digest list is not an
extension point.

There is one trusted Ed25519 public key, in
`main/tax-packs/trusted-signing-key.ts`. There is no root key, no delegated key, and no rotation
mechanism.

`publisher: 'local'` is reserved for synthetic packs the app builds itself, and check 26 refuses a
local pack that also declares `sourceType: 'community'`, so the community disclaimer can never be
skipped by manufacturing a local pack. A pack with `sourceType: 'community'` is public-information
material and requires the merchant to acknowledge the disclaimer.

## Activation checks

`validationChecklist()` in `main/routes/tax-packs.ts` runs **26** checks. All 26 must pass;
`valid` is `checks.every(passed)`. If the stored pack JSON will not parse, the function returns
early with a single failed check and stops.

| # | Check |
| --- | --- |
| 1 | Supported manifest and schema version |
| 2 | Valid pack identity, publisher, country, and jurisdiction scope |
| 3 | Valid, internally consistent version and effective-date range |
| 4 | FloCafe satisfies the pack's minimum compatible version |
| 5 | Stored artifact digest matches |
| 6 | Artifact is bundled, or local and unsigned, or has a valid trusted Ed25519 signature, or matches a pinned legacy digest |
| 7 | Pack version is not `revoked` or `incompatible` |
| 8 | Category and rule ids are unique |
| 9 | Required default categories and the unclassified category exist |
| 10 | All category, rule, and dependency references resolve |
| 11 | The rule dependency graph is acyclic |
| 12 | All dependencies reference rules on the same tax line |
| 13 | Rates, fixed amounts, precision, and payable increment are within bounds |
| 14 | Fixed rules have no tax-rule dependencies |
| 15 | Inclusive fixed-tax combinations produce a non-negative net amount |
| 16 | Every tax behavior and jurisdiction selector is recognized |
| 17 | Tax and payable rounding policies are complete |
| 18 | Currency code and decimal settings are valid |
| 19 | Existing category and rule ids remain available, so override aliases are not required |
| 20 | Every current merchant override resolves against this version, or the pack is local |
| 21 | Default-language labels are present on every category and rule |
| 22 | Artifact is data-only and contains no executable or unsafe path values |
| 23 | Mandatory component, total, interstate, and rounding vectors are self-consistent |
| 24 | Activation uses one SQLite transaction and does not modify transactions |
| 25 | A declared registration-number format is a well-formed, non-catastrophic pattern |
| 26 | A local or manual pack never declares a community `sourceType` |

Check 22 is the one that enforces the data-only rule at the door. `containsUnsafeData()` rejects an
artifact carrying anything executable or a path value that could escape the expected shape.

Check 23 runs the pack's own mandatory vectors through the engine before it can be activated, so a
pack whose arithmetic does not round-trip against its declared expectations never reaches a store.

Check 19 requires a new version to keep the category and rule ids the active version exposed, so
a merchant override can never end up aliasing an id that no longer exists. A local pack is exempt,
because manual configuration remaps its own overrides as it saves.

Check 20 fails when a `tax_overrides` row on the active version points at a category the candidate
version does not define, unless the candidate is local. A local pack remaps stale overrides inside
the activation transaction instead.

Check 25 rejects nested-quantifier regular expressions, so a merchant-facing registration-number
pattern cannot introduce catastrophic backtracking.

Check 7 reads a status stored on the local version row. There is no remote revocation feed: nothing
is fetched that could mark a version revoked.

## Manual tax configuration

Manual entry in settings is not a second calculation path. `buildManualPack()` in
`main/routes/tax-packs.ts` synthesizes a `CountryPack` with `publisher: 'local'`, installs it
through the same path a catalog entry takes, and it is then calculated by the same
`TaxEngine.calculate()`.

The synthesized pack id is `manual-<country>`, its jurisdiction is `*`, it adds a hidden zero-rate
`unclassified` category, and it uses line-scope `half_up` rounding at 2 decimal places with a
`0.01` payable increment. `POST /manual-config` is owner-only and requires a store country to be
configured first.

## Out of scope

The following are not implemented. None of them should be documented as if they were, and a pack
author cannot rely on any of them.

- **Executable pack plugins.** There is no `utilityProcess` plugin layer; `grep -rn utilityProcess
  main/` returns nothing. A pack is data. See
  [0004: data-only tax packs](../decisions/0004-data-only-tax-packs.md).
- **A remote revocation feed.** `LEGACY_TRUSTED_PACK_DIGESTS` is a pinned compatibility list, not a
  revocation mechanism. Check 7 reads a local row status.
- **Root and delegated signing keys.** One Ed25519 public key is trusted, and there is no
  delegation or rotation.
- **`taxPoint` behaviour.** The field is required on `CountryPack` and every shipped pack sets it
  to `finalized_at`, but nothing in the engine reads it. Setting `order_created` has no effect. It
  is a declared field, not a supported value.
- **`storeId` on a pack.** No pack schema field references a store.
- **Customer tax fields.** A customer carries a registration number, state code, and exempt flag
  through `TaxCustomer`, and nothing tax-address-shaped beyond that.
- **Reporting by anything other than tax component.** The report surface is
  `GET /api/reports/tax-components`. There is no reporting by rule, by category, or by jurisdiction.

## Verification

```sh
npm run test:tax-engine
npm run test:tax-components
npm run test:tax-pack-catalog
npm run test:tax-pack-management
npm run test:manual-tax-config
npm run test:legacy-tax-pack-digest
npm run test:community-tax-packs
```
