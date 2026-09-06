# ADR 0003: Local recovery boundary and unsigned update risk

## Status

Partially superseded — accepted 2026-08-12; updater decision superseded by ADR
0007 on 2026-09-03. The same-profile DPAPI recovery boundary remains active.

## Context

Blogbot is a local-only Windows desktop application. Its data key is protected
with Windows DPAPI, which intentionally binds it to the current Windows user
profile. The product does not have a signing key for installer releases.

## Decision

- Backup recovery is supported only for the same Windows user profile.
  Cross-machine or cross-profile recovery is not claimed or attempted.
- The GitHub Release updater remains enabled without a signing key. It is
  constrained to HTTPS GitHub release URLs and verifies the supplied SHA-256
  while streaming the installer into an exclusive temporary file.
- The absence of an independent publisher signature is an accepted product
  risk. The UI and diagnostics must not describe this updater as signed or
  independently authenticated.

## Consequences

- A copied backup alone cannot unlock content on another Windows profile.
  Cross-machine recovery requires a future, separately approved recovery
  secret/envelope and key-custody design.
- A compromise of the permitted release channel can provide an installer and
  a matching digest. A future signing implementation requires an embedded
  public trust root plus rotation and revocation policy; private keys must
  never be stored in this repository.
