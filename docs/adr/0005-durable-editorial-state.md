# ADR 0005: Durable editorial UI state belongs to the local engine

- Status: Accepted
- Date: 2026-07-30
- Supersedes: the temporary desktop-only JSON mutation fallback

## Context

The first local UI slice stored candidate actions, schedule changes and
preferences in files owned by the Tauri process. That made a restart recover
some display state, but it violated ADR 0004's single-writer rule and could
make the UI disagree with the engine after a crash or concurrent command.

## Decision

The local engine stores a small encrypted `blogbot_local_state` key/value table
inside PGlite. Versioned, idempotent `LOCAL_STATE.SET` commands mutate the
`desktop.editorial` document; `local.state.get` reads it for workspace
rehydration. The document contains only non-secret editorial UI state:

- candidate promotion/dismissal and edit events,
- weekly schedule configuration,
- author and notification preferences.

The Tauri layer may retain the legacy JSON files as a compatibility cache, but
it does not treat them as authoritative. Mutations fail when the engine is
offline or the optimistic version does not match.

## Consequences

- Restart and crash recovery use the same encrypted PGlite source of truth as
  revisions and jobs.
- Every state change receives an engine cursor entry and participates in the
  existing idempotency boundary.
- Existing local JSON files can be read as a migration fallback and removed in
  a later cleanup release; they never contain credentials or source archives.
- The engine schema now has migration version 4 (`local-state`).
