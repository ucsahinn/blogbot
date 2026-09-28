# OPE v0.1.56 unsigned release closure

Recorded: 2026-09-29. Status: **PUBLISHED; listed acceptance gates remain open.**
Task board: [delivery-plan-20260928.md](delivery-plan-20260928.md).

## Published delivery

- [OPE v0.1.56](https://github.com/ucsahinn/blogbot/releases/tag/v0.1.56),
  published `2026-09-28T20:22:17Z`, not a draft.
- Source commit: `f92cc8c55a103fe7c62945abba0c750e6281329c`.
- [Verify CI run 36470168204](https://github.com/ucsahinn/blogbot/actions/runs/36470168204):
  node, browser, native and Windows release-script jobs succeeded.
- [Release run 36475756901](https://github.com/ucsahinn/blogbot/actions/runs/36475756901):
  secret scan, unsigned build, attestation and publish jobs succeeded.
- Unsigned manual delivery per [ADR 0009](../adr/0009-unsigned-manual-delivery.md).
  In-app update installation stays fail-closed without a publisher pin.

## Independent verification of the published assets

Downloaded on 2026-09-29 and hashed locally; every value equals the digest
GitHub reports for the asset.

| File | Bytes | SHA-256 | Authenticode |
| --- | ---: | --- | --- |
| `latest.json` | 929 | `681665a68f50ab1efba5bab936cee10ffb9ccdaeda20b13f5303fe4c90784a4e` | n/a |
| `ope-sbom.spdx.json` | 1988259 | `f6c1abdccb0a29c3f5b867f551842d8bc6d4977b22db9a3868c4a9df84486659` | n/a |
| `OPE_0.1.56_x64-setup.exe` | 62276387 | `79981d1ba4773a5222a3704569c57130bf1ffe0b05e1dfb987a9715d39048ba4` | NotSigned |
| `OPE_0.1.56_x64_en-US.msi` | 89917407 | `761065b050d887757c4f73e503f359ce8432daa9550e11e8f9057fa4f217683b` | NotSigned |

- `gh attestation verify` succeeded for the NSIS and MSI installers (SLSA
  provenance v1 from this repository's `main` workflow) and for the NSIS SBOM
  attestation (SPDX 2.3). GitHub build provenance is not Windows publisher
  authentication.
- `latest.json` names version `0.1.56`, carries the release notes and the
  installer SHA-256 above.
- The five-file payload verifier ran inside the release workflow before
  publication; it needs the unpublished `blogbot.exe`, so it was not rerun on
  the four downloaded assets.

## Local evidence before release

Kept under `build/verification/0.1.56/` (excluded from Git). Phase summaries:
baseline, fixes with red and green logs, visual QA and native screenshots, live
provider evidence and local installer builds.

## Open acceptance, not passed

- Live Codex draft and Boby turn: the real account returned `USAGE_LIMIT`; rerun
  after the quota resets. The typed waiting projection of that real signal was
  verified.
- GitHub App registration and the disposable-repository publication rehearsal
  (`GH-01`–`GH-05`): the fixture repository is ready; the App is not registered.
- Out of scope by operator decision: signing, clean Windows VMs, 24-hour soak,
  installed lifecycle matrix, real archive restore, real site and provider
  quality gates, incident drills.
- Installing 0.1.56 over the local 0.1.55 installation awaits separate approval.
