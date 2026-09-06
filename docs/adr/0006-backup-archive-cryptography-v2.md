# ADR 0006: Backup archive cryptography v2

- Status: Accepted
- Date: 2026-09-03

## Context

Portable and logical backups used a version 1 envelope with scrypt parameters
`N=16384, r=8, p=1`. The format was authenticated with AES-256-GCM and bounded
on create and restore, but the password derivation cost no longer provided the
desired margin for newly created archives. Existing archives must remain
recoverable without silently reinterpreting their password bytes.

The desktop also accepted a user-entered recovery key but did not offer a
cryptographically generated value. That encouraged human-chosen secrets even
though the application deliberately does not persist the key.

## Decision

- New logical and portable archives use envelope and manifest version 2.
- Version 2 uses scrypt `N=131072, r=8, p=1` with a 256 MiB maximum-memory
  budget, a random salt and AES-256-GCM authenticated encryption.
- Version 1 remains read-only and must carry its exact historical parameters.
  An envelope/manifest version mismatch or version/KDF mismatch is rejected.
- Version 2 recovery keys are normalized with NFKC before derivation. Portable
  version 1 retains its historical raw-input behavior; changing that behavior
  would make some valid legacy archives unreadable.
- The desktop can generate 24 random bytes with the Web Crypto API and display
  them as 48 hexadecimal characters. The generated key is 192 bits, is never
  persisted by OPE and is forgotten after each create/verify/preview/restore
  operation.

## Consequences

- Password guessing against newly created archives costs more CPU and memory.
  One local development measurement completed the version 2 derivation in
  approximately 269 ms; this is evidence from one machine, not a universal
  latency guarantee.
- Opening an archive may be slower, but it remains an explicit backup action
  rather than an interactive keystroke path.
- Existing version 1 archives remain restorable with their original behavior.
- Increasing the KDF again requires a new archive version and compatibility
  tests; parameter changes must never be inferred from the running app version.

## Verification

- Integration tests assert the version 2 envelope and KDF parameters.
- Synthetic version 1 fixtures prove backward-compatible restore behavior.
- Downgrade, tamper, manifest mismatch and resource-bound tests remain active.
- Desktop model and browser tests prove that generated recovery keys have the
  expected format and are absent after reload.
