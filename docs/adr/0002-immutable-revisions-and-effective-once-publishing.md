# ACTIVE SITE-NEUTRAL CONTRACT

The first certified adapter is an implementation detail; approval and
idempotent publication apply to the site project selected by each user.

# ADR 0002: Immutable revisions and effectively-once publishing

- Status: Accepted
- Date: 2026-07-29

## Decision

An approval signs the canonical hash of an immutable article revision. The revision includes both locales, metadata, routes, claim ledger, source snapshots, media hashes, schedule, and SiberDergi adapter version.

Editing any included value creates a new revision and invalidates the old approval. Publication uses a transactional outbox, stable idempotency keys, unique external-effect records, and reconciliation against GitHub and deployment state.

## Consequences

- We promise effectively-once observable effects, not impossible distributed exactly-once execution.
- A changed PR head SHA, expired schedule, incomplete source evidence, paused publishing, or mismatched revision hash blocks publication.
- Recovery checks existing external state before creating a new PR, merge, or release.
# ACTIVE, SITE-NEUTRAL CONTRACT

The first certified site adapter is an implementation detail. Approval and
idempotent publication apply to whichever site project the user configures.
