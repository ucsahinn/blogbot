# Unsigned source handoff — 2026-09-06

Status: PASS_LOCAL for the current source handoff. External acceptance is
deferred by the operator, not passed. This is not an installer or release report.

## Task contract

- Goal: finalize the reviewed local fixes with unsigned/manual delivery as the
  default, verify the resulting source, then commit and push to the existing
  repository's main branch.
- Inputs: the existing working tree and regression evidence, plus the operator's
  explicit 6 September unsigned-delivery and commit/push instruction.
- Hard boundaries: no certificate or credential changes, secret values,
  dependency changes, production data writes, version bump, package regeneration,
  tag, release, publication or deployment. Preserve ignored local data and logs.
- Done when: relevant local checks pass, the staged source is reviewed and
  secret-scanned, and the ordinary non-force push is verified against the remote.
- Freedom: bounded local source/test/documentation changes and read-only review.

## Changed scope

[ADR 0009](../adr/0009-unsigned-manual-delivery.md) makes the manual workflow
unsigned by default without using Windows certificate secrets. Signing remains
an explicit future opt-in. Payload file-set, manifest, URL, SHA-256 and SBOM
checks remain active. The native updater still rejects an unconfigured signer;
manual installation is the only supported installation path for this lane.

The existing local fixes for queue ownership/retry, GitHub authorization and
publication, backup compatibility, runner validation, native state recovery,
review media and test-owned resource cleanup are included with their regression
tests. Their detailed evidence remains in the
[independent review](independent-review-20260905.md).

## Fresh verification

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Focused release-script and packaging tests | 48 passed, no failures/skips | Real PowerShell verifier with synthetic unsigned files; original signed-lane fixtures retained |
| Full Node matrix | 908 tests: 904 passed, 4 explicit live-provider skips, no failures/cancellations | Unit 487/487; app 171/171; integration 246/250 with four skips |
| ESLint and TypeScript | Exit 0 | Final source/test tree |
| Production frontend build | Exit 0 | Same reviewed build retried outside sandbox after its parent-directory read restriction; no dependency install |
| Repository security scan and redacted Gitleaks scan | Exit 0, no findings | Source scan, not a claim about external credential stores |
| Embedded workflow PowerShell parsing | 10 blocks parsed | GitHub expressions replaced with inert placeholders; not hosted workflow execution |
| Token audit | Exit 0 | Repository's context-size diagnostic |
| Independent precommit review | No additional confirmed blocker | Read-only selective review of high-risk apps/packages diffs; not exhaustive certification |

Local raw command logs are retained under `build/verification/unsigned-final-*`
and excluded from Git. Earlier unchanged Rust, browser and native/sidecar evidence
is retained in the independent review; it is not described as rerun today.

The new unsigned fixture first failed because certificate configuration was
required, then passed after the explicit verifier mode was implemented. It also
rejects altered installer bytes, extra payload files and an invalid mode. The
signed verifier still requires certificate configuration. Existing workflow text
contracts were updated to account for conditional signing and literal unsigned
release-note text; no native trust check was removed.

## Deferred, not completed

- The interrupted 24-hour run has no accepted terminal result. No replacement
  long run is started for this handoff, and no elapsed time is reused.
- Real GitHub/provider publication and quota tests, the chosen site clone,
  clean Windows installation/upgrade, real legacy/profile restoration, human
  content acceptance and coordination-board attachment remain deferred.
- Windows certificate procurement/signing and in-app update installation are
  outside this unsigned delivery contract.
- Historical temporary data is preserved. No broad cleanup is authorized here.
- GitHub-hosted CI is separate evidence from these local passes. A source push
  alone does not prove hosted checks passed, and does not run the manual release
  workflow. Commit/push identity is recorded by Git, not asserted in advance here.

## Next verification need

When the operator resumes external acceptance, choose the specific environment
and authorize the exact action from the
[external acceptance runbook](../operations/external-acceptance-runbook.md).
For a future unsigned installer, verify installation on a disposable Windows
environment. Do not require a signing certificate merely to close this source
handoff, and do not claim publisher authentication for an unsigned file.
