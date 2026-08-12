# ADR 0002: Immutable revisions and effectively-once publishing

- Status: Accepted
- Date: 2026-07-29

## Decision

An approval signs the canonical hash of an immutable article revision. The
revision includes both locales, metadata, routes, claim ledger, source
snapshots, media hashes, schedule, and the selected adapter identity
(`adapterId` and `adapterVersion`).

Publication materializes an immutable bundle with a validated manifest and
bundle policy. The manifest binds the revision id and revision hash to the hash
and allowed path of every generated entry; the bundle policy binds that bundle
to the adapter id/version and configured target. The publisher accepts only a
bundle that matches this policy.

Editing any value included in the revision creates a successor revision and
invalidates the old approval. Changing the adapter id/version, bundle manifest,
generated entries, target, route, or schedule invalidates the preview; a
revision change requires a new human approval. Publication uses a transactional
outbox, stable idempotency keys, unique external-effect records, and
reconciliation against GitHub and deployment state.

## Consequences

- We promise effectively-once observable effects, not impossible distributed exactly-once execution.
- A changed PR head SHA, expired schedule, incomplete source evidence, paused publishing, mismatched revision hash, or mismatched bundle/adapter identity blocks publication.
- Recovery checks existing external state before creating a new PR, merge, or release.
