# Plan: Issue #356 — Floorplan editor for tables (v1)

## Research summary (how other POS systems draw table maps)

| POS | Pattern observed |
| --- | --- |
| **Square for Restaurants** | Floor plans live in Settings → Floor plans; sections group tables; click a table to move/resize; explicit **Save** at the end; live status (occupied as soon as seated). |
| **Odoo PoS** | Floor plan editor with drag of table boxes onto a canvas; floors as tabs; save persists x/y. |
| **Lavu / Lightspeed L-Series** | Tables layout view; tables placed by dragging; unplaced tables held in a staging area until positioned. |

Common denominators → **best-practice UX**: floor tabs, drag & drop on a canvas, staging tray for unpositioned tables, explicit Save (no writes while dragging), live status coloring, legend.

## Decisions

- **Entry point:** "Edit Floorplan" button on the existing `/tables` page header (FloCafe's table management surface — the issue's "Settings → Tables" maps here; `/tables` is already owner/manager-only).
- **Drag engine:** native Pointer Events (mouse + touch unified → works on touchscreen POS, issue #368). dnd-kit is installed but is list/sortable semantics — wrong tool for free 2D positioning; using it would be more code.
- **Coordinates:** store percentages 0–100 in existing `position_x`/`position_y` REAL columns → resolution-independent, responsive, no migration.
- **Save model:** local state during drag; explicit **Save** (batch `PUT /tables/:id { position_x, position_y }` for changed tables only) + **Discard**. Matches Square; avoids hammering API per pointermove; existing CRUD/status untouched (acceptance criterion 3).
- **Floors:** tabs from distinct `floor` values + "Unassigned" bucket for `floor IS NULL`; switching is client-side filtering.
- **Status colors:** reuse the `/tables` page palette (available=green, occupied=red, reserved=yellow, cleaning=gray, held=blue) and `TABLE_STATUS_LABEL_KEYS` i18n keys.
- **i18n:** new keys in `tables` namespace across en/es/fa/fr/pt; `npm run i18n:check` must pass.
- **RTL:** positions are physical `left/top` % on a positioned canvas — direction-agnostic by design.

## Tasks

1. `frontend/src/lib/types.ts`: add `position_x`/`position_y` to `Table`.
2. New `frontend/src/components/tables/FloorplanEditor.tsx`: canvas + floor tabs + tray + pointer drag + Save/Discard + legend.
3. Wire into `frontend/src/app/(dashboard)/tables/page.tsx` (header button + view toggle; editor inherits the page's 10s status polling).
4. i18n keys ×5 languages.
5. Backend integration test: PUT `position_x`/`position_y` persists and GET returns them (acceptance criterion 1).
6. Playwright e2e: login → tables → Edit Floorplan → drag table → Save → reload → position persisted; floor switching works; visual snapshot check.
7. Verify: `npm run lint`, `npm run build:frontend`, `npm run i18n:check`, focused backend test, e2e spec, browser visual pass (screenshots, layout-integrity). No PR.

## Out of scope (v1, per issue)

Walls, polygons, rotation, chairs, floor assignment via drag, table merging, resizing.

## UX improvement round 2 (visual inspection findings)

Visual analysis with 9 tables / long names / 3 floors surfaced:

1. Tray→canvas drops land offset from the pointer (grab offset from tray-chip edges).
   → Tray drops center the chip under the pointer; canvas re-drag keeps grab offset.
2. Post-save snap-back: `setEdits({})` clears overrides before the refetch lands.
   → Converge-prune: drop edit entries when the tables prop reflects them (also
   self-heals stale edits for deleted tables; unsaved edits survive polls).
3. Save batch could 404 on a table deleted mid-edit → filter edits to existing ids.
4. Long names wrap and break the fixed-width chip → truncate + title tooltip.
5. No keyboard path → chips focusable; arrows nudge ±1% (Shift ±5%); Enter/Space
   on a tray chip places it at canvas center; aria hint + aria-keyshortcuts.
6. Empty canvas says "No tables yet" while tables sit in the tray → new
   `floorplanEmptyCanvas` copy ("Drag tables from the tray onto the map").
7. Save unreachable from the tray at page bottom → sticky tabs/actions row.
8. "Show Order Details" checkbox is noise while editing → hidden in editor view.
9. Hover affordance on chips (shadow) to signal draggability.

## UX rounds 4-5: seats, floors, all-floors overview

Owner feedback drove two more rounds:

- Seat counts displayed as localized text ("4 seats"), not a bare number that
  reads like a multiplier. Chip width scales with capacity (x2 → x12 read at a
  glance).
- Click/tap a chip (drag threshold 5px) opens an Edit Table modal — name,
  capacity, floor, section. This is the first table-edit surface in the app;
  previously names/capacities were only settable at creation.
- Quick-add on the map: "+ Add Table" in the editor prefills the next free
  number and the active floor.
- "+ Add Floor": names a floor and creates its first table in one step
  (floors derive from tables; a floor must be born with a table to persist).
- "All floors" overview tab: every floor rendered as a labeled read-only
  mini-map side by side, with unplaced counts and Edit links. Editing stays
  per-floor because each floor owns the same 0-100 coordinate space.
- Floors sort by table count (busiest first), then alphabetically.

## UX round 6: visual overhaul — "tables that look like tables"

The card-grid look read as a prototype. Adopting the standard restaurant
floor-plan visual language (Lightspeed K-Series / Square / dineopen):

- Table objects shaped by capacity: circle ≤2 seats, square 3-4, rectangle
  5-6, wide rectangle 7-8, banquet 9+. Seats render as chair dots around the
  object (around circles, split across long edges of rects) — capacity is
  seen, not read.
- White table surfaces, 3px status-colored ring, status as small caps under
  the name, soft drop shadows; dragging lifts the object (scale + deep
  shadow). Warm paper-toned canvas with a dot grid instead of line grid.
- Segmented floor switcher (iOS-style) with All floors; tray styled as a
  staging shelf with mini table objects; all-floors overview renders the
  same objects at 0.55 scale.
- e2e: seat assertion moves from text ("6 seats") to chair count (6 chair
  dots) — capacity is seen, not read.
