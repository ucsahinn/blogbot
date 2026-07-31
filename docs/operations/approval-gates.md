# Operational approval gates

This page separates reversible local development from actions that change the
computer, credentials or external systems. It is an operator reference, not
evidence that any external setup has already occurred.

## Allowed local work

Repository reads, focused source/document edits and already-installed local
lint, tests, typecheck, build and smoke commands may run without contacting
external services. They must preserve unrelated user work and must not print
secrets.

## Approval required immediately before execution

1. Install or upgrade npm packages, Rust toolchains, WebView2, build tools,
   bundled third-party runtimes or OS prerequisites.
2. Initialize or mutate Git; commit, push, merge, create a repository, create a
   GitHub App or change branch protection.
3. Start Codex or GitHub login/device-flow, persist credentials or enable a
   paid API.
4. Create/change production environment secrets, deploy identities, recovery
   keys or other credentials.
5. Read or write real project content outside an approved dry-run; perform
   content migration, redirects or canonical changes.
6. Log in to a hosting provider; change DNS, Caddy, SSH, firewall, account, release
   directories or production files.
7. Run staging/production deployment, rollback or any external publication.
8. Restore a backup over existing data or delete/reset local application data.
9. Produce or distribute MSI/NSIS installers, sign code, configure updater,
   create tag/GitHub Release or publish a public artifact.

User-initiated, non-destructive product operations still require clear in-app
confirmation where they change durable state. High-risk publication requires
the separate review/reauthentication policy defined by the product plan.

## Removed V1 gates

VPN installation, private Blogbot API configuration, remote PostgreSQL
setup and device pairing are not V1 operations. Karar geçmişleri yalnız
superseded ADR kayıtlarında tutulur; aktif altyapı dosyalarında yer almazlar.

## External state

The repository may contain example GitHub workflow and hosting deploy assets, but their
presence does not confirm:

- a configured GitHub App or production environment;
- valid secrets or branch protection;
- a prepared hosting target;
- a successful staging or production deploy;
- a public release.

Each claim requires live read-only verification and the corresponding
write/publish action still needs explicit approval.
