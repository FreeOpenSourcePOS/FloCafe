# System overview

FloCafe is an offline-first Electron desktop point-of-sale application. One Electron main process
hosts a SQLite database, three HTTP servers, and a set of native window surfaces. There is no
separate backend host: the API server, the kitchen display server, and the server app server all
run inside the same process as the UI.

This page is the map. Each server and lifecycle rule has its own page; see the links at the end.

## Processes and ports

| Surface | Default port | Module | Purpose |
| --- | --- | --- | --- |
| Main API and POS UI | `3001` | [`main/server.ts`](../../main/server.ts) | REST API under `/api`, the static-export frontend, and the KDS WebSocket upgrade. |
| Kitchen Display | `3002` | [`main/kds-server.ts`](../../main/kds-server.ts) | Standalone KDS page and KDS REST endpoints, for a second screen or a tablet. |
| Server App | `3003` | [`main/server-app.ts`](../../main/server-app.ts) | A narrow ordering surface for server staff, backed by a filtered proxy to `:3001`. |

Each surface can also be reached over HTTPS from LAN devices; see [Secure Network](#secure-network-https-for-lan-devices).

The KDS WebSocket is served at path `/kds` on **both** `:3001` and `:3002`. Both servers call the
same handler, `setupKdsWebSocket` in [`main/services/kds.ts`](../../main/services/kds.ts), so a
KDS client behaves identically whichever port it connects to.

The standalone KDS and Server App pages each link their own web app manifest
(`frontend/public/kds-manifest.json` and `frontend/public/server-manifest.json`), so an installed
app opens `/kds-standalone` or `/server-standalone` and not the POS dashboard.

```mermaid
flowchart TB
  subgraph main["Electron main process"]
    DB[(SQLite<br/>flo.db)]
    API["Express API :3001<br/>/api + static export"]
    KDS["KDS server :3002<br/>/api/kds + /kds-standalone"]
    APP["Server App :3003<br/>/api (proxy)"]
    WS["KDS WebSocket /kds<br/>shared handler"]
    IPC["Electron IPC<br/>narrow native surface"]
  end

  API --> DB
  KDS --> DB
  APP -->|"fetch to 127.0.0.1:3001/api"| API
  API -.->|"upgrade /kds"| WS
  KDS -.->|"upgrade /kds"| WS
  WS --> DB

  subgraph windows["Windows (all load over HTTP)"]
    POS["POS window<br/>localhost:3001"]
    KDSW["KDS window<br/>LAN IP:3002"]
    SAPPW["Server App window<br/>localhost:3003"]
  end

  POS -->|"http://"| API
  KDSW -->|"http://"| KDS
  SAPPW -->|"http://"| APP
  POS <-->|"contextBridge"| IPC
```

## Every window loads over HTTP

The windows stay on HTTP even when Secure Network is on: `localhost` is already a secure context,
and the desktop app must not depend on a certificate authority. No window loads a `file://` URL. The POS window loads
`http://localhost:<main port>` so that the browser sees a single HTTP origin, which avoids
`file://` CORS and routing problems and keeps development and packaged behaviour identical. The
KDS window loads `http://<LAN IP>:<kds port>/kds`. The server app window loads its own origin on
`:3003`.

The main server also serves the static frontend export when it can find it, looking for
`frontend/out/` relative to the compiled output and `resources/frontend-out` in a packaged build.
When the export is missing it serves a placeholder page telling the developer to run
`npm run build:frontend` rather than failing.

## The port retry ladder

Each server resolves its own port at bind time rather than assuming the default. On `EADDRINUSE`
or `EACCES` it increments the port and retries, up to ten attempts measured from the base port,
before rejecting. Because the active port can differ from the default, nothing may hard-code
`3001`, `3002`, or `3003`.

Read the live port from the accessor, never from a literal:

| Constant | Read with |
| --- | --- |
| Main API | `getServerPort()` from [`main/server-state.ts`](../../main/server-state.ts) |
| KDS | `getKdsPort()` |
| Server App | `getServerAppPort()` from [`main/server-app-state.ts`](../../main/server-app-state.ts) |
| HTTPS fronts | `getHttpsPort()`, `getKdsHttpsPort()`, `getServerAppHttpsPort()` from `main/server-state.ts`; each is `null` while Secure Network is off or not bound |

Defaults come from the `PORT`, `KDS_PORT`, and `SERVER_APP_PORT` environment variables.

## LAN discovery

On startup the app publishes an mDNS service named `Flo` of type `http` on host `flo`, so the POS
resolves at `flo.local:<main port>` on the LAN. The TXT record carries the app version and the
paths and ports of the KDS and server app surfaces, and the startup log prints the LAN IP as a
fallback for networks where mDNS resolution fails. When Secure Network is serving, the record also
carries `https_port`, `https_kds_port`, `https_server_app_port`, and `ca_sha256` (the CA fingerprint
without separators).

mDNS advertisement is skipped when `FLO_E2E_SKIP_OPTIONAL_NETWORK` is `1`, which is how the
end-to-end suites keep an offline fixture uncontended.

## Secure Network (HTTPS for LAN devices)

Browsers expose WebUSB only on secure origins, so a terminal that opens `http://<host-ip>:3001`
cannot use a USB receipt printer. Secure Network gives every LAN surface an HTTPS address without
any proxy or helper process.

- **In-process TLS.** [`main/security/lan-tls/https-front.ts`](../../main/security/lan-tls/https-front.ts)
  creates one `https.Server` per surface and dispatches each decrypted request and `upgrade` to the
  existing HTTP server's handlers. `req.socket.remoteAddress` is therefore the real LAN client, so the
  loopback-only setup guard, the maintenance admission ticket header, and every per-IP rate limit behave
  exactly as on HTTP. The `/kds` WebSocket works as `wss` on the main and KDS fronts.
- **Two-tier certificates.** A long-lived local root CA is created once per installation
  ([`ca-store.ts`](../../main/security/lan-tls/ca-store.ts)); its key is encrypted with Electron
  `safeStorage` under `userData/secure-network/` and never leaves that folder. A short-lived server
  certificate ([`x509.ts`](../../main/security/lan-tls/x509.ts)) covers `flo.local`, `localhost`,
  `127.0.0.1`, and the ranked private LAN addresses. It is reissued in memory when the address set
  changes or when renewal is due, without any device trusting again.
- **Ports.** The main surface prefers `443`, then walks `3441` upward; KDS uses `3451` and the Server
  App `3461` upward. The ranges are fixed, independent of the HTTP ports, so they always sit inside the
  Windows firewall rule's `443,3441-3470`. A busy port falls through the ladder and an HTTPS failure
  never affects the HTTP listeners.
- **Host validation.** The fronts answer `421` unless the `Host` is `localhost`, `flo.local`, `[::1]`,
  or a private IPv4 literal.
- **Trust is never silent.** Each device must approve the CA once. The public certificate is served at
  `/api/secure-network/ca.cer` and walked through at `/trust`; the CA fingerprint is shown on the host
  for comparison with what the device shows, because the first download travels over HTTP and anything
  the guide page displays could be altered with it.

The service is [`main/security/lan-tls/secure-network.ts`](../../main/security/lan-tls/secure-network.ts);
[`main/services/secure-network-wiring.ts`](../../main/services/secure-network-wiring.ts) binds it to the
real servers. It is skipped under `node dev-server.js` and when `FLO_E2E_SKIP_OPTIONAL_NETWORK` is `1`.

## The server app is a filtered proxy, not a second API

`main/server-app.ts` does not implement business logic. It authenticates the caller, checks the
role against the server-app role set, and then forwards a fixed list of paths to
`http://127.0.0.1:<main port>/api/...` with a real `fetch`, relaying method, query string,
`Authorization` header, `Idempotency-Key`, and JSON body, and copying the upstream status and body
back.

Three consequences matter when you work on it:

- **Adding an endpoint to `:3001` does not expose it on `:3003`.** A path becomes reachable from
  the server app only when an explicit forwarding route is added to `main/server-app.ts`.
- **An unreachable main API surfaces as `502`** from the forwarding layer, and an aborted request
  as `503`.
- **Forwarded requests hand off database maintenance admission.** Requests admitted on `:3003`
  pass a single-use admission ticket (`x-flo-maintenance-handoff`) over loopback to `:3001`. The main
  API accepts the ticket so requests in flight when a database maintenance lock activates drain
  cleanly instead of failing with `503` or double-counting in-flight database requests.

When the server app feature is disabled, the authenticated middleware answers `404` rather than
revealing that the surface exists.

## Capability-based title bar detection

Whether the main window uses native caption controls or HTML fallback buttons is decided by probing
the platform and the runtime, never by inspecting a user-agent string. `resolveTitleBarMode` in
[`main/window-options.ts`](../../main/window-options.ts) returns `native-overlay` for macOS, and for
Windows and Linux only when the Electron major version is at least 33 **and**
`BrowserWindow.prototype.setTitleBarOverlay` is actually a function; otherwise it returns
`html-fallback`. The resolved mode is reported to the renderer through the `get-status` IPC handler.

See [Desktop build and window surfaces](desktop-build.md) for the rest of the title-bar contract.

## Where to go next

| Subject | Page |
| --- | --- |
| Startup order, shutdown order, runtime recovery, and the dev-server divergence | [Runtime and lifecycle](runtime-and-lifecycle.md) |
| Static export boundary, IPC surface, title bar | [Desktop build](desktop-build.md) |
| Database file, migrations, backup and restore | [Data and migrations](data-and-migrations.md) |
| Stored timestamps and business-day boundaries | [Business time](business-time.md) |
| Auth, roles, and the boundaries the app does not harden | [Authentication and authorization](authentication-and-authorization.md) |
| Print pipeline, renderers, transports | [Printing](printing.md) |
| Tax engine and data-only packs | [Taxation](taxation.md) |
| Optional network features and offline degradation | [Cloud integrations](cloud-integrations.md) |
