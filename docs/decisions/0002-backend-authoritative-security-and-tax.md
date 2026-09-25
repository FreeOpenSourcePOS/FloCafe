# 0002: Security, payment, and tax calculations are backend-authoritative

Status: Accepted
Recorded: 2026-09-25

The decision this record describes predates the record. It is written down here because the
code does not explain itself: nothing in the source tells a reader that the alternative was
considered and rejected, or what a re-introduction would cost.

## Context

FloCafe is an Electron application: a React renderer, a Node backend, and a local SQLite database.
A renderer-side implementation of an authorization check or a tax calculation is technically
straightforward and looks reasonable in isolation. It also fails open the moment someone opens the
developer tools, points a modified client at the API, or runs the frontend against a different
backend.

The risk is not that someone would deliberately bypass a renderer check. It is that a
renderer-side check reads as correct in review, so it survives long enough to be depended on.

## Decision

Security-critical, payment, and tax calculations are decided in the backend. The renderer never
decides.

- Authorization is enforced at the route, by role, in the backend. The authorization surface is
  roughly 225 `requireRole(` call sites across `main/routes/*.ts`, plus checks inside transaction
  bodies on the endpoints registered inline on `app`, which no middleware can see. See
  [authentication and authorization](../architecture/authentication-and-authorization.md).
- Tax calculation has exactly one path: `TaxEngine.calculate()` in
  `main/services/tax-engine.ts`. `previewCategoryRate()` in `main/services/tax.ts` is a
  display-only preview for UI category pickers, and the code says so at the definition.
- Amounts that affect money use `decimal.js`, never a JavaScript `number`.

## Consequences

Positive:

- A modified or third-party client gets the same answers as the app.
- The authorization and tax rules are testable without a browser.

Negative:

- Any UI that needs to know "can this user do X" must ask the backend or duplicate the rule for
  display purposes. The in-app capability matrix is a presentation aid, not an enforcement
  mechanism, and is documented as such in
  [roles and permissions](../reference/roles-and-permissions.md).
- The route-level authorization surface is large and expressed inline, which makes auditing it a
  matter of review discipline rather than a single check.

## Alternatives rejected

**Sharing the authorization and tax logic through a common package imported by both the renderer
and the backend.** Rejected: a shared module is still advisory when it runs in the renderer, and it
creates the appearance of a single enforcement point where none exists.

**Declaring the renderer untrusted and validating at the edge only.** Rejected for authorization:
several gates legitimately re-read state inside a transaction, such as the KDS station gate, and an
edge check cannot see that.
