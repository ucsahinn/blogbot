# Static audit remediation ledger — 2026-08-11

## Scope

This ledger reassesses the source snapshot findings in
`blogbot-static-audit-20260810T225351Z-fd32a84c.md` against the current
working tree. It is deliberately not a release approval: it distinguishes
local source/test evidence from items that need a real release identity,
external authorization, or a product-security decision.

## Locally remediated and regression-tested

| Finding group | Current invariant and primary evidence |
| --- | --- |
| F001–F003 | Publication plans digest the final text and media file set; desktop media is an engine-owned reference read in bounded chunks; warning acceptance keeps `reasonCode` in the canonical policy hash. See `apps/desktop/src/publication-files.ts`, `apps/engine/src/stdio-entrypoint.ts`, `apps/desktop/src/screens/ReviewWorkspace.tsx`, and `apps/desktop/tests/review-publication-files.test.ts`. |
| F004–F010 | Source policy/version/anchor data is carried into immutable revision evidence, append-only source versions are retained when referenced, and the production engine rejects direct `REVISION.SAVE`. See `packages/editorial/src/revision.ts`, `packages/database/src/source-repository.ts`, and `tests/integration/engine-editorial-protocol.test.ts`. |
| F011–F017 | Bounded/cursored reads, source dead-letter projection, Unicode numeric entity validation, and Markdown path policy checks are covered by the database, source-ingestion, and security tests. |
| F018–F024 | Publication processing starts only with a real processor; unknown deployment results do not become success; retry/idempotency state carries explicit terminal/manual outcomes. See `apps/engine/src/publication-outbox-worker.ts`, `apps/publisher/src/runtime.ts`, and their unit tests. |
| F025–F035 | The engine/fetcher/bridge hot paths use bounded payloads, safe-read-only retry classification, request routing by ID, and sidecar process separation. See `apps/desktop/src-tauri/src/engine_bridge.rs`, `apps/engine/src/fetcher-sidecar-transport.ts`, and `apps/fetcher/src/sea-entrypoint.ts`. |
| F036–F040, F043–F046 | Backup status/limits, typed corruption recovery, scheduler reservation, and idempotent scheduling state are explicitly modeled and tested. Restore is presented as local recovery/adoption rather than an unverified cross-machine success. |
| F048–F049 | Installer download is stream-capped, hashed incrementally, created with random exclusive temp names, and helper processes use the Windows no-window flag. See `apps/desktop/src-tauri/src/unsigned_updater.rs` and native tests. |
| F051–F052 | Preview state stores engine media references rather than embedded media bytes; publication intents bind the exact preview hash, manifest digest, target, and adapter identity. See `apps/engine/src/publication-preview.ts`, `apps/engine/src/publication-intent.ts`, and `tests/unit/publication-preview.test.ts`. |

## Not closed by local source changes

| Finding | Why it remains open | Required authoritative evidence or decision |
| --- | --- | --- |
| F041–F042 | **Accepted scope:** recovery is intentionally limited to the same Windows user profile. The local data key remains DPAPI-protected; no cross-machine recovery secret or envelope is stored or invented. | Closed as a documented product boundary. A future cross-machine feature requires a new recovery-secret/envelope design and explicit key-custody approval. |
| F047 | **Accepted risk:** automatic update remains enabled without a signing key. HTTPS, fixed GitHub release scope, stream limits, exclusive temporary files, and SHA-256 matching protect transport and accidental corruption, but do not establish an independent publisher identity. | Closed as an explicitly accepted risk. A future signing key requires a new trust-root, rotation, revocation, and release-custody decision; no private key belongs in this repository. |
| F050 | Closed. Local preview materialization now opens every directory and file relative to a verified root handle with `NtCreateFile`, opens reparse points themselves rather than following them, rejects them, and uses the same model for backup and rollback. `secure_preview_fs` tests cover normal backup, rollback of both prior and newly created files, and a deterministic post-root-handle junction swap. | `apps/desktop/src-tauri/src/secure_preview_fs.rs`; `npm.cmd run native:test` on 2026-08-12. |

## Current verification evidence

Run in this working tree on 2026-08-11:

```text
npm.cmd run test:all       # 438 passed, 0 failed, 1 skipped
npm.cmd run native:test    # 73 passed
npm.cmd run typecheck      # passed
git diff --check           # passed
```

Full-suite evidence must be refreshed after final review. Live GitHub
publication and update installation remain separate operational checks that
require the corresponding credentials and target-repository rules. The updater
is deliberately unsigned under ADR 0003; it is not described as signed or
independently publisher-authenticated.
