# Security policy

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use a [private GitHub vulnerability report](https://github.com/FreeOpenSourcePOS/FloCafe/security/advisories/new) when possible, or email [support@flopos.com](mailto:support@flopos.com) with `SECURITY` in the subject line.

Include the affected version, a clear description, reproduction steps or proof of concept, expected impact, and any suggested mitigation. Remove customer data, credentials, access tokens, database files, and private URLs before sending a report.

We will confirm receipt, assess the report, and coordinate disclosure for confirmed issues. Please give us a reasonable opportunity to investigate and release a fix before publishing details. Credit is optional and will be given only with your permission.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Latest published release | Yes |
| Older releases | Upgrade to the latest release |
| Unreleased `main` branch | Best effort |

## Scope

Reports are welcome for FloCafe's desktop application, local API and kitchen-display server, authentication and authorization, data import or export, printing, release artifacts, dependencies, and GitHub Actions workflows.

Reports that require social engineering, access to someone else's device or account, or a deliberately insecure local configuration may be closed without a fix. If you are unsure whether something is in scope, report it privately.

## Run FloCafe safely

Keep FloCafe updated and keep its local API and kitchen-display ports off the public internet. Protect the computer and its operating-system user account because they hold the local database and backups. Use a strong owner password, limit access to backups, and revoke optional integration access when it is no longer needed.
