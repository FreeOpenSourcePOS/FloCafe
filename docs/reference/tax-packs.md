# Tax pack reference

Schema, trust model, and install mechanics for country tax packs. How the engine applies a pack is
in [taxation](../architecture/taxation.md); why packs are data rather than plugins is in
[0004: data-only tax packs](../decisions/0004-data-only-tax-packs.md). The authoring procedure is
in [adding a tax pack](../guides/adding-a-tax-pack.md).

The types below are declared in [`main/tax-packs/types.ts`](../../main/tax-packs/types.ts).
`main/tax-packs/generic.json` is the reference instance and the only bundled pack.

## `CountryPack`

A pack is a data object conforming to `schemaVersion: 1`.

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | Only `1` is accepted at activation. |
| `id` | `string` | Catalog ids match `^[a-z0-9][a-z0-9-]*$`. |
| `publisher` | `string` | `local` is reserved; see below. |
| `sourceType` | `'official' \| 'community'` | Optional; defaults to `official`. |
| `version` | `string` | Must match `^\d+\.\d+\.\d+$`. |
| `country` | `string` | Two-letter code, or `*` for a multi-country pack. |
| `jurisdiction` | `string` | Free text, `*` for country-wide. |
| `currency` | `string` | ISO 4217, or `XXX` for a placeholder. |
| `effectiveFrom` | `string` | A parseable date. |
| `effectiveTo` | `string` | Optional; must be at or after `effectiveFrom`. |
| `publishedAt` | `string` | |
| `minFloVersion` | `string` | Minimum FloCafe version that may activate it. |
| `taxPoint` | `'order_created' \| 'finalized_at'` | Declared, but nothing reads it. |
| `inclusivePricingDefault` | `boolean` | |
| `registrationNumberLabel` | `string` | Merchant-facing label. |
| `registrationNumberFormat` | `TaxIdFormat` | Optional pattern plus description. |
| `categories` | `TaxCategory[]` | |
| `defaultCategories` | `Record<TaxLineKind, string>` | A category id for every line kind. |
| `unclassifiedCategoryId` | `string` | Must name a category in `categories`. |
| `rules` | `TaxRule[]` | |
| `taxRounding` | `TaxRounding` | |
| `payableRounding` | `PayableRounding` | |

`TaxCategory` is `{ id, label, ruleIds, defaultBehavior? }`, where `defaultBehavior` is one of
`country_default`, `inclusive`, `exclusive`, or `exempt`.

`TaxLineKind` is `product`, `packaging`, `delivery`, `service_charge`, or `addon`. Every one of
those needs an entry in `defaultCategories`.

`TaxRounding` is `{ scope, method, decimalPlaces, remainderAllocation }`:

- `scope`: `unit`, `line`, or `document`.
- `method`: `half_up`, `half_even`, `floor`, or `ceiling`.
- `decimalPlaces`: an integer from 0 to 6.
- `remainderAllocation`: `largest_remainder`. It is the only accepted value.

`PayableRounding` is `{ increment, method }`, where `increment` is a positive decimal string at most
1000.

## `TaxRule`

`TaxRule` is `{ id, label, type, categoryIds, rate?, amount?, appliesPer?, baseRuleIds?,
conditions? }`.

- `type` is `percent` or `fixed`. A `percent` rule carries `rate`; a `fixed` rule carries `amount`
  and `appliesPer`.
- `appliesPer` is `unit` or `line`. A `fixed` rule must declare it.
- `baseRuleIds` makes a `percent` rule compound, applying to the base rules' result instead of the
  line gross. A `fixed` rule may not declare it.
- `categoryIds` names the categories the rule applies to.

`TaxRuleConditions` is `{ businessTypes?, customerStateRelation?, customerExempt? }`.
`customerStateRelation` is `interstate` or `intra_or_unspecified`.

Amounts are strings, not numbers. A rate or amount that is not finite, or is negative, fails
activation.

## Artifact form

A catalog artifact may be either a bare `CountryPack` or a `CountryTaxPackPluginArtifact`:

```ts
interface CountryTaxPackPluginArtifact {
  schemaVersion: 1;
  artifactType: 'country-tax-pack-plugin';
  id: string;
  displayName: string;
  publisher: string;
  version: string;
  country: string;
  jurisdiction: string;
  publishedAt: string;
  minFloVersion: string;
  taxPack: CountryPack;
  printTemplates?: PluginPrintTemplate[];
}
```

Despite the name, the artifact carries no plugin code. `printTemplates` is a list of declarative
`escpos-line-template-v1` templates rendered by FloCafe code; see
[print templates compliance](print-templates-compliance.md). The templates are data, validated on
install by `validateTemplateChargeRows()` and `validateTemplateLabelsMap()` in
[`main/tax-packs/catalog.ts`](../../main/tax-packs/catalog.ts), and persisted to
`installed_print_templates` keyed by the installed pack version.

The plugin artifact is what is signed and digested, so a pack and its print templates are
distributed and verified as one unit.

## Install path

`installCatalogEntry()` in [`main/routes/tax-packs.ts`](../../main/routes/tax-packs.ts) runs
`downloadAndVerifyTaxPack()` in [`main/tax-packs/catalog.ts`](../../main/tax-packs/catalog.ts)
first. The steps run in this order; each is a hard gate.

1. **Catalog fetch.** `fetchRemoteTaxPackCatalog()` pages the GitHub Releases API for
   `FreeOpenSourcePOS/FloCafe-Plugins`, 100 per page, at most `MAX_RELEASE_PAGES` (10) pages. A
   request that exceeds `MAX_CATALOG_BYTES` (1,000,000) is rejected.
2. **Release filter.** Draft releases are skipped, and a release is considered only when its tag
   matches `^tax-pack-[a-z0-9][a-z0-9-]*-v\d+\.\d+\.\d+$`. A `catalog.json` asset is then located
   on that release.
3. **Download URL guard.** `trustedReleaseDownloadUrl()` accepts a URL only when the protocol is
   `https`, the host is exactly `github.com`, there are no embedded credentials, and the path
   starts with `/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/`.
4. **Size caps.** The pack artifact is capped at `MAX_PACK_BYTES` (2,000,000) and the detached
   signature at `MAX_SIGNATURE_BYTES` (4,096).
5. **Digest.** The SHA-256 of the pack JSON must equal the catalog entry's `digest`.
6. **Signature.** The detached signature must verify as Ed25519 against
   `TRUSTED_TAX_PACK_SIGNING_PUBLIC_KEY`.
7. **Identity cross-check.** If a pack with that id is already installed, its `publisher`,
   `country`, and `jurisdiction` must match the downloaded artifact, or install fails with HTTP
   409. Installing the same id and version twice also fails with HTTP 409.
8. **Local publisher rejection.** A downloaded artifact claiming `publisher: 'local'` is refused.
9. **Staging.** The pack, its rules, and its print templates are written to the version, its rules,
   and `installed_print_templates` tables, with a `status` of `installed` rather than `active`.
10. **Activation.** Activation runs the 26 checks in
    [taxation](../architecture/taxation.md#activation-checks) and then switches the pack's
    `active_version_id`, flipping the version and its template rows to `active`.

A catalog request uses a 15 second timeout and honours an abort signal.

## Trust

`publisher: 'local'` is reserved for packs the app synthesizes, which today means only manual tax
configuration. A local pack must carry no signature. The catalog path refuses a downloaded artifact
that claims to be local, so local status cannot be used to skip signing.

`sourceType: 'community'` marks a pack as built from public information rather than an official
source. It requires merchant acknowledgement of a disclaimer, and a local or manual pack may never
declare it.

There is one trusted signing public key, in
[`main/tax-packs/trusted-signing-key.ts`](../../main/tax-packs/trusted-signing-key.ts).

`LEGACY_TRUSTED_PACK_DIGESTS` in `main/routes/tax-packs.ts` pins four SHA-256 digests of
pre-signing artifacts, for `official-india`, `official-thailand`, `official-in`, and
`official-th`. An unsigned artifact matching one of them is accepted. This is a compatibility
exception pinned by `tests/legacy-tax-pack-digest.test.ts`, not a way to publish a new unsigned
pack.

## Manual tax configuration

`buildManualPack()` in `main/routes/tax-packs.ts` turns settings-entered tax configuration into a
`CountryPack` with `publisher: 'local'`, id `manual-<country>`, and jurisdiction `*`. It installs
through the same path and is calculated by the same `TaxEngine.calculate()`, so there is no second
calculation path. `POST /manual-config` is owner-only.

## Verification

```sh
npm run test:tax-pack-catalog
npm run test:tax-pack-management
npm run test:manual-tax-config
npm run test:legacy-tax-pack-digest
npm run test:community-tax-packs
```
