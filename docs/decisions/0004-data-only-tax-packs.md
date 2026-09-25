# 0004: Country tax packs are data, not executable plugins

Status: Accepted
Date: 2026-09-25

## Context

Tax rules differ per jurisdiction and change more often than the POS does. The naive design is a
plugin system: a country pack contains code, the host runs it in a sandboxed process, and the
pack can implement whatever behaviour its jurisdiction requires.

That design makes tax compliance a remote-code-execution problem on every merchant's till. It also
multiplies the review burden: a pack that computes tax wrongly is indistinguishable from a pack
that steals data, and the signing story has to be airtight for arbitrary code rather than for
declarative rules.

FloCafe instead has one calculation engine and data-only packs.

## Decision

A country tax pack is declarative data conforming to the `CountryPack` interface in
`main/tax-packs/types.ts`: categories, rules expressed as `percent` or `fixed`, and descriptive
metadata. It contains no executable code, and the host never executes pack content.

All tax calculation runs in one place, `TaxEngine.calculate()` in
`main/services/tax-engine.ts`, using `decimal.js`. There is no `utilityProcess` plugin layer in the
codebase.

A pack installed from the catalog is additionally checked before activation: size caps, an HTTPS
and `github.com` releases-download URL guard, a SHA-256 digest, an Ed25519 signature, an identity
cross-check, rejection of a pack that claims `publisher: 'local'`, staging, and only then
activation. The activation path runs a fixed list of validation checks. Manual tax configuration
entered in settings is turned into a synthetic `publisher: 'local'` pack and run through the same
engine, so there is no second calculation path.

A signed pack may carry a declarative print-template artifact, and that artifact is validated and
rendered by FloCafe code. It is data, and it is not executed.

## Consequences

Positive:

- Installing a tax pack cannot execute code on a merchant's machine.
- Tax behaviour is one auditable code path, testable without any pack installed.
- A pack is reviewable as data: categories, rates, and jurisdiction.

Negative:

- A jurisdiction whose rules need real computation cannot be expressed. Expressing it requires a
  change to the engine, not a new pack.
- Extending the engine for a new jurisdiction's requirements changes behaviour for every store that
  has any pack installed, so engine changes need a migration and release, not a catalog update.

## Alternatives rejected

**Sandboxed executable plugins via `utilityProcess`.** Rejected: it turns a tax catalog into a code
distribution channel, and every pack then needs a capability model, a sandbox, and a signing
review.

**Multiple calculation engines, one per pack type.** Rejected: it makes tax behaviour depend on
which pack is installed, so the same transaction can compute differently on two stores.

<!-- docs:policy-allow: past-tense-without-verification -->
