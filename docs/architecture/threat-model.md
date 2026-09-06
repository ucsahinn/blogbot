# Blogbot threat model

Date: 2026-09-03

## Executive summary

Blogbot is a local-only Windows desktop application. Its primary security
property is that article state, approvals, the queue, database and privileged
connectors remain on the editor's computer. Hetzner serves only the public
static site; it is not a Blogbot control plane.

The strongest residual risks are outside the repository's current local proof:
Windows release signing has not been provisioned, the GitHub App has not been
registered or installed on an approved single repository, and clean-machine
install/upgrade tests need controlled Windows environments. The local broker
now rejects classic OAuth scopes and unbound credentials, while the
application-side updater fails closed without a pinned publisher and a trusted
timestamped Authenticode signature. Missing external inputs therefore do not
silently expand repository access or degrade to unsigned execution.

## Scope and assumptions

In scope:

- the React WebView and named Tauri command bridge;
- the Rust desktop host, secure store and filesystem boundaries;
- the local engine, PGlite state and durable queue;
- source fetching, Codex execution and media generation;
- encrypted backup create/verify/preview/restore;
- GitHub authentication and publication effects;
- Windows installer update checks and execution;
- the static-site publication handoff.

Assumptions:

- Windows and the current user profile are not already fully compromised;
- the editor controls local confirmation and approval actions;
- operating-system trust stores and cryptographic primitives behave as
  documented;
- external providers can fail or become unavailable and must not turn that
  condition into a local write or publication;
- a malicious source document is untrusted input, never editorial authority.

Out of scope as guarantees:

- confidentiality against malware already running as the same Windows user;
- availability while the PC, user session or required connector is offline;
- security of GitHub, Codex, the selected source sites or the hosting provider
  after those independent systems are compromised;
- recovery of DPAPI-bound internal state on a different Windows profile.

## System model and trust boundaries

1. The React renderer receives local projections and can invoke only named
   commands allowed to the single `main` Tauri window.
2. Rust validates command input and owns access to DPAPI, filesystem pickers,
   GitHub tokens, process launch and Windows updater behavior.
3. Rust and the local engine exchange bounded, versioned NDJSON over inherited
   stdin/stdout; there is no Blogbot HTTP administration API.
4. The engine is the single writer for editorial state. Sensitive JSON records
   are authenticated and encrypted before PGlite persistence; the PGlite file
   itself is not claimed to be full-disk encrypted.
5. Fetcher, Codex runner, ImageGen provider and GitHub publisher are separate
   adapters with narrower data and effect contracts.
6. Backups cross from local state into an operator-selected filesystem path and
   require authenticated encryption plus preview before destructive restore.
7. Publication crosses into a selected GitHub repository only from an approved
   immutable revision and durable effect claim.
8. Installer updates cross from GitHub Releases into process execution and
   therefore require both content integrity and an independent pinned Windows
   publisher identity.

## Assets

- source captures and rights-review metadata;
- Turkish articles and fact-preserving English localizations;
- immutable revisions, media bytes, evidence links and approval hashes;
- publication intents, outbox effects, required checks and idempotency keys;
- the DPAPI-wrapped local data key and encrypted database records;
- GitHub tokens, Codex authentication state and provider credentials;
- backup recovery keys and encrypted archives;
- updater publisher pin, release digest and installer bytes;
- diagnostics, which must remain useful without disclosing secrets or article
  bodies unnecessarily.

## Attacker capabilities

- publish a malicious, oversized or redirecting web document at a configured
  source URL;
- control DNS answers during a fetch and attempt private-network rebinding;
- supply malformed renderer inputs or compromise renderer state;
- replace a GitHub release manifest and artifact if the release account or
  workflow is compromised;
- obtain a copied backup archive and attempt offline password guessing;
- steal a GitHub App access or refresh token from a compromised user profile;
- race or replace files in a user-writable temporary directory;
- cause connector, process or network failures at ambiguous points.

The model does not grant the attacker arbitrary same-user code execution at the
start; that capability already defeats DPAPI-backed confidentiality and most
desktop UI boundaries.

## Threat inventory

| Threat | Security impact | Repository control | Residual status |
| --- | --- | --- | --- |
| DNS rebinding or redirects reach loopback/private services | Data disclosure, SSRF | URL policy resolves and rechecks destinations, restricts schemes and rejects private targets | Mitigated locally; live network variance remains |
| Oversized or hostile source/media response exhausts memory | Availability | Response and document byte limits, streaming reads and structured parsing | Mitigated locally |
| Renderer forges a publication target or revision | Integrity, external write | Rust/engine validate repository, base SHA, adapter, file set and exact approved revision hash | Mitigated locally |
| Crash or retry duplicates a GitHub effect | Duplicate publication | Durable outbox claims, leases, idempotency keys and reconciliation | Mitigated locally; live GitHub acceptance pending |
| Source text becomes publishable copy without review | Copyright, integrity | Source is evidence only; generation, claim ledger, review and immutable approval are separate | Mitigated by product workflow |
| Local database row is modified or swapped | Integrity, confidentiality | AES-256-GCM envelopes, versioned validation, DPAPI-wrapped key and fail-closed open | Mitigated locally; same-user malware excluded |
| Copied backup is brute-forced or downgraded | Confidentiality | Version 2 scrypt policy, authenticated manifest/envelope match, bounded parser; version 1 read-only | Mitigated for new archives; password strength still matters |
| Restore escapes the chosen directory or follows a reparse point | Integrity | Native secure-restore path/handle checks and preview-before-apply contract | Mitigated locally; real profile restore pending |
| GitHub credential reaches an unrelated repository or gains extra permissions | Confidentiality, integrity | Classic scopes are rejected; the DPAPI bundle is bound to one repository, expiring tokens and an exact installation permission map | Mitigated locally; App registration, single-repository installation and live revocation/refresh remain external |
| Release account replaces installer plus manifest hash | Code execution | Compile-time signer SHA-256 pin, Windows trust, timestamp and duplicate pre-launch checks | Application path mitigated; signed CI/release rollout blocked |
| Temp installer changes after verification | Code execution | Deferred launcher opens with read-only sharing and verifies hash/signature/pin while locked before process creation | Mitigated locally; real installer acceptance pending |
| Diagnostics or logs disclose secrets | Confidentiality | Explicit redaction, bounded diagnostics and credential separation | Mitigated locally; production artifact scan remains a release gate |
| Codex/provider failure is mistaken for successful content | Integrity | Typed degraded/waiting states, schema validation, no paid fallback by default | Mitigated locally; live connector smoke pending |

## Security requirements

- No remote Blogbot service, database, worker or private panel may be introduced
  without a new architecture decision.
- Every publication must remain bound to the exact immutable revision hash and
  explicit human approval; any relevant mutation invalidates approval.
- External effects must be behind ports, idempotent where possible and
  fail-closed when their outcome is ambiguous.
- Secrets must not enter renderer state, repository files, diagnostics,
  instructions, logs or release artifacts.
- Fetches must retain scheme, origin, redirect, address and size controls.
- Backup KDF and envelope changes require explicit archive versioning and legacy
  compatibility tests.
- Installer execution must never fall back to unsigned mode when publisher
  configuration is missing or verification fails.
- Release signing, credential setup, publication and deployment require
  immediate operator approval.

## Verification and open gates

Local verification should include unit/integration tests, Rust tests and Clippy,
browser accessibility/viewport checks, builds, engine/fetcher smoke tests,
dependency audits and a redacted secret scan. Passing local checks proves only
the repository-controlled behavior.

External evidence still required:

- protected code-signing key custody and a pinned certificate identity;
- signed and timestamped app, NSIS and MSI inspection;
- clean Windows 10 and 11 install, N-1 upgrade, failure and rollback exercises;
- approved GitHub App registration and an exact single-repository installation;
- real GitHub dry-run/required-check behavior, Codex/ImageGen smoke and isolated
  static-site deployment rehearsal.

## Review triggers

Review this model when a new connector, remote service, database format,
credential store, updater trust root, publication adapter, executable child
process or cross-machine recovery feature is added. Also review it after a
security incident or a material Windows/GitHub/Tauri trust-model change.
