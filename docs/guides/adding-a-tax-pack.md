# Adding a tax pack

How to produce a country tax pack and get it published. The pack schema, the trust model, and the
install path are in the [tax pack reference](../reference/tax-packs.md); how the engine applies a
pack is in [taxation](../architecture/taxation.md). This page is the procedure only and carries no
field tables.

Adding a pack needs maintainer coordination. Open a proposal issue before authoring one, and
describe the jurisdiction, the authoritative sources, and the executable calculation fixtures you
intend to provide.

## 1. Establish the authoritative source

Tax rules must be backed by an official tax authority, enacted legislation, or official
administrative guidance. A blog post, a summary, or a generated answer is not a primary source.

Record the specific instrument, not the topic: the statute section, the rate schedule, the effective
date. A pack that cites "VAT in Europe" is unusable; a pack that cites the exact schedule with its
publication reference is auditable.

FloCafe is software, not certified legal or tax advice. The disclaimer in the contribution terms is
part of the deliverable, not a formality.

## 2. Scope the jurisdiction

State the geographic and legal scope explicitly in the pack, not in prose around it:

- Country-wide or a subset of states or provinces.
- Whether a rule distinguishes interstate from intrastate supply.
- The effective date, and whether a previous rate is retained under `effectiveTo`.
- The currency, and whether it differs from the pack's country.

Set `jurisdiction` precisely. A pack that claims a scope it does not implement will misprice
stores that install it, which is worse than the pack not existing.

## 3. Write the pack as data

Author a `CountryPack` JSON document. Verify every field against
`main/tax-packs/types.ts` and the field list in the
[tax pack reference](../reference/tax-packs.md). A pack that will not satisfy the types will not
pass activation.

Three things to get right the first time, because each one is enforced:

- **Amounts are strings.** A rate or amount written as a JSON number risks floating-point drift on
  the way in. Write `"rate": "20"`.
- **Every line kind needs a default category.** `defaultCategories` must resolve for `product`,
  `packaging`, `delivery`, `service_charge`, and `addon`, and `unclassifiedCategoryId` must name a
  category that exists.
- **Every category and rule needs a label.** Check 21 rejects a pack whose labels are empty, and
  those labels are what a merchant sees in the UI.

Declare rounding deliberately. `taxRounding` and `payableRounding` are separate policies, and the
payable increment is what a customer is actually charged, so copy the jurisdiction's cash rules
rather than assuming they match the tax rounding.

## 4. Set publisher and sourceType

- `publisher` identifies the author. **Never set `publisher: 'local'`.** That value is reserved for
  packs the app synthesizes from settings, and a downloaded artifact claiming it is refused at
  install.
- `sourceType` is `official` when the pack follows an official source and `community` when it is
  built from public information. A `community` pack requires the merchant to acknowledge a
  disclaimer, and check 26 refuses a local pack that claims it.

Never set `taxPoint` to `order_created` expecting a behaviour change. The field is required on the
schema, but nothing reads it; every shipped pack declares `finalized_at` and that is the only value
with any observable meaning.

## 5. Add executable calculation fixtures

`CountryPack` has no `testVectors` field. Keep fixtures in the repository's existing tests and run
them through `TaxEngine.calculate()`; activation check 23 only checks that declared data produces a
self-consistent calculation.

Cover the jurisdiction's supported behavior: standard rates, inclusive and exclusive prices,
categories and charges, discounts, multiple lines, rounding boundaries, and any supported
conditions or exemptions. Verify registration-number formats against primary-source examples, and
make clear when a format check validates syntax rather than legal registration status. Do not add a
pack rule for a legal condition the engine cannot represent.

## 6. Verify locally

Confirm the pack satisfies the schema and the engine before proposing publication:

```sh
npm run test:tax-pack-management
npm run test:tax-pack-catalog
npm run test:tax-engine
npm run test:tax-components
```

For a community pack, also run `npm run test:community-tax-packs`. The activation checklist checks
that the pack is data-only (check 22) and that its registration-number pattern is valid and does not
contain nested quantifiers (check 25).

## 7. Publish

Packs are published as GitHub releases in the separate
`FreeOpenSourcePOS/FloCafe-Plugins` repository, not in this one. Commit the pack JSON to
`main/tax-packs/` here so the source is versioned with the engine that consumes it.

Then create a release whose tag matches:

```text
tax-pack-<pack-id>-v<X.Y.Z>
```

The `<pack-id>` segment matches `^[a-z0-9][a-z0-9-]*$` and `<X.Y.Z>` matches `^\d+\.\d+\.\d+$`. The
format is enforced, not advisory: `scripts/tax-packs/prepare-release.cjs` matches the tag against
`TAG_PATTERN` and throws if it does not conform.

The release process runs in the FloCafe-Plugins repository through
[`.github/workflows/tax-pack-release.yml`](https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/blob/main/.github/workflows/tax-pack-release.yml):

1. The workflow tests `scripts/tax-packs/prepare-release.cjs` before it accesses the signing secret.
2. The script resolves the tag to a pack id and version, checks that the tag version matches the
   artifact, and refuses a pack whose `publisher` is `local`.
3. The workflow loads the Ed25519 private key from the `TAX_PACK_SIGNING_KEY` secret. It computes a
   SHA-256 digest and detached signature over the exact artifact bytes and writes a cumulative
   `catalog.json`.
4. The workflow stages the pack JSON, signature, and catalog as exactly three assets on a draft
   release. A tag and its workflow do not publish the draft.
5. Review all three draft assets against the source before a maintainer publishes it. Before any
   publication, refresh the latest public catalog and serialize releases with different tags:
   workflow concurrency only serializes identical tags. An unrelated official pack preserves
   community entries; an official pack replaces only community entries for the same country.

FloCafe discovers the release by matching that same tag pattern when it pages the Releases API, so a
published release whose tag does not match is invisible to every store. Old released artifacts are
immutable; publish a new version instead of changing a tagged asset.

## What not to do

- **Do not ship executable content.** The host never executes pack content. A pack is JSON, and
  check 22 rejects an artifact carrying anything executable or a path value. A pack that needs real
  computation requires an engine change, not a cleverer pack. See
  [0004: data-only tax packs](../decisions/0004-data-only-tax-packs.md).
- **Do not add a key.** One Ed25519 public key is trusted. A second key needs an engine change.
- **Do not add a digest to `LEGACY_TRUSTED_PACK_DIGESTS`.** It is a pinned compatibility list for
  four pre-signing artifacts, not a publishing route.
- **Do not rename a category or rule id** without accepting that check 19 blocks the version, and
  that merchant overrides would have to be remapped.
- **Do not document a behaviour the engine does not have.** A pack cannot make the engine read
  `taxPoint`, target a store, or report by rule.
