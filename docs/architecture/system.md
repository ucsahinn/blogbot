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
deduplicated pg-boss adapter, but the real Codex login/runtime connector is not
advertised as ready. Strict V2 revision save/list/get operations are wired from
PGlite through stdio into the Windows review queue and read-only review
workspace. Normal editorial approval is wired end to end and remains bound to
the engine-computed immutable revision hash. High-risk content now has a
separate engine approval command bound to a checklist hash, exact revision hash,
Windows secure-store readiness and an explicit second confirmation. The local
desktop also exposes encrypted backup verification/preview/restore and the
publication outbox. Remote publisher effects remain blocked or degraded until
the real GitHub and deployment connector checks succeed.

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
source records, source tests, automation state, durable jobs, immutable
revisions and normal editorial approvals are implemented. Candidate generation,
high-risk reauthentication, portable restore and publication still stop at
domain or connector boundaries.

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

1. Editing creates a new immutable revision.
2. Human approval binds the complete revision package hash.
3. A publication intent records the revision hash, target repository, base SHA,
   schedule and idempotency key.
4. The publisher reconciles an existing branch or PR before creating another.
5. A changed base SHA, revision, manifest, schedule or approval blocks progress.
6. Protected CI validates the content and static site.
7. GitHub Actions transfers the exact verified artifact to the user's selected
   static hosting target.
8. Health checks pass before the public `current` symlink changes; failure keeps
   or restores the previous release.

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

## Public section contract

| Turkish | English | Internal type | JSON-LD |
|---|---|---|---|
| `/haberler/{slug}/` | `/en/news/{slug}/` | `news` | `NewsArticle` |
| `/analiz/{slug}/` | `/en/analysis/{slug}/` | `analysis` | `Article` |
| `/dosyalar/{slug}/` | `/en/deep-dives/{slug}/` | `deep_dive` | `Article` |
| `/rehberler/{slug}/` | `/en/guides/{slug}/` | `guide` | `BlogPosting` |
| `/teknoloji/{slug}/` | `/en/technology/{slug}/` | `news` | `NewsArticle` |
| `/ekonomi/{slug}/` | `/en/business/{slug}/` | `news` | `NewsArticle` |
| `/kultur/{slug}/` | `/en/culture/{slug}/` | `analysis` | `Article` |
| `/yasam/{slug}/` | `/en/life/{slug}/` | `guide` | `BlogPosting` |

Current Turkish URLs do not gain a `/tr` prefix. Any future URL migration
requires a separate redirect, canonical and cutover approval.

These are the bundled generic Astro sections for a general blog or news site.
The legacy SiberDergi adapter intentionally accepts only its original four
sections; choosing a generic-only section with that adapter fails closed before
any publication artifact is created.

## Superseded runtime

The old `apps/api`, `apps/worker`, remote PostgreSQL, VPN, private Caddy
and private Compose runtime files were removed from the active repository.
Only their decision history remains in superseded ADRs; those ADRs must not be
used as V1 setup instructions.

Example static-release and GitHub Actions deployment assets remain optional.
Their local presence does not prove that a remote environment is configured or
deployed, and they are not required by the local-folder or local-development
work modes.
