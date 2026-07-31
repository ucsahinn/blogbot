# ADR 0004: Local-first Blogbot runtime

- Status: Accepted
- Date: 2026-07-30
- Supersedes: ADR 0001 and the remote topology in ADR 0003

## Context

Blogbot is operated by one editor on one Windows device. Requiring a private
Hetzner API, WireGuard, a remote database and continuously running workers adds
installation and operational burden without being necessary when work is
allowed to stop with the user's computer.

The user's selected site remains a static public site. GitHub is the review and
CI boundary, while the user's selected hosting provider serves the resulting
immutable static artifact.

## Decision

Blogbot V1 runs its engine, scheduler, source fetcher, Codex runner and
publisher on the user's Windows computer.

- Tauri starts a bundled Windows sidecar; it does not connect to a Blogbot
  server.
- The Tauri Rust layer and engine exchange versioned NDJSON over stdin/stdout.
  No localhost REST API or generic WebView network command is opened.
- The engine is the single writer for sources, candidates, revisions, jobs,
  schedules, approvals, audit records and the publication outbox.
- PGlite provides embedded persistent storage. pg-boss runs on that local store
  for durable scheduling, retries and idempotent jobs.
- Fetcher, Codex and publisher remain separate least-privilege child-process
  boundaries.
- GitHub holds the selected site's source, PR and protected CI state.
- GitHub Actions deploys the approved static artifact to the selected hosting
  target. Blogbot does not store a hosting SSH key.

The Windows computer and user session must be running for scans, generation and
scheduled work. Offline local content may be viewed and edited, but operations
that require sources, Codex, GitHub or deployment are unavailable.

## Active implementation boundary

The repository currently packages a Node SEA sidecar through Tauri
`externalBin`, includes the PGlite runtime assets, persists engine state, starts
pg-boss and exposes doctor/state/versioned-command messages over stdio.

The old `apps/api`, `apps/worker`, remote PostgreSQL adapter, WireGuard,
private Compose, private API Caddy and server-container paths were removed from
the active repository. Their decision history remains only in superseded ADR
0001 and ADR 0003; those records are not setup instructions.

Public static-site deployment assets remain relevant. The presence of a
workflow or deploy script in this repository does not prove that GitHub,
Hetzner, DNS, credentials or production have been configured.

## Consequences

- The product has no public or private Blogbot web panel.
- End users do not install Node.js, Rust, Git, Docker or PostgreSQL to run the
  packaged application.
- Missed scheduled work is reconciled only after Blogbot starts again; it is not
  executed remotely while the PC is off.
- Local engine failure blocks state-changing work but does not block opening
  the application or viewing already available local data.
- Install, credential, Git/GitHub mutation, real site migration, DNS, deploy,
  packaging and release remain explicit approval gates.
- A future server profile would require a new ADR and must not silently become
  a dependency of the local product.

## Alternatives rejected

### Private Hetzner control plane

Rejected for V1 because it requires WireGuard, remote PostgreSQL, worker
operations and device pairing even though continuous execution is not a product
requirement.

### Public web administration panel

Rejected because Blogbot is a private single-editor desktop product and a public
panel would expand the attack surface without improving the selected workflow.
# ACTIVE ARCHITECTURE

The local engine is site-neutral. References to the original SiberDergi site
below describe the first adapter and migration fixture, not a requirement for
new users.
