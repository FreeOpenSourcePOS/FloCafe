# 0005: Permissions are owner-configurable; sensitive context policy is not

Status: Accepted
Recorded: 2026-09-26

## Context

FloCafe shipped with five fixed staff identities (owner, manager, cashier, server, chef) and
roughly 240 `requireRole(...ROLE_ACCESS.x)` gates scattered across the main API, KDS, and Server
App. Stores kept asking to delegate a specific capability — a trusted cashier running reports, a
server who should not touch refunds — without FloCafe inventing a sixth or seventh role identity
for every such request, which does not scale and still would not match any one store's actual
staffing.

Two designs were available: keep authorization role-based and add more roles, or replace the fixed
identities with a fully free-form permission system with no built-in roles at all.

## Decision

Roles stay fixed as the five staff identities. What changed is that most `requireRole` gates became
`requirePermission`/`requireAnyPermission` gates resolved live from SQLite
(`main/services/authorization.ts`), each with a **shipped default** role mapping
(`shared/permissions.ts`) an owner can override per role or per user
(`role_permission_overrides`, `user_permission_overrides`, schema migration v93). See
[Configurable permissions](../architecture/authentication-and-authorization.md#configurable-permissions)
for the resolution order and [roles and permissions](../reference/roles-and-permissions.md) for the
full matrix.

Two permissions are excluded from this and stay hard-coded to owner: `authorization.manage` (who
can reach the permission editor) and `staff.privileged.manage` (who can modify an owner or manager
account). Without that floor, an owner could misconfigure or be tricked into removing their own
access, with no path back in short of restoring a backup.

A second category of check was deliberately **not** migrated to a configurable permission at all:
checks that read business context rather than "can this role use this feature" — the refund
approver's identity, the override-PIN holder for an in-progress item cancel/void, the
last-active-owner guard, and KDS station/category narrowing. These stay direct `hasRole(...)` /
data checks at their call sites, because they encode a fact about the transaction (who is
approving, what this chef is assigned to), not a feature gate an owner would reasonably want to
reconfigure. Turning them into permissions would let an owner configure away an approval boundary
that exists specifically to not be self-service.

The migration guarantee that made this safe to ship: every permission's shipped default reproduces
the exact role set the corresponding `requireRole` call allowed before this change. Immediately
after upgrade, before an owner touches the permission editor, every role can do exactly what it
could do the day before. `npm run test:authorization-permissions` asserts the defaults; a static
audit test rejects any new `requireRole(...)` gate under `main/routes/` so the surface cannot
silently regress back to fixed roles.

## Consequences

Positive:

- Stores delegate real capabilities without a role-identity explosion, and without asking us to
  ship a release for every new staffing pattern.
- The upgrade path has one invariant to hold, not one per store: defaults match old behavior
  exactly, so upgrading changes nothing until an owner opens the permission editor.
- The two protected permissions and the un-migrated context checks keep a recoverable owner path
  and the approval boundaries intact regardless of what an owner configures.

Negative:

- Two authorization mechanisms now coexist: configurable `requirePermission` gates and fixed
  `hasRole`/context checks. A reviewer adding a new gate has to know which category it belongs to.
- The effective permission for a role is no longer visible by reading `ROLE_ACCESS` alone; it
  requires checking for an override, which is why the audit log and the editor's "why" exist.

## Alternatives rejected

**More fixed role identities instead of configurable permissions.** Rejected: it does not converge
— every store's actual delegation need is a different subset, and role identities are a release-
time decision, not a per-store one.

**A fully free-form permission system with no built-in roles.** Rejected: it removes the shipped
defaults that make the upgrade-safety guarantee possible, and it would require every store to
configure authorization from zero instead of starting from a working default.

**Making the context-policy checks configurable permissions too.** Rejected: those checks exist
specifically so an owner cannot configure away an approval boundary (who approved a refund, who
held the void PIN); making them permissions would undermine the reason they exist.
