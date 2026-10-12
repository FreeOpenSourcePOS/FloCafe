# Recording showcase media

This guide describes how to capture automated browser flows and transcode
production-ready media assets (GIFs, MP4 videos, and poster frames) used in
FloCafe documentation and website showcases.

## Overview

The showcase capture harness runs fully locally and offline without external
dependencies or cloud accounts. It seeds a complete demo café ("Harbor & Bean
Café") in an isolated temporary database, launches all three background
servers, drives Playwright with smooth cursor animations, and encodes
compact media through `ffmpeg`.

Captured feature scenes:

1. `pos-checkout` — High-speed counter POS checkout and cash settlement.
2. `addon-modifiers` — Modal add-on selection with milk choices and syrup shots.
3. `kds-kanban` — Standalone KDS Kanban board and stage transitions.
4. `floorplan-tables` — Interactive dining room floor plan and table turnover.
5. `server-app` — Mobile waiter app ordering table-side on LAN port `3003`.
6. `split-payments` — Multi-tender checkout and equal-share calculation.
7. `recipe-inventory` — Supply management, recipe portions, and stock movement.
8. `thermal-printing` — 58mm/80mm receipt, tax bill, and KOT ticket previews.

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

1. Frees ports `3001`, `3002`, and `3003`.
2. Initializes an isolated temporary SQLite database in `/tmp/flo-showcase-env/`.
3. Seeds the "Harbor & Bean Café" catalog, tax rules, tables, and staff PINs.
4. Boots the Express API, KDS server, and Server App.
5. Launches headless Chromium, navigates each flow, and injects a smooth cursor.
6. Encodes optimized GIFs, H.264 MP4s, and JPEG posters into `docs/assets/showcase/`
   and `flopos.com` website directories.
7. Shuts down background servers and cleans up browser contexts.

## Media encoding constraints

Generated media assets follow strict repository size and display guidelines:

- **Resolution:** 960x540 (desktop 16:9 scenes) or 640px height (mobile waiter app).
- **GIF file size:** strictly under 1.5 MB per scene (target: 600 KB–1.3 MB).
- **Framerate:** 9 frames per second for GIFs to balance smoothness with file size.
- **Palette generation:** 2-pass `palettegen` with `max_colors=64`, `stats_mode=diff`,
  and Bayer dithering with bounding-box rectangle delta encoding.
- **Web video:** H.264 baseline (`yuv420p`, CRF 23, `+faststart`, audio disabled).
- **Poster images:** JPEG captured from a representative still frame.
