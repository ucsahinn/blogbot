# Blogbot security best-practices review — 2026-09-03

## Outcome

The repository-controlled attack surface was reviewed across the Windows
desktop bridge, updater, backup format, source/provider network reads, local
storage wording and GitHub authorization boundary. Several local controls were
implemented and are covered by focused tests. The release workflow now encodes
fail-closed signing, SPDX SBOM, provenance/SBOM attestation and isolated
publication contracts locally, while real certificate configuration, a signed
CI run, live GitHub App registration/installation exercises and real Windows
acceptance remain explicit external gates; this report does not mark them
complete.

## Scope

- Rust/Tauri command and updater boundaries
- source fetcher and ImageGen response handling
- public site URL validation
- logical and portable backup cryptography
- renderer-visible storage and offline/degraded status text
- folder-granted site inspection and local-project filesystem reads
- GitHub App authorization, repository/permission binding and token custody
- release workflow and Windows installer evidence

The review used repository source, existing tests and official Microsoft/Tauri
documentation. It did not read secrets, start authentication, mutate GitHub,
build installers, sign code, publish artifacts or access production hosting.

## Findings and disposition

| ID | Severity | Finding | Working-system disposition |
| --- | --- | --- | --- |
| BB-SEC-001 | High | GitHub manifest plus SHA-256 did not independently authenticate the Windows installer publisher | Mitigated in repository-controlled code and workflow: compile-time leaf certificate SHA-256 pin, trusted Authenticode status, time-stamper requirement, locked final recheck, protected temporary PFX import and independent publication-job revalidation. A real certificate and signed CI run remain external evidence gates. |
| BB-SEC-002 | Medium | GitHub OAuth requested `repo`, which could expose every private repository the token could reach | Mitigated in repository-controlled code: classic OAuth scopes and non-expiring grants are rejected; the desktop accepts only an expiring GitHub App device-flow grant bound to exactly one configured repository and the exact least-privilege permission map. Access/refresh credentials rotate as one DPAPI-protected bundle and revalidation failures clear/latch authorization. App registration, installation and live refresh/revocation remain external acceptance gates. |
| BB-SEC-003 | Medium | New backups used the legacy scrypt `N=16384` policy and the UI encouraged user-chosen recovery text | Mitigated in code: version 2 uses `N=131072, r=8, p=1`; version 1 remains read-only; the UI can generate a non-persisted 192-bit recovery key. |
| BB-SEC-004 | Low | ImageGen JSON responses could be read without a hard byte ceiling | Mitigated in code: content-length and streaming limits reject bodies above 32,000,000 bytes before JSON parsing. |
| BB-SEC-005 | Low | Demo/boot wording could be read as full PGlite-file encryption | Mitigated in UI copy: wording now describes protected/encrypted sensitive records, matching the AES-GCM record envelope design. |
| BB-SEC-006 | Medium | A configured public site string could carry credentials, path/query/fragment or a non-HTTPS scheme into trusted state | Mitigated in code: only a canonical HTTPS origin is accepted and legacy state is canonicalized or rejected. |
| BB-SEC-007 | Medium | A sidecar exit could race a successful response and trigger an unsafe retry | Mitigated in code: only pre-request DNS resolution can retry once; an HTTP request is never replayed after an ambiguous post-send exit. |
| BB-SEC-008 | Medium | Site detection and LOCAL_DEV validation used ordinary descendant path reads, so a hard link or junction inside a granted project could redirect `package.json` or `.git/config` inspection outside the selected root | Mitigated in code: bounded reads and existence checks now open every path segment relative to a verified Windows directory handle, reject reparse points and multi-link files, and request read-only access. Normal and adversarial disposable fixtures pass. |

## Implemented controls

### Windows update execution

`apps/desktop/src-tauri/src/unsigned_updater.rs` now:

- refuses update checks when `OPE_UPDATE_SIGNER_SHA256` is missing or malformed;
- verifies the downloaded digest before invoking Windows trust inspection;
- requires `Get-AuthenticodeSignature` status `Valid`, a signer certificate, a
  time-stamper certificate and the exact pinned signer SHA-256;
- repeats those gates after the application exits;
- holds the installer with `FileShare.Read` across the last verification and
  process creation so it cannot be written or replaced in that interval;
- removes rejected temporary installers.

`scripts/build-desktop.mjs` accepts a signing configuration only when the
certificate-store thumbprint, RFC 3161 timestamp URL and updater signer SHA-256
pin are all present and valid. It passes public metadata to Tauri; it does not
store or import a private key.

`.github/workflows/release-desktop.yml` now uses a protected
`windows-signing` environment, keeps default permissions read-only, checks out
complete tag history, and rejects a dispatch outside `refs/heads/main`, a
checkout-SHA mismatch or an already-existing release tag before tool setup or
repository code runs. It imports the PFX non-exportably into the runner certificate store,
signs with SHA-256 and an RFC 3161 timestamp URL, verifies the app, all three
Tauri-signed engine/fetcher/secure-restore sidecars and the explicitly signed
packaged Sharp DLL/`.node` runtime modules, NSIS and MSI against the same signature,
timestamp and publisher pins, and removes imported certificate records, associated
private-key containers and temporary credential files in an `always()` step.
Artifact upload follows successful cleanup.

After credential cleanup, a commit-pinned Anchore action emits an SPDX 2.3 SBOM
into the exact five-file payload with dependency-snapshot, artifact-upload and
release-asset writes disabled. A separate attestation job has only
`contents: read`, `id-token: write` and `attestations: write`; it runs the shared
payload verifier and creates both provenance and SBOM attestations. The
publication job depends on that job, alone receives `contents: write`, receives
no certificate secret, and runs the same verifier before `gh release create`.
It is skipped by default and can run only when the dispatch explicitly selects
the boolean `publish_release` input.

The workflow expects two protected environment secrets,
`OPE_WINDOWS_CERTIFICATE_PFX_BASE64` and
`OPE_WINDOWS_CERTIFICATE_PASSWORD`, plus three public repository variables,
`OPE_WINDOWS_CERTIFICATE_THUMBPRINT`, `OPE_WINDOWS_TIMESTAMP_URL` and
`OPE_UPDATE_SIGNER_SHA256`. No values were requested or stored. The local
workflow contract is not evidence that these settings exist or that an
artifact has been signed.

### Backup protection

`packages/backup/src/crypto-policy.ts` is now the single archive KDF policy.
Logical and portable creators emit version 2; parsers bind every supported
version to its exact KDF parameters and reject downgrade/mismatch attempts.
Compatibility tests construct version 1 fixtures and prove old archives remain
readable. Recovery keys generated in the desktop use Web Crypto randomness and
are cleared after every operation.

### Network and input bounds

- The fetcher distinguishes safe pre-request resolution retry from ambiguous
  post-request failure.
- ImageGen responses are streamed into a bounded buffer.
- Public site configuration is parsed as a URL and reduced to a canonical HTTPS
  origin before persistence/use.

### Folder-granted filesystem reads

`apps/desktop/src-tauri/src/secure_preview_fs.rs` now exposes read-only,
handle-relative bounded reads and file/directory checks. Site format detection,
repository-remote discovery, content-model detection, adapter dry-run and
LOCAL_DEV package validation use that layer. Every descendant is opened with
`FILE_OPEN_REPARSE_POINT`; reparse points and multi-link files fail closed, so a
junction, symlink or hard link cannot redirect inspection outside the selected
project. A regular disposable project and adversarial hard-link/junction
fixtures are covered by native tests.

## Existing controls confirmed

- Tauri exposes one named-command capability to the trusted main window; it
  does not grant generic shell, filesystem or HTTP plugin access.
- The engine remains the single writer for durable editorial state.
- Publication material is matched to an immutable revision, exact hash, target,
  adapter and human approval before an external effect can be claimed.
- Adapter materialization requires a non-empty pinned adapter version, binds
  TR/EN routes to one declared section capability, enforces its article type
  and rejects a referenced hero whose immutable media data is unavailable.
- GitHub tokens remain in the native DPAPI-backed store rather than renderer or
  engine payloads.
- Source URLs retain SSRF, redirect, scheme, DNS and private-address controls.
- Diagnostics and provider errors use bounded/redacted contracts.

## Open gates

### Explicit approval and operator input required

- acquire and protect a trusted Windows code-signing certificate/private key;
- create/protect the `windows-signing` environment, configure the two named
  secrets and three public repository variables, and define reviewers;
- separately authorize a non-production workflow run and retain Authenticode
  evidence for the app, engine/fetcher/secure-restore sidecars, packaged Sharp DLL/`.node` runtime modules, NSIS and MSI plus verified
  provenance and SBOM attestations for the exact signed subjects;
- register the approved repository-selected GitHub App, enable device flow and
  expiring user tokens, install it on exactly one authorized repository, and
  exercise live refresh/revocation without exposing credential values;
- run clean Windows 10/11 install, N-1 update, interrupted/failing update and
  rollback exercises;
- run real GitHub/Codex/ImageGen/static-site rehearsals without production
  publication unless separately approved.

### Recommended release hardening

- document certificate rotation with an overlap release and an emergency
  revocation path;
- retain online advisory checks in CI in addition to reproducible offline
  dependency audits.

## Verification evidence

Focused verification completed during implementation:

- fetcher transport unit tests, including repeated response/exit race coverage;
- ImageGen provider size-limit tests;
- backup integration tests for version 2, version 1 compatibility, tamper and
  downgrade behavior;
- Rust URL canonicalization and legacy-migration tests;
- Rust updater tests for pin validation and final pre-launch gates;
- targeted site-adapter and desktop publication-materialization tests for
  blank adapter-version rejection, cross-locale route/type mismatch and
  unavailable hero-media rejection;
- targeted browser tests for navigation, offline/degraded truth, semantic
  headings, reduced motion, viewport behavior, Boby keyboard handling and
  generated recovery-key non-persistence;
- full local Node, browser and Rust suites, lint, typecheck, frontend/engine
  builds, engine/fetcher smokes, security verification and native WebView
  smoke;
- 42/42 packaging/readiness contract tests, full four-job PyYAML parsing, local
  parsing of all nine embedded PowerShell blocks and full-commit-SHA validation
  of all twelve action uses, including Gitleaks pinned to the v2.3.9 commit
  rather than the v2 tag or its annotated tag-object SHA;
- Windows PowerShell 5.1 fail-closed smoke coverage for unexpected payload files
  and unsigned executables.

The current full-repository verification matrix and approval boundary are
recorded in the [2026-09-03 master completion checklist](OPE-MASTER-COMPLETION-CHECKLIST-20260903.md).
External items above remain unverified until the named operator actions occur.

## References

- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Microsoft WinVerifyTrust](https://learn.microsoft.com/windows/win32/api/wintrust/nf-wintrust-winverifytrust)
- [Microsoft Authenticode time stamping](https://learn.microsoft.com/windows/win32/seccrypto/time-stamping-authenticode-signatures)
- [PowerShell Signature class](https://learn.microsoft.com/dotnet/api/system.management.automation.signature)
- [Tauri Windows code signing](https://v2.tauri.app/distribute/sign/windows/)
- [Tauri CLI 2.11.4 changelog](https://tauri.app/release/tauri-cli/all-versions/)
- [Tauri bundler sidecar-signing source](https://docs.rs/crate/tauri-bundler/latest/source/src/bundle.rs)
- [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub `actions/attest`](https://github.com/actions/attest)
- [Anchore SBOM Action](https://github.com/anchore/sbom-action/blob/main/README.md)
