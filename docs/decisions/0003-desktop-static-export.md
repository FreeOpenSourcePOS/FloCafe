# 0003: The desktop build is a static export served by Express

Status: Accepted
Recorded: 2026-09-25

The decision this record describes predates the record. It is written down here because the
code does not explain itself: nothing in the source tells a reader that the alternative was
considered and rejected, or what a re-introduction would cost.

## Context

`frontend/` is a Next.js application. The obvious assumption is that a Next.js application has a
server runtime, route handlers, server components fetching data, and server actions. FloCafe's
desktop build has none of them.

When `NEXT_BUILD_MODE=desktop`, `frontend/next.config.ts` sets `output: 'export'`. The build
emits static HTML, CSS, and JavaScript, and the Electron main process serves them over HTTP from
the Express API on port 3001. Every window loads over `http://localhost:<port>`, never `file://`.

## Decision

In the desktop build there is no Next.js server runtime. Therefore:

- No route handlers (`frontend/src/app/api/` does not exist, and no `route.ts` or `middleware.ts`
  exists anywhere in `frontend/src`).
- No server actions (no `'use server'` directive).
- No server-only data access (no `next/headers`), and therefore no server cookies.
- All dynamic behaviour belongs in Express on port 3001 or in Electron IPC.

The renderer is a client application talking to a backend over HTTP, plus a narrow native surface
exposed through the preload bridge.

`trailingSlash` is set for the desktop build so static paths are predictable, and `next/image`
optimisation is disabled because it requires a running server.

## Consequences

Positive:

- The data plane is a plain HTTP API that is testable, inspectable, and reachable by a second
  client such as the Server App on port 3003.
- The packaged frontend has no server runtime to keep alive or secure.

Negative:

- Any developer who reaches for a Next.js server feature gets a build-time or silent runtime
  failure instead of a compile error, because the feature is absent rather than disabled.
- A static export cannot vary output per request, so anything request-dependent must come from the
  API.

## Alternatives rejected

**Serving the frontend from `file://`.** Rejected: it forces CORS handling and breaks relative
asset and routing behaviour.

**Keeping a Next.js server runtime in the packaged app.** Rejected: it adds a second server process
and a second lifecycle to manage for no capability the POS needs.

**Route handlers as a thin proxy onto Express.** Rejected: it adds a hop and a second place where
the API surface is defined, with no behaviour the backend cannot provide directly.
