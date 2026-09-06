# ADR 0009: Unsigned manual delivery

- Status: Accepted
- Date: 2026-09-06
- Partially supersedes: ADR 0007's mandatory signed delivery lane; its updater trust boundary remains unchanged.

## Context

The operator has no Windows signing certificate and explicitly selected an
unsigned delivery baseline, authorized source commit and push, and deferred
the remaining external acceptance work. A signing certificate must not be a
prerequisite for ordinary local implementation completion.

## Decision

- Local desktop builds remain unsigned when no signing configuration is supplied.
- The manually dispatched desktop workflow defaults `sign_windows` to `false`.
  This lane uses `windows-unsigned`, passes empty public signing configuration,
  and skips certificate validation, import, signing, signature inspection and
  certificate-store cleanup. No Windows signing secret is needed.
- The existing protected signing lane is retained only as a future explicit
  opt-in. Its certificate custody requirements and fail-closed cleanup remain.
  The historical `build-signed` job identifier is retained for compatibility;
  its displayed name identifies the selected mode.
- Payload verification accepts unsigned files only with explicit
  `-SigningMode unsigned`. Its default remains signed. Exact file-set, manifest
  metadata, repository URL, installer SHA-256 and SPDX checks still apply.
- SHA-256 detects a mismatch with the manifest; it does not independently prove
  publisher identity when both files come from the same source.
- The desktop updater remains fail-closed without an embedded publisher pin.
  Unsigned delivery is for manual installation, not automatic or in-app update
  installation. The existing update check reports `UPDATE_SIGNER_NOT_CONFIGURED`.
  Do not weaken the native signature or deferred-launcher checks to enable it.
- Public release notes must identify unsigned/manual-installation builds.
  Windows publisher verification is unavailable for such builds.
- Source push runs verification CI only. The release workflow remains manual;
  publication additionally requires the default-false `publish_release` input.
  SBOM/provenance gates and a separate least-privilege publish job remain part
  of that future workflow, not evidence of a release performed now.
- No version bump, installer regeneration, tag, release, publication, deployment,
  certificate operation or dependency change is part of this source handoff.

## Deferred verification

The interrupted 24-hour soak is not a pass. Real-provider publication, chosen
site clone, clean Windows installation/upgrade, real legacy-data restore,
human content acceptance and coordination-board attachment are deferred by the
operator. They remain unverified, not completed and not known code defects.

## Verification

The release-script fixture executes the real PowerShell payload verifier with
synthetic files and no signing environment. It checks unsigned acceptance,
tampered installer rejection, extra-file rejection, invalid mode rejection and
the signed lane's continued requirement for certificate configuration.
The original signed-lane fixtures and native updater guards are retained.
This is local code evidence, not a GitHub-hosted or clean-machine release run.
