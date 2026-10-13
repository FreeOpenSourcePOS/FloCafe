# Recording showcase media

This guide describes how to capture automated browser flows and transcode
production-ready media assets (GIFs, MP4 videos, and poster frames) used in
FloCafe documentation and website showcases.

## Overview

The showcase capture harness runs locally and offline without external
services or cloud accounts once the local prerequisites below are installed.
It seeds a complete demo café ("Harbor & Bean Café") in an isolated temporary
database, launches all three background servers, drives Playwright with smooth
cursor animations, and encodes compact media through `ffmpeg`.

Captured feature scenes:

1. `pos-checkout` - High-speed counter POS checkout and cash settlement.
2. `addon-modifiers` - Modal add-on selection with milk choices and syrup shots.
3. `kds-kanban` - Standalone KDS Kanban board and stage transitions.
4. `floorplan-tables` - Interactive dining room floor plan and table turnover.
5. `server-app` - Mobile waiter app ordering table-side on LAN port `3003`.
6. `split-payments` - Multi-tender checkout and equal-share calculation.
7. `recipe-inventory` - Supply management, recipe portions, and stock movement.
8. `thermal-printing` - 58mm/80mm receipt, tax bill, and KOT ticket previews.

## Prerequisites

Before running the showcase pipeline, ensure:

- **Node.js:** version 22.12.0 or higher.
- **FFmpeg:** installed and available on `PATH` (or at `/opt/homebrew/bin/ffmpeg`).
- **Compiled application:** backend and static frontend must be compiled:

```sh
npm run build:frontend
npm run build
```

- **Playwright Chromium:** browser binary installed:

```sh
npx playwright install chromium
```

## Running the capture pipeline

To record and transcode all showcase scenes in one pass:

```sh
node scripts/demo/record-showcase.cjs
```

To record or update a single scene, pass the `--scene` flag:

```sh
node scripts/demo/record-showcase.cjs --scene=pos-checkout
node scripts/demo/record-showcase.cjs --scene=kds-kanban
```

The script automatically:

1. Starts the sandbox services on ports `3001`, `3002`, and `3003` (run `npm run clean` first if those ports are in use).
2. Initializes an isolated temporary SQLite database in `/tmp/flo-showcase-env/`.
3. Seeds the "Harbor & Bean Café" catalog, tax rules, tables, and staff PINs.
4. Boots the Express API, KDS server, and Server App.
5. Launches headless Chromium, navigates each flow, and injects a smooth cursor.
6. Encodes optimized GIFs, H.264 MP4s, and JPEG posters into `docs/assets/showcase/`
   (and copies them to the website showcase directory when `WEBSITE_SHOWCASE_DIR` is set or a sibling `flopos.com-showcase` checkout exists).
7. Shuts down background servers and cleans up browser contexts.

## Media encoding constraints

Generated media assets follow repository size and display guidelines:

- **Resolution:** 800x450 (desktop 16:9 scenes) or 580px height (mobile waiter app).
- **GIF file size:** target under 1.5 MB per scene (typical range: 600 KB - 1.3 MB, verified by `npm run showcase:verify`).
- **Framerate:** 8 frames per second for GIFs to balance smoothness with file size.
- **Palette generation:** 2-pass `palettegen` with `max_colors=48`, `stats_mode=diff`,
  and Bayer dithering with bounding-box rectangle delta encoding.
- **Web video:** H.264 (`libx264`, `yuv420p`, CRF 23, `+faststart`, audio disabled).
- **Poster images:** JPEG captured from a representative still frame.
