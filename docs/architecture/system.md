# System architecture

This page explains the approved Blogbot V1 topology and distinguishes it from
the currently verified runtime foundation. ADR 0001 and ADR 0003 retain the
older remote-backend proposal for history; ADR 0004 is authoritative.

## Runtime topology

```text
Windows
└─ Tauri desktop
   ├─ packaged React/Vite WebView
   ├─ Rust bridge, Windows secure store, tray and notifications
   └─ Node SEA engine sidecar
      ├─ PGlite state
      ├─ pg-boss queue
      ├─ fetcher child-process boundary
      ├─ isolated Codex child-process boundary
      └─ content-only GitHub publisher boundary

GitHub
└─ private repository selected by the user and protected CI
   └─ approved static artifact
      └─ GitHub Actions deploy
         └─ user's selected static hosting target
```

No Blogbot service listens on a remote server or localhost. The WebView calls only
allowlisted Tauri commands. The Rust layer owns the sidecar process and sends
newline-delimited, versioned JSON over its standard streams.

The repository currently verifies the sidecar, encrypted PGlite JSON records,
pg-boss, doctor/state/automation and source list/test/save/scan command paths.
Fetcher probes and restart-safe queued source scans are wired end to end.
Codex jobs have encrypted, restart-safe, versioned PGlite persistence plus a
deduplicated pg-boss adapter. The desktop checks the separately installed Codex
runtime and login state; the isolated runner verifies its CLI/tool/MCP contract
before accepting work. Strict V3 revision save/list/get operations are wired
from PGlite through stdio into the Windows review queue. Editorial approval
binds human attestation, source roles and the engine-computed immutable revision
hash; revocation is immutable, recalls unclaimed effects and blocks later
preview/claim attempts. High-risk content has a separate engine approval command
bound to a checklist hash, exact revision hash, Windows secure-store readiness
and explicit second confirmation. The desktop also exposes encrypted automatic
and portable backup verification/preview/restore plus the durable publication
outbox. Remote publisher effects remain blocked or degraded until the real
GitHub and deployment connector checks succeed; no live remote readiness is
inferred from these local paths.

## Trust boundaries

| Boundary | May access | Must not access |
|---|---|---|
| Desktop WebView | Packaged UI and typed Tauri commands | Generic HTTP, filesystem, shell, remote scripts/fonts |
| Desktop Rust | Sidecar stdio, DPAPI, tray and notifications | Site/deploy credentials, generic WebView passthrough |
| Local engine | PGlite, pg-boss and versioned domain commands | Public listener, remote Blogbot database |
| Fetcher child | Approved public HTTPS targets through SSRF policy | Private/metadata networks, Codex/GitHub credentials |
| Codex child | Schema-bound evidence and dedicated minimal auth/config | User config/rules/MCPs, site repo, Blogbot data, GitHub/deploy credentials |
| Publisher child | Approved immutable bundle and scoped GitHub identity | Codex auth, arbitrary files, hosting SSH key |
| GitHub CI/deploy | Pinned source/artifact SHA and environment secrets | Blogbot local data, Codex auth |
| Static hosting target | Versioned static release directories | Blogbot UI, API, queue, database or workers |

## Local engine-owned state

The list below is the V1 ownership contract. At the currently wired boundary,
source records/tests/scans, candidate ranking, automation state, durable jobs,
immutable V3 revisions, normal and high-risk approvals, approval revocation,
portable/automatic restore and publication intents are implemented. Networked
Codex, source and GitHub/deploy effects still stop at their connector boundary
when authentication, network or required workflow evidence is unavailable.

- automation settings and independent ingest/publish pauses;
- sources, trust/rights reviews, mappings, scans and evidence snapshots;
- candidate clusters and deduplication evidence;
- immutable article revisions and TR/EN pairs;
- claim ledger and editorial, SEO and security reports;
- approvals, publish intents, outbox, effect and audit records;
- schedules, retries, dead letters and local synchronization cursor.

The engine is the only writer. Tauri's single-instance plugin prevents a second
desktop process from starting a second engine and focuses the existing window.
State-changing commands carry `requestId`,
`idempotencyKey` and `expectedVersion`. PGlite persists state under the current
Windows user profile; pg-boss provides durable local jobs. A second desktop
instance must not create a second writer.

## Offline and shutdown behavior

- Target V1 behavior allows local content already present on the device to be
  viewed and edited offline. The packaged desktop exposes the persistent review
  workspace and normal/high-risk approval paths. Direct in-place editing is not
  allowed; an edit request creates a new immutable revision.
- Fetching sources, Codex calls, GitHub checks and publishing require Internet.
- Closing the window may minimize Blogbot to the system tray.
- Exiting Blogbot or ending the Windows session stops the local engine.
- On restart, durable jobs are reconciled before a new external effect is
  created.
- A missed scheduled publication is never silently backdated. The grace-window
  and reapproval rules are evaluated when the application returns.

## Effectively-once publishing

1. Editing creates a new immutable revision and revision hash.
2. Publication materializes one immutable bundle for that revision. Its manifest
   records the revision hash and the hashes and paths of every generated entry;
   its validated bundle policy identifies the `adapterId` and `adapterVersion`.
3. Human approval is bound to the exact immutable revision hash. The preview and
   publication steps must then use a bundle whose manifest, adapter identity and
   generated-entry hashes match that approved revision.
4. A publication intent records the revision hash, bundle/preview hash, adapter
   identity, target repository, base SHA, schedule and idempotency key.
5. The publisher reconciles an existing branch or PR before creating another.
6. A changed revision, bundle manifest, adapter id/version, generated entry,
   target base SHA, schedule or approval blocks progress and requires a new
   preview and approval where the revision changed.
7. Protected CI validates the approved bundle and target site.
8. GitHub Actions transfers the exact verified artifact to the user's selected
   static hosting target. Health checks pass before the public `current` symlink
   changes; failure keeps or restores the previous release.

This is an effectively-once observable-effects contract, not a claim of
distributed exactly-once execution.

## Codex task policy

UI and domain contracts use logical roles rather than hard-coded model names:

- `fast`: classification, metadata and uncertain dedupe;
- `default`: research synthesis, Turkish drafting and English localization;
- `deep_review`: contradiction, sensitive claims and final review.

Each task uses a dedicated Blogbot auth/config boundary and schema-constrained
output. Source material is explicitly untrusted evidence. Tool, file-change,
MCP, shell and publication attempts are rejected. Auth or quota loss leaves the
job waiting; paid API fallback is never selected automatically.

## Site adapter and bundle contract

Site-specific routes, sections, schemas, file paths and deployment behavior are
owned by the selected adapter, not by the Blogbot core contract. Each adapter is
identified by a stable `adapterId` and a non-empty `adapterVersion`. The selected
adapter must fail closed if the configured site, generated paths, or requested
content cannot satisfy its policy.

The publisher accepts only an immutable bundle with a validated manifest and
bundle policy. The manifest binds the revision id and revision hash to the hash
and allowed path of every generated entry; the bundle policy binds that bundle
to the adapter id/version and configured site target. Arbitrary files and routes
are outside the adapter contract. Changing an adapter id/version, manifest,
entry path/hash, site target, route, schedule or source revision invalidates the
prior preview; any changed revision also invalidates its human approval.

## Superseded runtime

The old `apps/api`, `apps/worker`, remote PostgreSQL, VPN, private Caddy
and private Compose runtime files were removed from the active repository.
Only their decision history remains in superseded ADRs; those ADRs must not be
used as V1 setup instructions.

Example static-release and GitHub Actions deployment assets remain optional.
Their local presence does not prove that a remote environment is configured or
deployed, and they are not required by the local-folder or local-development
work modes.
