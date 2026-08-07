# FloCafe 2.7.0 security audit

Date: 2026-08-04

## Result

No critical or high-impact exploitable application vulnerability was confirmed in this review. Production and development dependency audits are clean after updating vulnerable transitive tooling packages. The checked local database passes SQLite integrity, foreign-key, identifier, relationship, and bill consistency checks.

## Open findings

### SEC-01 — LAN traffic is not encrypted (Medium)

The POS and KDS servers listen on all interfaces and use HTTP/WebSocket rather than TLS. API authentication and restrictive CORS prevent unauthenticated browser access, but CORS is not transport security: an attacker on an untrusted local network may be able to observe bearer tokens and business traffic.

Recommended follow-up: treat FloCafe's LAN as trusted in current deployments, then add authenticated device pairing and TLS (or a documented Tailscale/VPN-only mode) before use on guest or shared Wi-Fi.

### SEC-02 — Electron renderer sandbox is disabled (Medium)

The main window explicitly sets `sandbox: false`; Windows also disables Chromium's GPU sandbox globally as a compatibility workaround. `contextIsolation: true`, `nodeIntegration: false`, CSP, and external-window URL allowlisting materially reduce the risk, but a renderer compromise has less process isolation than Electron's preferred configuration.

Recommended follow-up: test the main and KDS windows with renderer sandboxing enabled, add navigation guards for every window, and replace the global Windows GPU workaround with an opt-in or crash-triggered fallback.

### SEC-03 — Direct Windows installer is unsigned (Medium)

The release workflow intentionally produces an unsigned NSIS installer when Windows certificate secrets are absent. Users receive SmartScreen warnings, and Windows cannot verify the publisher of the downloaded installer.

Recommended follow-up: integrate an HSM-backed or managed open-source code-signing service and make signature verification a mandatory release gate.

### SEC-04 — Repository scanning coverage is incomplete (Low)

Dependabot reports no open alerts. GitHub code scanning has no analysis configured, and secret scanning is disabled for the repository. A local tracked-file credential-pattern scan found no embedded credential; the only match was code that recognizes PEM input.

Recommended follow-up: enable CodeQL and GitHub secret scanning/push protection where the repository plan permits it.

### SEC-05 — WhatsApp session material is stored locally (Low)

The WhatsApp credential directory is created with owner-only directory permissions, but session files are not encrypted with the operating system keychain. Malware or another process running as the same OS user could copy the linked WhatsApp session.

Recommended follow-up: encrypt sensitive credential values with Electron `safeStorage`, while retaining restrictive filesystem permissions and the existing logout/wipe behavior.

## Privacy note

Store-attributed diagnostics are enabled by default for new installs in 2.7.0 at the product owner's request. Existing explicit opt-outs are preserved. The payload remains separate from anonymous telemetry and excludes customer data, order contents, merchant contact details, and raw logs. This default should still be reviewed against deployment-country notice and consent requirements.

## Controls verified

- JWT secrets are generated uniquely per installation; revoked, stale, deactivated-user, and role-changed sessions are rejected.
- Sensitive database exports redact passwords, PIN hashes, JWT secrets, and cloud outbox content.
- Role authorization and IDOR regression tests pass across staff, order, KDS, backup, and database routes.
- Authentication and master-PIN paths are rate-limited, including requests from private/LAN addresses.
- CORS, outbound URL, and SSRF target validation tests pass.
- CSP blocks remote scripts and `eval`; renderer Node integration is disabled and context isolation is enabled.
- Tax-pack downloads require a trusted Ed25519 signature. The legacy compatibility exception accepts only exact embedded India/Thailand artifacts and rejects modified unsigned artifacts.
- macOS direct-download builds are configured for hardened runtime, signing, notarization, and stapling checks.
- SQLite runs in WAL mode with migrations, pre-migration backups, integrity checks, and foreign-key checks.

## Verification performed

- `npm audit` and `npm audit --omit=dev` in the root and `frontend/`
- `npm run test:security`
- `npm run test:cors`
- `npm run test:url-allowlist`
- `npm run test:tax-pack-management`
- `npm run audit:db`
- tracked-file credential-pattern scan
- manual review of Electron window preferences, IPC exposure, API authentication, CORS/rate limiting, URL handling, release signing configuration, diagnostics defaults, WhatsApp credential storage, and tax-pack trust validation
