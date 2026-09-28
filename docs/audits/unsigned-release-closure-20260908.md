# OPE v0.1.55 unsigned release closure

Revalidated: 2026-09-08. Status: **PUBLISHED; deferred acceptance is not passed.**

## Task contract

- Goal: reconcile the historical completion ledger with the actual release and
  identify the remaining acceptance work without inventing runtime evidence.
- Inputs: the operator's unsigned-release authorization, GitHub release/CI
  records, retained build logs and downloaded public release assets.
- Hard boundaries for this follow-up: documentation and read-only verification;
  no installation, credentials, real user database access, external writes,
  new release, commit/push, broad cleanup or long-running test launch.
- Done when: current delivery evidence and deferred acceptance are distinguished
  and older source-only records point here.

## Published delivery

- [OPE v0.1.55](https://github.com/ucsahinn/blogbot/releases/tag/v0.1.55)
  was published at `2026-09-06T22:17:36Z` (7 September, 01:17:36 Turkey time).
  It is not a draft.
- Source commit: `6d05db5be96431ed5a016af4cfca81079b99c359`.
- [Release run](https://github.com/ucsahinn/blogbot/actions/runs/34061153781):
  successful build, Gitleaks scan, provenance/SBOM attestation and separate publish
  job. The final successful attempt, not an earlier failed attempt, is the proof.
- [Source CI](https://github.com/ucsahinn/blogbot/actions/runs/34061153731):
  successful on the same commit.
- Manual unsigned installation follows [ADR 0009](../adr/0009-unsigned-manual-delivery.md).
  No Windows signing certificate was used. Automatic update installation remains
  fail-closed without the configured publisher pin. GitHub build provenance is
  not Windows Authenticode publisher authentication.

## Verification evidence

| Surface | Observed result | Boundary |
| --- | --- | --- |
| Node matrix | 910 tests: 906 passed, 4 skipped, zero failures | Unit 489; app 171; integration 246 passed of 250. Skipped live tests are not acceptance evidence. |
| Browser | 155 passed | Synthetic desktop QA, not clean-machine installer acceptance. |
| Native Rust | 255 passed | Does not establish a continuous 24-hour runtime. |
| Static/security/runtime checks | Passed in release CI | Lint, typecheck, build, secret scan, npm/Rust audits, native lint, engine/fetcher smoke. |
| Downloaded public payload | All four SHA-256 values match GitHub asset digests | Recomputed locally on 8 September; not merely copied from release metadata. |
| EXE/MSI signature | Both `NotSigned` | Expected for manual unsigned delivery; not a trusted-publisher claim. |

Retained local evidence is under `build/verification/`, excluded from Git:
`release-0.1.55-success-build.log`, `release-0.1.55-published-assets/`, and the
prior EXE/MSI attestation verification logs. Public CI and release links above
remain the portable evidence; these logs and binaries are not committed.

| Published file | Bytes | SHA-256 |
| --- | ---: | --- |
| `latest.json` | 640 | `8cdc2703a01219621598569eb0add61a595fd4a1de166842e694e53eb93de137` |
| `ope-sbom.spdx.json` | 1988259 | `2aaef4b5f41700dc4be958257ff0346b109805c05824643ed3db2ab137541990` |
| `OPE_0.1.55_x64-setup.exe` | 61738274 | `28f602cb4c8c5f52cc8a0bbdb7013cba5f328279cca3540ba4e9a6fd5aec88f4` |
| `OPE_0.1.55_x64_en-US.msi` | 89298911 | `298c4bba94c1ad2f59e7633836aa8f9612ce3405db2883ea0c1a153169e7f37f` |

## Remaining acceptance, not release blockers

The detailed procedures remain in the
[external acceptance runbook](../operations/external-acceptance-runbook.md).
This follow-up does not start them or change their approvals.

- [ ] Clean Windows installation and N-1 upgrade: identify disposable Windows
  environments; prove launch, data readability, tray/notification/exit behavior,
  interrupted installation and rollback. Do not install over the user's working
  application as an implicit test. Signed automatic-update acceptance is outside
  the current lane.
- [ ] Real archive and legacy migration acceptance: select an approved disposable
  copy, preserve the original profile and DPAPI boundaries, compare restored
  rows/media and test interruption. Synthetic migration tests do not close this.
- [ ] Continuous 24-hour scheduler acceptance: agree an uninterrupted observation
  window; run the account-free fixture with overdue recovery, maintenance,
  duplicate-effect and terminal cleanup evidence. Previous interrupted elapsed
  time must not be reused.
- [ ] GitHub App and publication acceptance: name the owner, exact disposable
  repository and approved permissions before registration, credential changes,
  token lifecycle tests, PR/merge or deploy-dispatch writes.
- [ ] Provider/editorial acceptance: select rights-cleared inputs and a human
  reviewer; validate original Turkish output and fact-preserving English
  localization, real provider failures and image provenance. No intentional quota
  exhaustion or paid fallback activation.
- [ ] Site/operations acceptance: identify the disposable static-site clone and
  incident owners; retain the local-only Blogbot architecture. Production,
  hosting, DNS and Search Console writes require separately scoped authority.
- [ ] Coordination evidence: identify the actual active board and usable writer
  before creating/attaching a task. No GitHub Projects target is assumed.
- [ ] Historical temporary material: review retention and revalidate exact owned
  targets before any separately authorized deletion. No broad cleanup.

Windows certificate procurement, signing and publisher-pin update activation
are explicitly deferred by the operator, not prerequisites to complete v0.1.55.

## Follow-up outcome and next verification need

This follow-up changes documentation only. It rechecks existing release metadata,
CI conclusions and local public-payload hashes; it does not claim a fresh run of
the test suite or a newly installed application. No production behavior changed.

The next meaningful runtime step is clean-machine manual installation acceptance.
An actual disposable Windows environment must be selected before starting it.
If that environment is unavailable, keep the gate unverified rather than
substituting another source build for installer acceptance.
