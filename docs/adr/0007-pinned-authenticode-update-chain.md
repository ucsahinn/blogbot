# ADR 0007: Pinned Authenticode update chain

- Status: Accepted for updater trust; mandatory signed delivery superseded by [ADR 0009](0009-unsigned-manual-delivery.md)
- Date: 2026-09-03
- Supersedes: the unsigned updater risk acceptance in ADR 0003 for future builds
  compiled with an approved publisher pin

## Context

The original native updater constrained downloads to this repository's HTTPS
GitHub Release path and verified the manifest SHA-256 before execution. The
manifest and installer lived in the same release trust domain, so a compromise
of that domain could replace both values. The deferred installer also waited in
a user-writable temporary directory between verification and process creation.

The repository does not contain or control a Windows code-signing private key.
Certificate acquisition, CI secret configuration, signing, timestamping and
publication remain explicit operator approval gates.

## Decision

- The update client embeds the expected leaf signing-certificate SHA-256
  fingerprint at compile time through `OPE_UPDATE_SIGNER_SHA256`.
- A missing or malformed pin disables update checks and installation. There is
  no unsigned compatibility fallback.
- A downloaded installer must pass all existing origin, size and SHA-256 gates,
  then Windows `Get-AuthenticodeSignature` must report `Valid`.
- The signer certificate must match the embedded SHA-256 fingerprint and the
  signature must expose a time-stamper certificate.
- The same hash, Windows trust, signer and timestamp checks run again after the
  application exits. The deferred launcher holds the installer with
  `FileShare.Read` while it verifies and creates the process, preventing writes
  or replacement in that final trust window.
- The desktop build wrapper accepts Windows signing configuration only when the
  certificate thumbprint, RFC 3161 timestamp URL and update signer SHA-256 pin
  are all present and structurally valid. It passes SHA-256 plus RFC 3161
  settings to the Tauri bundler without storing private key material.
- Every spawned Windows helper (engine, fetcher and secure-restore) is a Tauri
  external binary. Packaged Sharp DLL/`.node` machine-code resources are signed
  explicitly with the same SHA-256/RFC 3161 contract before Tauri bundles them.
- The GitHub workflow reads the PFX/password only from the protected
  `windows-signing` environment, imports the certificate temporarily and
  non-exportably, verifies the app, all three Tauri-signed sidecars, the packaged Sharp DLL/`.node` runtime modules, NSIS and MSI,
  then removes every imported certificate, its associated private-key container
  with Certificate provider `-DeleteKey`, and every temporary credential file.
- Default workflow permissions and the signing job stay `contents: read`. A
  separate publication job alone receives `contents: write`; it receives no PFX
  secret and revalidates the exact payload, Authenticode chain, publisher pins
  and updater manifest before publication. It remains skipped unless the dispatch
  explicitly sets the default-false `publish_release` input.
- The build job rejects a dispatch outside `refs/heads/main` or a checkout whose
  commit does not equal the dispatched GitHub SHA before repository code runs.
- A commit-pinned SBOM action runs only after signing credentials are removed,
  emits SPDX JSON into the exact release payload and has dependency-snapshot,
  artifact-upload and release-asset writes disabled.
- A separate attestation job receives only `contents: read`, `id-token: write`
  and `attestations: write`. It revalidates the five-file payload through the
  shared verifier, then creates both provenance and SBOM attestations.
  Publication depends on successful attestation.
- Existing command and bridge names retain `unsigned` temporarily as wire/API
  compatibility identifiers. They do not authorize unsigned execution.

## Release boundary

The checked-in GitHub release workflow now implements this decision as a local
fail-closed contract. It has not been run with a real certificate and must not
be used to claim a signed release until real operator inputs and CI evidence
exist:

- a trusted code-signing certificate and protected private-key custody;
- the certificate-store SHA-1 thumbprint used by the Windows bundler;
- the leaf certificate SHA-256 fingerprint embedded in the app;
- an approved RFC 3161 timestamp service;
- a successful GitHub-hosted provenance and SBOM attestation run whose subjects
  match the independently verified signed payload;
- CI secret and environment protection policy.

The checked-in PFX lane is not a certificate acquisition or custody decision.
CA/Browser Forum requirements effective since 1 June 2023 require subscriber
private keys for publicly trusted code-signing certificates to remain protected
by an approved hardware/cloud crypto module or signing service. If the selected
provider does not permit a policy-compliant PFX export, this import lane must not
be used; a separately reviewed least-privilege provider integration is required.

The required configuration names are the protected environment secrets
`OPE_WINDOWS_CERTIFICATE_PFX_BASE64` and
`OPE_WINDOWS_CERTIFICATE_PASSWORD`, and repository variables
`OPE_WINDOWS_CERTIFICATE_THUMBPRINT`, `OPE_WINDOWS_TIMESTAMP_URL` and
`OPE_UPDATE_SIGNER_SHA256`. Missing or mismatched inputs stop the workflow.
Until these inputs are configured and the signed artifacts are independently
verified, release readiness remains blocked and an unpinned build's updater
stays fail-closed.

## Consequences

- Compromising the release manifest or GitHub artifact alone is insufficient to
  make the application execute an untrusted installer.
- Artifact attestations add verifiable build provenance and SBOM binding; they
  do not replace Authenticode, publisher pinning or clean-machine acceptance.
- Publisher-certificate rotation requires a deliberate overlap or migration
  release. Replacing the pin is a trust-root change, not a routine version bump.
- Revocation and certificate-chain evaluation depend on the Windows trust
  provider available on the user's machine.
- A correctly signed installer is still not a release: clean-machine install,
  N-1 upgrade, failure/rollback and persisted-data checks remain external gates.

## Verification

- Rust tests cover missing/malformed pins and the deferred hash/signature/
  timestamp/publisher gates before process creation.
- The 41/41 packaging/readiness contract tests cover complete signing configuration in the local build
  wrapper and the protected, least-privilege GitHub workflow.
- Local static checks parse the four-job YAML structure and all nine embedded
  PowerShell blocks, and confirm all twelve action uses are pinned to full
  commit SHAs.
- A Windows PowerShell 5.1 smoke fixture proves the shared payload verifier
  rejects an unexpected file and an unsigned executable without requiring or
  importing a real certificate.
- A real release additionally requires Authenticode inspection of the app,
  engine/fetcher/secure-restore sidecars, packaged Sharp DLL/`.node` runtime modules, NSIS installer and MSI plus clean Windows 10/11
  acceptance evidence.

## References

- [Microsoft WinVerifyTrust](https://learn.microsoft.com/windows/win32/api/wintrust/nf-wintrust-winverifytrust)
- [Microsoft Authenticode time stamping](https://learn.microsoft.com/windows/win32/seccrypto/time-stamping-authenticode-signatures)
- [PowerShell Get-AuthenticodeSignature](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature)
- [PowerShell Certificate provider private-key deletion](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/about/about_certificate_provider)
- [CA/Browser Forum Code Signing Baseline Requirements](https://cabforum.org/working-groups/code-signing/requirements/)
- [Tauri Windows code signing](https://v2.tauri.app/distribute/sign/windows/)
- [Tauri CLI 2.11.4 changelog](https://tauri.app/release/tauri-cli/all-versions/)
- [Tauri bundler 2.9.4 sidecar-signing source](https://docs.rs/crate/tauri-bundler/latest/source/src/bundle.rs)
- [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub `actions/attest`](https://github.com/actions/attest)
- [Anchore SBOM Action](https://github.com/anchore/sbom-action/blob/main/README.md)
