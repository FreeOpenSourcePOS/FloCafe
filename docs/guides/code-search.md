# Indexed code search

FloCafe supports optional local indexed search with
[XERJ](https://github.com/xerj-org/xerj). It complements `rg`: use `rg` when you know a filename or
symbol, and indexed search when you need a small relevant passage from an unfamiliar or cross-cutting
part of the repository.

The search server is development tooling. It is not an application dependency, does not run in
packaged builds, and is not required to contribute.

## Install XERJ

Install XERJ using its [platform instructions](https://xerj.org/docs/install), then verify the local
setup from the repository root:

```sh
npm run search:doctor
```

The wrapper also checks the standard installer locations when a desktop application does not inherit
your shell `PATH`. Set `XERJ_BIN` to an absolute executable path when using another location.

## Start and index FloCafe

Keep the server running in one terminal:

```sh
npm run search:serve
```

In another terminal, build or refresh the index:

```sh
npm run search:index
npm run search:map
```

Search from a terminal with a plain-language description, or look up an exact symbol:

```sh
npm run search:query -- "where order visibility authorization is enforced"
npm run search:def -- createOrder
```

The index covers the repository as one `flocafe` corpus. XERJ applies `.gitignore`, its built-in
generated-file exclusions, and [`.xerjignore`](../../.xerjignore). Private specs, databases, backups,
dependencies, build output, media, fixtures, translated README copies, and other high-noise material
do not enter the index. The selected plan indexes code and current documentation without vector data.

The server binds to loopback through `--insecure`. Every process on the same machine can read or
change its indices, so do not expose port `9200` to a LAN or public interface. The shared server data
lives under the operating system's local application-data directory, while FloCafe's index state
lives under `.xerj/`, which Git ignores. This lets one local node hold the `flocafe`, `revflo`,
`orderflow`, and `floadmin` corpora without port conflicts. Set `XERJ_DATA_DIR` only when you need a
different shared location.

Re-run `npm run search:index` after pulling or making substantial changes. The no-graph index state
reconciles added, changed, moved, and deleted files.

## Connect Codex

Register the local MCP server once per machine:

```sh
npm run search:configure-codex
```

This command updates the current user's Codex MCP configuration and does not change repository files.
It is idempotent and does not replace an existing `xerj-local` registration. Restart Codex after
registration, keep `npm run search:serve` running, and use XERJ tools scoped to the `flocafe` prefix.
Limit responses to the few passages needed for the task so retrieval does not replace one large
context load with another.

Run `npm run search:doctor` when the tools are unavailable. The usual causes are a stopped local
server, a missing per-machine MCP registration, or a desktop application that needs restarting.

XERJ exposes tools that can publish feedback. FloCafe's no-unapproved-mutations rule still applies:
agents and contributors must not submit feedback, issues, pull requests, or other external changes
without explicit authorization.

## Choose the right search path

| Need | Tool |
| --- | --- |
| Known filename, literal, route, or symbol | `rg` or `rg --files` |
| Relevant implementation in an unfamiliar subsystem | XERJ search scoped to `flocafe` |
| Exact definition and nearby contract | XERJ definition search, then open the cited source lines |
| Final verification before editing | Current source and tests, not the search index |

Indexed passages are discovery results, not authority. Verify a result against the current file and
tests before changing behavior.
