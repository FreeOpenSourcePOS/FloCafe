# Writing FloCafe documentation

`docs/` describes the current supported system. This file describes how to write it.
It applies to agents and human contributors alike. See [AGENTS.md](AGENTS.md) for the short policy
and [docs/README.md](docs/README.md) for the index.

## 1. Purpose

`docs/` answers two questions for a reader who has never seen this repository before:

- How does the current system work, and what contract does each part of it hold?
- How do I perform a recurring task against that system?

Everything in `docs/` must be answerable from the current code. Documentation is not a record of
how the system was built.

## 2. Document types

| Directory | Type | Holds |
| --- | --- | --- |
| `docs/architecture/` | Explanation | How the current system is put together, why the boundaries sit where they do, and what fails at each boundary. |
| `docs/reference/` | Reference | Contracts a caller must satisfy: schemas, field lists, matrices, event names, invariants. Looked up, not read through. |
| `docs/guides/` | How-to | A recurring procedure with an outcome, such as adding a language or a tax pack. |
| `docs/maintainers/` | How-to | Release, packaging, and store-publishing procedures for people with the credentials. |
| `docs/decisions/` | Architecture decision record | A choice made once, with consequences that outlive the change. |

Prefer fewer, stronger canonical documents. A new page is a maintenance commitment, not a
formatting choice.

## 3. Material that does not belong in `docs/`

None of the following survive as permanent documentation. Each belongs in an issue, a pull-request
description, a spec repository, or git history:

- Implementation plans, phase breakdowns, or task orderings.
- Research reports, vendor comparisons, or capability studies whose conclusions are now encoded in
  code.
- Security audits, test matrices, and verification transcripts. Tests and CI are the record.
- PR handoffs to another team or person.
- Dated status banners, `PASS`/`NOT-RUN` verdicts, and dated snapshots.
- Branch names, commit SHAs, workflow-run links, and PR histories.
- Word-list glossaries. The authoritative artifact is
  `frontend/src/lib/i18n/messages/<lang>.json`, and `npm run i18n:check` enforces leaf parity
  against `en.json`.

Git history is the archive. Do not create an `archive/` directory inside `docs/`.

## 4. Source of truth

In priority order:

1. Current runtime code.
2. Current tests and executable contracts.
3. Explicit product decisions in
   [`docs/reference/product-invariants.md`](docs/reference/product-invariants.md).
4. Repository configuration and workflows.
5. Existing documentation, as research material only.

Verify every behavioral claim against code, tests, or configuration before you write it. When code
and documentation disagree, investigate and fix the documentation; do not copy the stale text
forward. A decision documented without a checkable verification command is a decision that is easy
to violate without noticing.

## 5. Surgical updates

- Find the canonical section that owns the subject and rewrite it. Never append a "phase update",
  a "corrections" section, or a dated addendum.
- Remove superseded text in the same change. A reader must never have to choose between two
  statements of the same fact.
- Create a new page only when no current page owns the subject. Update before you create.
- One claim, one home. If a fact already exists elsewhere, link to it instead of restating it.
- After the edit, the finished document should read as if it was written today.

## 6. Style

Write plain, direct technical prose.

- Present tense for behaviour. Address the reader as "you" for actions, third person present for
  reference entries.
- No "currently", no "as of `<date>`", no phase language, no speculation about future work.
- No em dashes. Use a hyphen or restructure the sentence.
- Put identifiers, filenames, commands, field names, and event names in backticks, and link to the
  canonical file rather than pasting its contents.
- Distinguish a contract from an example. Label examples as examples.
- State constraints and failure behaviour, not just the happy path. For anything that can fail
  offline or in a degraded state, say what happens.
- No marketing language. No superlatives. No "simply", "just", or "obviously".
- Do not state a fact that the code does not enforce, and do not describe behaviour that does not
  exist yet.

## 7. Links and code references

- Use relative links for in-repository targets, so they resolve on GitHub and in a local checkout.
- From a page in a subdirectory, a link to a repository file needs the right number of `../`
  segments. `npm run docs:check` fails on any that do not resolve.
- Link to a heading with a GitHub-style anchor. Do not put issue or PR numbers in headings: they
  change the anchor and silently break every inbound link.
- Cite `file:line` when a claim is a specific implementation detail and the line is stable enough
  to be useful. Do not cite line numbers in reference material where they will rot on the next
  edit; name the file and the symbol instead.
- Verify a link target before you write it, including links to files that are about to be moved.

## 8. Diagrams

Use a Mermaid diagram when a relationship is genuinely harder to follow in prose: process and
boundary maps, data flow, and sequencing. Do not use a diagram as decoration, and do not draw
something a short list says better. Diagrams are source-controlled in Markdown and must render on
GitHub. Tables are usually the right choice for reference material.

## 9. Verification

Run these before opening a pull request that changes documentation:

```sh
npm run docs:check    # markdownlint, relative links, index completeness, policy patterns
git diff --check      # whitespace errors
```

`docs:check` has two halves. `docs:check:structure` (Markdown lint, relative links, index
completeness) always gates. `docs:check:policy` reports development-process material and currently
reports warnings only; it is a ratchet, and it is promoted to a gate once the corpus is clean.

The policy check matches each category of material listed in section 3, plus workflow-run links,
`NOT-RUN` and verdict transcripts, and issue or pull-request references. A page that legitimately
needs one, such as a decision record citing the issue it supersedes, opts out with a comment naming
the rule:

```markdown
<!-- docs:policy-allow: issue-reference -->
```

Use it for a named exception, not to silence a check you disagree with. If a rule produces a
constant false positive, fix the rule instead.

When a claim depends on runtime behaviour, run the focused test suite that covers it. The
verification table in [AGENTS.md](AGENTS.md) lists the minimum check per change type. Do not claim
verification you did not run; report a check you could not run, and why.
