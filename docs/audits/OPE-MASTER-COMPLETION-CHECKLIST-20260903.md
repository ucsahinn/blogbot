# OPE master completion checklist — 2026-09-03

## Current scope decision — 2026-09-06

The operator selected unsigned/manual delivery, authorized commit and push of
the finalized source, and deferred signing and the remaining external acceptance
work. [ADR 0009](../adr/0009-unsigned-manual-delivery.md) is authoritative for this
delivery scope. The historical full-acceptance ledger below is preserved; its
open external gates do not block ordinary source completion and must not be
reported as passing tests. The interrupted 24-hour soak remains unaccepted.
No release, publish, deploy, version bump or installer regeneration is included.
Final source checks and handoff are recorded in
[the unsigned source handoff](unsigned-source-handoff-20260906.md).

## Historical full-acceptance ledger

Status: **IN PROGRESS — IR-08 queue settlement/ownership fixes have nine focused passing checks, independent source closure and a passing final Node matrix: 907 tests, 903 passed, four explicit live-provider skips, zero failures/cancellations. Rebuilt-engine/native, controller preflight, lint, typecheck and redacted secret scans also pass. Long-duration verification remains open. The first long run was intentionally stopped before changing its queue source and is not accepted. The unchanged Rust surfaces retain 255 passing tests. External acceptance and board attachment remain open; no bug-free or release-complete claim is made.**

This is the current completion ledger for the OPE 0.1.54 working tree. Older master indexes remain historical evidence for the source revision they name; their counts and release claims must not be reused for this working tree.

The two synthetic migration-crash verification tests now also pass within the
final 907-test matrix. The [bounded acceptance follow-up](independent-review-20260905.md#data-01-and-data-02-bounded-acceptance-follow-up)
records their execution, independent source review and remaining real-profile
boundaries, plus the documentation-only DATA-01 recovery-profile correction.

The earlier 2026-09-05 count of zero local open defects was not proof of completeness. The [independent review and regression report](independent-review-20260905.md) supersedes it for the changed surfaces and records confirmed findings, source fixes, focused execution, reviewer handoffs and missing runtime evidence. Completion is not claimed.

## Task contract

DATA-03 follow-up: the first synthetic-account-free local-engine run was
intentionally stopped before the IR-08 source correction. The second run was
interrupted by the Windows host restart at approximately `2026-09-05T19:33Z`;
its 964 healthy heartbeats are interim evidence, not 24-hour acceptance. No
terminal result or clean cleanup was observed, and its old fixture root is
preserved. The former 6 September 14:31 Turkey estimate is invalid.
A third, isolated run started with wrapper time `2026-09-05T19:44:13.6123312Z`
on the unchanged source. It was interrupted by another Windows host restart
on 6 September at approximately `18:03Z` and is not accepted. The real overdue backup
succeeded at `2026-09-05T19:49:17.728Z`; controlled recovery completed at
`2026-09-05T19:49:20.599Z`, followed by the continuous 24-hour phase. All three
synthetic jobs subsequently completed with one effect each and zero network
attempts. Its last journal entry was `2026-09-06T18:03:09.528Z`: 2,666 heartbeats,
80,028,921 ms of continuous observation, and no terminal result. The test session
and both owned processes were subsequently absent. Daily maintenance, clean
shutdown, cleanup and exit 0 are unverified. The former 6 September 22:50:21
Turkey estimate is invalid; no replacement run has been started.
No earlier elapsed time is reused. Evidence and the unchanged external boundaries
are in the [independent review report](independent-review-20260905.md#data-03-current-source-observation--third-run).

- **Goal:** prove the local Windows application works end to end, repair every repository-controlled defect found, and identify every remaining external acceptance action without presenting documentation as runtime proof.
- **Inputs:** the current working tree, product invariants, previous completion indexes, the 2026-09-03 security review and threat model, four specialist audits, and fresh command/browser/native evidence.
- **Hard boundaries:** no credential values in the repository or evidence; no GitHub/account/database/production writes; no commit, push, release, publish, deploy, certificate import, dependency install or upgrade without explicit approval; no weakening of a failing security contract.
- **Done when:** every repository-controlled gate is green; the signed release workflow is fail-closed; and every real-provider, clean-machine, long-running or production claim has direct acceptance evidence or is explicitly left as an external gate requiring operator authority.
- **Freedom:** implementation details, focused tests, local builds, disposable profiles, read-only audits and documentation updates may change as needed.

## Status legend

- `PASS_LOCAL`: implemented and verified in this working tree.
- `UNVERIFIED_EXTERNAL`: requires credentials, a clean/installed environment, elapsed real time or an external write. It is not a repository code defect.
- `DEFERRED_RELEASE`: release preparation is separate from ordinary local bug-fix completion; this is not a missing local implementation permission.
- `DEFERRED_HISTORICAL_CLEANUP`: old retained test/staging material is separate from the fresh test-owned cleanup already verified; exact targets must be revalidated before any deletion.
- `PENDING_BOARD_TARGET`: task creation was requested, but the actual board and a usable board writer are not identified.

## Earlier measured evidence (before the independent-review fixes)

This table is historical evidence, not a final-tree acceptance claim. In particular, its Node/Rust totals, release-script proof and executable hashes predate the changes documented in [the independent review](independent-review-20260905.md). The report's broad verification snapshot is the authoritative new-run record. Unchanged UI evidence is retained without claiming that newly compiled native code was exercised by an older binary.

| Surface | Current result | Evidence boundary |
| --- | --- | --- |
| ESLint | `PASS_LOCAL` | `npm.cmd run lint` |
| TypeScript | `PASS_LOCAL` | `npm.cmd run typecheck` |
| Production WebView assets | `PASS_LOCAL` | `npm.cmd run build` |
| Edge browser suite | `PASS_LOCAL` — 155/155 | Full `npm.cmd run test:browser` |
| Rust tests | `PASS_LOCAL` — 253/253 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` |
| Rust lint | `PASS_LOCAL` | Clippy, all targets, `-D warnings` |
| Rust format | `PASS_LOCAL` | `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all` normalized the six measured files; a fresh `--check` exits 0, 253 Rust tests pass and Clippy remains clean with `-D warnings`. |
| Test temporary-directory hygiene | `PASS_LOCAL` for the working system | RED: the five owner test files passed 131 tests but left exactly 23 new roots. GREEN: the same 131 tests passed with `NewCount=0`; the final 888-test suite did not create a later root. The engine-sidecar smoke now retries Windows `EBUSY` cleanup within a bounded window; its current authorized SEA residue was removed and the count is zero. Both latest successful native smokes removed their disposable profiles. A current fail-closed inventory found 37 non-reparse direct children: the 23 measured RED leftovers, two empty Codex timeout roots, five patch staging roots, one retained profile from an earlier failed native smoke, five subsequently retained historical failed/interrupted-test roots and the deliberate WiX work directory. Their historical cleanup remains a separate destructive operator action. |
| Engine executable build | `PASS_LOCAL` | Fresh engine/fetcher SEA and secure-restore release build from the post-fix tree. Current unsigned artifacts: engine 97,135,616 bytes (`D3B695B34678DB8F8C299F3D627C90CF3813C97C68AADC45FF495A7620051D43`), fetcher 95,761,408 bytes (`AD4153EB03D483DC7251B42C11E573AB0B8AA49ECC0F48406EEE2BA1AA3D97DA`), secure restore 192,000 bytes (`331A4611EFB2A74697B2DA253CDF876098883FB07CB2CF7BC06BB7B2199E89B7`). |
| Engine smoke | `PASS_LOCAL` | The freshly rebuilt executable returned `READY`, PGlite ready and durable queue ready; Windows cleanup retries `EBUSY` with a bounded `maxRetries`/`retryDelay`, the default startup budget remains fail-closed at 30 seconds, and the cleanup-specific integration test may inject at most 60 seconds under measured host contention. No `blogbot-sea-smoke-*` root remained. |
| Fetcher smoke | `PASS_LOCAL` | The freshly rebuilt executable rejected one invalid request exactly once at the child boundary; no `blogbot-fetcher-smoke-*` root remained. |
| Native Tauri/WebView smoke | `PASS_LOCAL` | Installer-free Tauri verification binary SHA-256 `44B231699BCC8D8E3DEC0F48C030CB8EAC7B3A533BC34AB3EE667EDF9D8FE9B3` (7,077,888 bytes); two consecutive fresh disposable profiles passed cold startup, app restart with durable-draft recovery, engine/read commands, editorial/settings/schedule/diagnostics/routes and 13 visible-action groups. Operations visible refresh reconciled to the authoritative native state before pause/resume; Edge and EdgeDriver both 152.0.4191.53. |
| Astro adapter dry-run contract | `PASS_LOCAL` | Disposable synthetic content-collection fixture; inspected config/schema paths were reported, before/after relative file paths and bytes were identical, both `writes` and `network` remained false, regular bounded reads passed, and hard-link/junction escapes were rejected by handle-relative no-follow reads |
| Publication materialization contract | `PASS_LOCAL` | TR/EN routes must resolve to the same declared section capability and each locale must use that capability's exact article type; REVISION.SAVE and materialization reject an explicitly blank adapter version; timestamps must be exact UTC ISO values; a hero without immutable engine-media metadata or legacy media bytes fails closed before materialization |
| Repository security scan | `PASS_LOCAL` | No forbidden secret files/patterns or renderer network calls |
| npm audit | `PASS_LOCAL` | Offline audit reports no vulnerabilities |
| Gitleaks | `PASS_LOCAL` | No leaks in the current worktree; values redacted |
| RustSec | `PASS_LOCAL` for vulnerabilities | Fresh offline scan loaded 1,239 cached advisories and found no vulnerability; 17 allowed warnings remain: GTK/glib/proc-macro entries are absent from the Windows target graph, while UNIC maintenance entries remain through Tauri's `urlpattern` chain. |
| Context budget | `PASS_LOCAL` | 6,938 estimated tokens across the configured primary files |
| Full Node suite | `PASS_LOCAL` — 888 total, 884 passed, 4 explicit live-provider skips, 0 failed/cancelled | Fresh post-fix `test:all` runs the unit, desktop/Codex-runner app and integration groups sequentially, retaining concurrency within each group while preventing cross-group child-process/PGlite contention; lint, typecheck and the frontend build pass, with the build rerun outside the managed sandbox because Vite/esbuild's config discovery reads parent directories. Earlier current-tree engine builds, both sidecar smokes, security verification, 253 Rust tests, Clippy, the 155-test zero-retry Edge suite and two consecutive complete native WebView matrices remain green. |
| Real Codex routes | `PASS_LOCAL` | Logged-in Codex CLI 0.152.1, bare `codex.cmd` PATH discovery, isolated read-only runner, tools/MCP/web disabled, a complete schema/length-valid bilingual draft, an ephemeral Luna/Boby response, an isolated empty-home `AUTH_REQUIRED` result, and enforcement of the real Luna process deadline; generated prose and guidance were not logged |
| Release workflow contract | `PASS_LOCAL` | 45/45 packaging/readiness tests, full tag checkout and existing-version rejection before tool setup/build, six Authenticode executable targets plus three packaged native modules, four-job PyYAML parse, eleven embedded PowerShell blocks parsed locally, twelve action references pinned to full commit SHAs (including Gitleaks pinned to the v2.3.9 commit rather than the v2 tag or its annotated tag-object SHA), Windows PowerShell 5.1 fail-closed execution, and `git diff --check` |
| Release identity and artifacts | `NOT_AUTHORIZED` | `HEAD` remains the existing `v0.1.54` commit and the working tree metadata still says `0.1.54`. A five-metadata `0.1.55` plus `docs/releases/OPE-0.1.55.md` patch was prepared and passed `git apply --check`, but was not applied because exact release/version authority remains pending. Existing local executables are not signed and no installer bundle was produced. |

The native smoke passed after its embedded review-heading selector was updated to the current semantic hierarchy, the candidate bulk-action race waited for the busy state to clear, and route checks reported their actual timeout. Microsoft Edge and Microsoft EdgeDriver were aligned to 152.0.4191.53 and the complete native acceptance matrix passed without the former driver-compatibility warning. On 2026-09-04 repeated clean-profile runs exposed three independent races: overlapping sync events could apply an older response, explicit Operations refresh could reuse a completed or in-flight cached snapshot, and a restarted app could retain a transient offline projection after the prior sidecar released PGlite. Sync events now use the raw bridge plus a latest-request sequence; explicit refresh uses per-snapshot fresh generations that invalidate stale in-flight reads; and startup preserves Doctor→workspace ordering while making at most eight fresh background recovery probes. The application's fail-closed bootstrap timeout is 35 seconds, beyond the native engine's 30-second cold-start contract, while the harness allows 40 seconds to observe either a rendered workspace or its safe terminal error. The harness also retries WebView2 profile cleanup for a bounded 15 seconds, inspects the actual fatal detail element, and preserves `BOOTSTRAP_TIMEOUT` as a redacted actionable code. `tauri build --no-bundle` embedded the current frontend without producing an installer. The measured binary above passed the complete disposable-profile matrix twice consecutively, and all 155 zero-retry Edge tests passed on the same final tree.

## Coordination workflow status

- [x] `PASS_LOCAL`: the explicitly requested independent read-only security, GitHub and backup/runner reviews completed, including follow-up review of the local fixes. Returned evidence is retained in [independent-review-20260905.md](independent-review-20260905.md). The user asking to create a board task was sufficient to authorize coordination; requiring an existing board item before reviews was an incorrect interpretation.
- [ ] `PENDING_BOARD_TARGET`: identify the user's active board and attach the task/evidence there. The catalog exposes no board/task writer and the user has been asked for the application/board name or link. GitHub Projects must not be assumed. No board item or permission change has been made.

## Repository-controlled work ledger

### Completed in the working system

- [x] Fetcher response/exit races cannot replay an ambiguously dispatched HTTP request; only a pre-request DNS resolution may retry within its original deadline.
- [x] ImageGen response reads enforce both declared and streaming byte limits before JSON parsing.
- [x] Public site state accepts only a canonical HTTPS origin with no credentials, path, query or fragment; legacy state is canonicalized or rejected.
- [x] New logical and portable backups use archive version 2 and the exact stronger scrypt policy; downgrade parameters are rejected.
- [x] Version 1 backup archives remain readable with their historical KDF and password-normalization behavior.
- [x] The desktop can generate a non-persisted 192-bit recovery key and clears the key after create, verify, preview and restore operations.
- [x] The updater rejects a missing/malformed compile-time publisher pin, requires Windows `Valid` Authenticode status and a time-stamper certificate, and matches the signer certificate SHA-256.
- [x] The deferred updater repeats digest/signature/timestamp/publisher checks under a file-sharing lock immediately before process creation.
- [x] Update-search copy no longer claims that installer publisher identity was already checked; it explains that identity is verified before installation.
- [x] Offline and degraded UI states do not present configured automation as an operational success.
- [x] Boby closes with Escape and returns keyboard focus to its opener.
- [x] Embedded review pages expose one page heading and ordered section/article headings.
- [x] Desktop and mobile navigation retain bounded scroll, safe bottom spacing, short-viewport reachability and reduced-motion behavior.
- [x] Native smoke selectors follow the same semantic heading contract as the browser UI.
- [x] Codex CLI capability probing uses a fixed 10-second startup budget instead of inheriting shorter task deadlines, preventing false `UNSUPPORTED_CLI` results under parallel load.
- [x] A bare Windows `codex.cmd` command is resolved through PATH to its npm Codex entry, avoiding `cmd.exe` re-parsing that corrupted fail-closed configuration arguments.
- [x] Codex CLI failure classification uses bounded authentication terms, so an unrelated `author` validation error remains `PROCESS_FAILED` while a real 401 still becomes `AUTH_REQUIRED`; both paths run through the real process fixture.
- [x] Native publication retry deadlines use the same injected clock as pending/claim/lease evaluation; a deterministic PGlite regression advances the clock exactly 50 ms instead of racing wall time under the parallel suite.
- [x] The Windows command-wrapper timeout regression starts its caller-release watchdog only after the real task process spawns, so the separate bounded capability-probe phase cannot consume the task deadline; the whole test remains fail-closed under a 30-second harness bound.
- [x] Timed-out Codex runs report the bounded timeout immediately but sequence app-owned `task-*` cleanup after their exact Windows process-tree termination; a real lingering-child fixture proves the task directory disappears, while test-root cleanup tolerates only bounded transient Windows handle release.
- [x] Draft prompts make local word floors authoritative over shorter caller wording, use separate Turkish/English early schema lengths, and still reject under-length bodies through the local semantic validator.
- [x] Provider wait projections preserve their typed safe action: authentication opens Codex setup, rate/usage waits expose a durable manual retry, and disabled paid fallback exposes no misleading retry or connection action.
- [x] The generic Astro adapter binds Turkish and English routes to one declared section capability and rejects an article type that does not match that capability.
- [x] Astro frontmatter accepts only exact UTC ISO timestamps and rejects environment-dependent date strings.
- [x] Publication materialization rejects a referenced hero when neither immutable engine-media metadata nor legacy media bytes are available, preventing a frontmatter-only dangling media path.
- [x] Revision input rejects a blank or whitespace-only adapter version, and publication materialization independently refuses an approval that does not pin a usable adapter version.
- [x] Native WebView acceptance waits for bulk-action settlement and uses route-only operations navigation, avoiding fixture and bootstrap races without weakening product checks.
- [x] Native Operations acceptance refreshes the visible projection before pause/resume, bootstrap timeout errors remain actionable instead of becoming `UNCLASSIFIED_FATAL_STARTUP`, and disposable WebView2 cleanup has a bounded 15-second lock-release window.
- [x] Engine-sidecar smoke preserves the 30-second production verification budget, permits only a bounded 1–120 second test override, and retries Windows-owned temporary-directory cleanup so a successful doctor run cannot fail or leak solely on a transient `EBUSY` lock.
- [x] The GitHub release workflow keeps default permissions read-only, rejects non-`main` dispatches, checkout-SHA mismatches and an already-existing version tag before tool setup or repository code runs, runs a pinned secret scan, imports the PFX temporarily from a protected environment, signs packaged Sharp DLL/`.node` runtime modules and builds the application, sidecars and installers with SHA-256 plus RFC 3161 signing, verifies publisher pins and timestamps, binds a pre-import certificate-store baseline to a SHA-256 step output and cleans credentials fail-closed, and grants `contents: write` only to the separate default-skipped publication job.
- [x] After signing-credential cleanup, a pinned no-upload SBOM action emits SPDX 2.3; a separate least-privilege job revalidates the payload and creates provenance plus SBOM attestations before publication can start.
- [x] The desktop no longer requests the classic OAuth `repo` scope; it accepts only expiring GitHub App device-flow grants and exact single-repository installation permissions.
- [x] A newly issued GitHub device-flow grant remains only in process memory until repository validation succeeds; transient validation or token-endpoint failures retry without polling the one-use device code twice, preserve the grant's original absolute expiry, and clear/latch fail-closed on permanent failures in both Rust and TypeScript paths.
- [x] Concurrent TypeScript device-flow `poll()` calls share one in-flight token exchange. The RED test observed two exchanges for one device code; the GREEN implementation returns the same authorized result to both callers while the endpoint is invoked once.
- [x] The TypeScript GitHub request deadline covers both response headers and response-body JSON parsing. The RED test left a stalled body pending after the declared 15-second deadline; the GREEN transport shares one abort/deadline across `fetch()` and `response.json()` and rejects the stalled read as a transient request failure.
- [x] A transient GitHub 408/425/429/5xx response with an empty or non-JSON error body retains its HTTP classification instead of escaping as a parser error. The RED test showed a 503 body `SyntaxError` bypassing the retry policy; the GREEN transport preserves stored credentials and reports a transient outage, while malformed JSON on a successful response still fails closed.
- [x] TypeScript GitHub publication effects apply one 15-second deadline across both the remote fetch and response-body parse, pass an abort signal to the transport, preserve non-JSON error status responses, and keep malformed successful responses fail-closed. The RED test left the durable effect pending after the declared deadline; the GREEN transport rejected it deterministically so the outbox can apply its bounded retry policy.
- [x] GitHub App access/refresh credentials are stored as one versioned DPAPI bundle, remotely revalidated against the configured repository and exact permissions before every fresh-token use, and latched fail-closed when authentication or authorization changes. The native and TypeScript paths follow [GitHub's one-use refresh contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens): after a successful exchange they persist the replacement pair before repository revalidation, retain it across transient 408/425/429/5xx or transport failures, and never retry the consumed refresh token. Permanent validation failures remain fail-closed; OAuth requests are form-encoded, require no client secret, and timeout cancellation aborts the underlying HTTP request.
- [x] Native GitHub repository validation classifies the documented 301 moved and 404 missing/inaccessible repository results as a permanent repository-access loss, including an empty error body, so stored credentials cannot remain in a transient retry loop.
- [x] Both TypeScript GitHub transports require manual redirect handling. GitHub App validation and publication effects therefore fail closed on a repository rename or any other 3xx response instead of allowing the runtime's default `fetch` policy to replay identity-bearing reads or writes against a redirected target.
- [x] One shared GitHub repository-name contract accepts legal dot-prefixed repository names such as `.github`, rejects exact `.`/`..`, traversal, extra path segments and owner names beginning with `.`, `_` or `-` before URL construction, and is enforced by the wizard, generic publisher configuration, native secure store/broker/desktop commands, device-flow HTTP and publication-effect layers.
- [x] The native publication reconciler no longer carries a weaker duplicate repository validator. Its RED direct-layer test accepted forbidden dot segments despite the broker guard; the GREEN implementation delegates to the shared secure-store contract, accepts `owner/.github`, rejects dot/traversal/extra segments and passes all 253 Rust tests plus Clippy.
- [x] One shared GitHub base-branch contract is enforced by generic connector setup, TypeScript publication effects, the native base-SHA capture command, the native broker and the native publication reconciler. RED tests proved that these layers inconsistently accepted leading/trailing or repeated slash, `..`, colon, leading dash, dot-prefixed path segments, `.lock` segments, trailing dot or overlong names even though Git rejects them; GREEN tests accept `release/v1.2.3`, reject the unsafe set before approval or remote effects, and pass the 888-test Node and 253-test Rust matrices.
- [x] One shared GitHub workflow-filename contract is enforced by connector setup, approval-bound V3 revisions, Codex publication-policy materialization, engine stdio commands, TypeScript publication effects and the native command, broker and reconciler layers. RED tests proved that the duplicated validators inconsistently accepted overlong names, `a..yml`, `.yml` or a non-YAML suffix; GREEN permits only a filename of at most 100 ASCII letters, digits, dots, underscores or hyphens, ending in `.yml` or `.yaml`, with a non-empty stem and no `..`, before approval or remote effects.
- [x] The Windows PowerShell 5.1 release-payload verifier follows the same repository-name contract: real subprocess tests accept `.github`/`.github-private`, reject exact `.`/`..`, and reach the expected file-set gate without exposing environment values.
- [x] Media-preview selection and bounded concurrent reads live in a side-effect-free TypeScript module consumed by the React review screen and direct Node tests; the tests no longer package the entire 77 KB TSX screen at runtime or depend on esbuild traversing outside the desktop workspace.
- [x] Desktop snapshot coalescing supports an explicit per-snapshot fresh generation: it bypasses completed/in-flight cache entries without invalidating unrelated screens, prevents an older response from repopulating stale state, and is used by Operations refresh. Native sync events use the raw runtime bridge plus a latest-request sequence, and bounded cold-start reconciliation repeatedly re-runs Doctor before workspace until the engine becomes online or eight attempts are exhausted.
- [x] Architecture, cryptography and threat-model decisions are recorded in ADR 0006, ADR 0007, ADR 0008 and the 2026-09-03 security documents.

### Queue follow-up locally verified

- [x] IR-08: queue settlement/claim-token correction has independent source closure, nine focused checks and the final 907-test matrix (903 passes, four explicit live-provider skips, zero failures/cancellations). The test-only after-read case closes the reviewer's nonblocking coverage gap without changing the production source or live soak identity. Rebuilt engine/fetcher smokes, 17 desktop preflight checks, native WebView's 10 read contracts/11 routes/13 action groups, five controller/preflight checks, lint, typecheck and redacted scans pass. The initial matrix's test-budget cancellation and sandbox-denied build attempt remain historical failed evidence. The separate 24-hour gate remains open; local closure is not endurance or external-effect certification.

### Release workflow implemented locally

- [x] A manual dispatch must target `refs/heads/main`, the checked-out commit must equal `github.sha`, the checkout must include complete tag history, and the requested version tag must not already exist before setup or repository code runs.
- [x] The PFX and password are referenced only as protected environment secrets; no secret value was requested or written.
- [x] Signing inputs are validated before import, the PFX is imported non-exportably into the temporary runner user's certificate store, and the temporary PFX file is removed and verified absent immediately after import.
- [x] The application, all three Tauri-signed engine/fetcher/secure-restore sidecars, explicitly signed packaged Sharp DLL/`.node` runtime modules, NSIS and MSI must all have a `Valid` Authenticode signature, a time-stamper, the expected SHA-1 certificate-store thumbprint and the expected raw-certificate SHA-256 pin.
- [x] Cleanup runs with `always()`, loads and SHA-256 verifies the durable pre-import certificate-store baseline, rediscovers and removes every certificate added by the job together with its associated private-key container and both temporary credential paths, verifies that no tracked credential remains, and blocks upload if cleanup is incomplete.
- [x] The pinned SBOM generator runs only after credential cleanup, writes SPDX 2.3 into the exact five-file payload, and has all optional GitHub-side writes disabled.
- [x] The attestation job has only `contents: read`, `id-token: write` and `attestations: write`, receives no PFX/password, revalidates the payload, and binds both provenance and SBOM attestations to the expected subjects.
- [x] The publication job downloads only the attested five-file payload, rechecks its exact file set, signatures, publisher pins, updater manifest and SBOM, and alone receives `contents: write`; it remains skipped unless the dispatch explicitly sets the default-false `publish_release` input.
- [x] A disposable synthetic Astro content-collection dry-run reports every inspected config/schema path, preserves all relative file paths and bytes, declares both writes and network disabled, and rejects hard-link/junction descendants that would escape the selected root.
- [x] The full Node suite, lint, typecheck, frontend build, engine build/smokes, browser suite, Rust tests/lint, security verification, native WebView smoke and `git diff --check` pass after the edit.
- [x] `PASS_LOCAL`: normalized all 82 previously measured rustfmt hunks in `blogbot-secure-restore.rs`, `commands.rs`, `engine_bridge.rs`, `github_broker.rs`, `secure_store.rs` and `tray.rs`; `cargo fmt --check`, 253 Rust tests and all-target Clippy with `-D warnings` pass.
- [x] `PASS_LOCAL`: added reusable, owner-scoped close-then-remove cleanup to `pipeline-codex.test.ts`, `local-queue-pglite.test.ts`, `local-engine-pglite.test.ts`, `local-persistence.test.ts` and `engine-stdio.test.ts`. The RED run left exactly 23 new roots; the same 131-test GREEN run left zero new roots, and the final 888-test suite did not recreate that signature.
- [x] `PASS_LOCAL`: the ambiguous HTTP-dispatch test harness now allows both of its sequential `5 s + 1 s` bounded request windows plus close cleanup. Under the full parallel suite the former 10-second harness limit cancelled the otherwise-correct test at 10.008 seconds; the focused test passed in under one second and the repeated 880-test monolithic matrix plus the final 888-test official matrix passed with no failures or cancellations after the harness bound was corrected, without changing the production fetch deadline.
- [x] `PASS_LOCAL`: the official Node matrix runs unit, desktop/Codex-runner app and integration groups sequentially while retaining each group's native concurrency. The RED monolithic run intermittently exceeded narrow child-process deadlines in otherwise-green pipeline and packaging tests under aggregate PGlite/PowerShell/Node contention; both focused files and the integration group passed independently, and the GREEN `npm.cmd run test:all` completed all 888 tests with 884 passes, four explicit live-provider skips and zero failures/cancellations without weakening production deadlines.
- [x] `PASS_LOCAL`: native WebView smoke finalization now gives its best-effort WebDriver session DELETE the same bounded request timeout as every other harness call. The RED source contract found an unbounded cleanup fetch; the GREEN 45-test packaging/readiness suite and `node --check` prove the finalizer cannot wait forever on a wedged local driver.
- [ ] `DEFERRED_HISTORICAL_CLEANUP`: review the retained historical RED-test, empty timeout, patch-staging and interrupted native-test roots for intentional retention versus deletion. They are not failures of the newly verified cleanup. Before deletion, every exact target must again be a non-reparse direct child of system temp and match the closed allowlist; keep `blogbot-wix-temp` and do not discard the only copy of a retained deliverable.

No workflow run, certificate import, installer build, release or publication was performed in GitHub or production.

### Release identity deferred to release work

- [ ] `DEFERRED_RELEASE`: when release preparation is explicitly started, revalidate and promote the prepared next SemVer `0.1.55` across `apps/desktop/package.json`, `package-lock.json`, Tauri configuration, `Cargo.toml` and `Cargo.lock`, with exact `docs/releases/OPE-0.1.55.md` notes. This version-only work is not a blocker for ordinary local fixes and does not authorize an installer, tag, push or publication.

## External acceptance ledger

These items cannot be made true by editing source code alone.
The locally prepared [`external-acceptance-runbook.md`](../operations/external-acceptance-runbook.md)
maps all 20 entries below to a gate identifier, prerequisites, execution steps,
fail-closed criteria and secret-safe independent evidence. Its status is
**procedure prepared, execution unverified**; it does not close any item below.

### Windows signing and distribution

- [ ] `UNVERIFIED_EXTERNAL`: select a trusted Windows code-signing certificate and name the human owner of its custody/rotation/revocation process.

  Confirm whether the approved distribution trust model lawfully supports the checked-in PFX lane. Publicly trusted certificates issued under the current CA/Browser Forum baseline keep private keys in an approved hardware/cloud crypto module or signing service; if the provider does not permit a policy-compliant PFX export, authorize a separately reviewed provider integration instead of exporting the key.
- [ ] `UNVERIFIED_EXTERNAL`: create/protect the GitHub environment `windows-signing` and configure the following names without exposing their values in chat, logs or repository files:

  | Scope | Name | Purpose |
  | --- | --- | --- |
  | Environment secret | `OPE_WINDOWS_CERTIFICATE_PFX_BASE64` | Base64-encoded code-signing PFX, imported temporarily by the build job |
  | Environment secret | `OPE_WINDOWS_CERTIFICATE_PASSWORD` | Password used only for the temporary PFX import |
  | Repository variable | `OPE_WINDOWS_CERTIFICATE_THUMBPRINT` | Public 40-hex certificate-store SHA-1 thumbprint |
  | Repository variable | `OPE_WINDOWS_TIMESTAMP_URL` | Approved absolute RFC 3161 timestamp service URL |
  | Repository variable | `OPE_UPDATE_SIGNER_SHA256` | Public 64-hex SHA-256 fingerprint of the signer certificate raw bytes |

  The public pins are repository variables because the isolated publication job must revalidate the payload without receiving either certificate secret. Missing or mismatched inputs fail closed.
- [ ] `UNVERIFIED_EXTERNAL`: run the workflow on a non-production release candidate and retain Authenticode evidence for the app, engine/fetcher/secure-restore sidecars, packaged Sharp DLL/`.node` runtime modules, NSIS and MSI.
- [ ] `UNVERIFIED_EXTERNAL`: run the checked-in workflow so it generates the real SPDX SBOM and GitHub provenance/SBOM attestations, then independently verify that every attested subject matches the exact signed payload.
- [ ] `UNVERIFIED_EXTERNAL`: install on clean Windows 10 and Windows 11, then exercise N-1 upgrade, tampered download, interrupted update, failed installer and rollback while proving local data remains readable.
- [x] `PASS_LOCAL`: align Microsoft EdgeDriver with installed Edge 152.0.4191.53 and repeat the complete native acceptance matrix without the compatibility warning.

### GitHub authorization and publication

Read-only control-plane observation reverified on 2026-09-04: the repository is public, `main` is not protected, there are zero GitHub environments, and the required signing repository variables are absent. The latest remote workflow runs target the existing `v0.1.54` commit rather than the dirty local working tree, so they do not verify these local changes. No external setting was changed.

- [x] `PASS_LOCAL`: complete a source-traceable official-docs decision review. It recommends a repository-selected GitHub App user access token through device flow, with expiring-token refresh and only Metadata read, Contents write, Pull requests write, Checks read, Actions write and Administration read.
- [x] `PASS_LOCAL`: implement the decision in Rust, TypeScript and the desktop UI with exact permission/repository validation, expiring-token refresh, legacy-token rejection and repository-bound publication readiness.
- [ ] `UNVERIFIED_EXTERNAL`: verify that the approved GitHub App registration and installation exactly match the locally enforced permission and one-repository policy.
- [ ] `UNVERIFIED_EXTERNAL`: name the GitHub App owner, register the app, enable device flow and token expiration, and install it only on the selected disposable/production repository as separately approved.
- [ ] `UNVERIFIED_EXTERNAL`: configure the selected repository, branch protection and exact required-check names.
- [ ] `UNVERIFIED_EXTERNAL`: exercise device authorization, token expiry and revocation with the native DPAPI-backed store.
- [ ] `UNVERIFIED_EXTERNAL`: rehearse preview → approved immutable revision → PR → checks → merge → ref cleanup → deploy dispatch in an isolated test repository. Production publication still requires separate approval.

### Providers and editorial quality

- [x] `PASS_LOCAL`: confirm the installed Codex CLI is logged in, complete one real bilingual draft through the production isolated runner, complete one real ephemeral Luna/Boby guidance turn using the bare Windows command path, classify a real isolated empty-home 401 as `AUTH_REQUIRED`, and enforce the real Luna process deadline.
- [x] `PASS_LOCAL`: map JSONL 401, 429 and quota error messages to the typed waiting contract while preserving unrelated provider errors as terminal `PROCESS_FAILED` results.
- [x] `PASS_LOCAL`: verify the user-visible durable retry contract across the native projection, real Edge UI and engine coordinator: `AUTH_REQUIRED` opens setup, `RATE_LIMIT`/`USAGE_LIMIT` can requeue once idempotently, and `PAID_FALLBACK_DISABLED` remains fail-closed without an action.
- [ ] `UNVERIFIED_EXTERNAL`: exercise an actual provider quota/rate-limit response without intentionally changing or exhausting the authenticated account.
- [ ] `UNVERIFIED_EXTERNAL`: calibrate Turkish article, claim, contradiction, SEO and fact-preserving English-localization quality on a representative, rights-cleared news corpus with human review evidence.
- [ ] `UNVERIFIED_EXTERNAL`: exercise real ImageGen success, oversized/failing responses, provenance binding and truthful local fallback. Paid fallback must remain disabled unless separately enabled.

### Data durability and long-running behavior

- [ ] `UNVERIFIED_EXTERNAL`: create, verify, preview and restore a real user archive into a separate disposable application/data directory under the same Windows user profile, preserving the existing DPAPI-bound data-key access required by ADR 0003; compare expected rows/media and prove the original workspace was not replaced. Cross-profile or cross-machine recovery is not claimed.
- [ ] `UNVERIFIED_EXTERNAL`: rehearse a legacy profile/database upgrade and an interrupted migration on a disposable copy.
- [ ] `UNVERIFIED_EXTERNAL`: observe a continuous 24-hour scheduler window, overdue catch-up, daily backup, retention, restart and duplicate-effect behavior.
- [ ] `UNVERIFIED_EXTERNAL`: exercise installed tray, notification, autostart, app-exit and owned-child cleanup behavior.

### Static site and operations

- [ ] `UNVERIFIED_EXTERNAL`: run the chosen site adapter against a disposable clone and verify route/media/locale output without production publication.
- [ ] `UNVERIFIED_EXTERNAL`: verify DNS, public URL, hosting health, deployment checks and Search Console only after each external write is separately approved.
- [x] `PASS_LOCAL`: define the fail-closed incident path, publisher-certificate rotation/compromise response, static-site and local-data rollback boundaries, support-package handling, release stop conditions and sign-off evidence contract in [`release-incident-runbook.md`](../operations/release-incident-runbook.md).
- [ ] `UNVERIFIED_EXTERNAL`: assign distinct named primary/backup owners in the release incident runbook, prove the approved contact path, and complete the required certificate, GitHub App, static-site rollback, support-package and release sign-off drills.

## Operator decisions still required

1. For the separate release phase, is the prepared next numeric SemVer `0.1.55` the intended release, and who approves its exact notes and the five metadata locations?
2. Is the target public-trust or private-enterprise distribution, which certificate/signing provider and HSM/cloud/PFX custody model will be used, does that provider permit a policy-compliant exportable PFX, and who owns rotation/revocation?
3. Who may configure the protected `windows-signing` environment and the exact secrets/variables listed above?
4. May a non-production `workflow_dispatch` signing/attestation run be performed with `publish_release=false`, and who may separately authorize a later run with `publish_release=true`?
5. Who will own and register the repository-selected GitHub App, enable device flow/token expiration, and approve its exact repository permissions?
6. Which disposable GitHub repository, static-site clone and Windows 10/11 VMs are authorized for non-production acceptance?
7. Are real Codex/ImageGen account checks authorized, and is paid ImageGen fallback still required to remain disabled?
8. Who owns the 24-hour observation window, and who will fill the six primary/backup ownership rows in [`release-incident-runbook.md`](../operations/release-incident-runbook.md) and approve their first drills?
9. Which application/board is the active coordination board? The requested independent reviews are complete; their report can be attached when the actual target and a usable board capability are identified. No GitHub Projects scope refresh is assumed necessary.

## Unchanged boundaries

- Blogbot remains a local-only Windows application; Hetzner serves only the public static site.
- PGlite, the local engine and durable queue remain authoritative.
- Every publication remains bound to the exact immutable revision and explicit human approval.
- Credentials remain separated and no desktop Hetzner deploy key is introduced.
- This checklist does not authorize commit, push, release, publish or deploy.

## Next verification need

The next release proof first requires explicit authority to choose and synchronize a new version and its exact notes. An authorized operator must then configure the protected environment and public pins and separately authorize a non-production workflow run. Only that run can prove temporary certificate import, real SHA-256/RFC 3161 signing, fail-closed cleanup, real SPDX generation, provenance/SBOM attestation and cross-job artifact verification on GitHub-hosted Windows runners. Signed artifact, attestation and clean-machine claims remain external until that evidence exists.
