# Independent local review and regression evidence — 2026-09-05

Scope update on 2026-09-06: the operator selected unsigned/manual delivery and
deferred external acceptance. See the [current source handoff](unsigned-source-handoff-20260906.md)
and [ADR 0009](../adr/0009-unsigned-manual-delivery.md). The historical findings
and interrupted-run evidence below remain unchanged; they are not release proof.

Status: IN PROGRESS — IR-01 through IR-07 retain their earlier local evidence.
IR-08 queue settlement/ownership corrections now have nine focused passing checks,
independent source closure and a passing 907-test broad matrix (903 passes,
four explicit live-provider skips, zero failures/cancellations).
Rebuilt-engine/native, controller preflight,
lint, typecheck and redacted secret scans pass. Long-duration verification and
the separately named external acceptance gates remain open.
This report does not claim a bug-free application or a completed release.

## Task contract and coordination

- Goal: independently challenge the previously green working tree, reproduce
  findings, fix their root causes locally and retain verifiable acceptance evidence.
- Inputs: the dirty OPE 0.1.54 tree, master checklist, user-approved local fix
  scope and official GitHub/Tauri/PowerShell contracts.
- Boundaries: no secret values, credential-store access, dependency installation
  or upgrade, real user database writes, account/production writes, commit, push,
  release, publication or deployment. Existing user changes are preserved.
- Done when: confirmed findings have proportionate regression proof, requested
  independent reviews are reconciled, and remaining environment-dependent claims
  are identified without relabeling them as locally proven.
- Freedom: local implementation, deterministic fakes, bounded loopback HTTP,
  generated test fixtures, formatting and read-only reviews.

The user explicitly requested an active-board task and independent reviews.
The earlier assumption that the board must be GitHub Projects, and that reviews
could not start until a board item existed, was incorrect. The agreement permits
coordination after the user **asks** to create a task; that request was present.
Three requested specialists completed independent read-only reviews and follow-up
reviews: `release_independent_review` (security auditor),
`github_independent_review` (code reviewer), and `backup_runner_review`
(root-cause debugger). The main session owns all edits.

Board status remains `PENDING_BOARD_TARGET`: the active tool catalog exposes no
board/task writer, and the user has been asked which application/board is meant.
No board item was invented, created in an assumed service, or marked done.
These returned review findings are retained here for attachment when the target
and a usable board capability are known. No credential scope was refreshed.

## Findings and source fixes

| ID | Finding | Root-cause correction | Evidence and boundary |
| --- | --- | --- | --- |
| IR-01 / P1 | Standalone `blogbot.exe` can remain unsigned after Tauri bundling even when installers are signed. | Sign the restored standalone EXE after `build:desktop`, before existing pin/timestamp verification, credential cleanup and payload copy. | RED: required post-bundle signing step absent. GREEN: execute the actual extracted PowerShell step with a fake signer; exact `/sha1`, `/fd SHA256`, `/tr`, `/td SHA256` arguments and nonzero-exit rejection pass. No real certificate operation. |
| IR-02 / P1 | Core `ConvertFrom-Json` coerces ISO manifest strings to DateTime; a valid UTC date is then rejected and date-shaped notes lose exact text identity. | Use `DateKind String` when available; retain Windows PS 5.1 behavior; older Core uses its bundled JSON reader with `DateParseHandling=None` for root `notes`/`pub_date`. Enforce string types and preserve existing schema/digest/pin checks. | RED: a documented date-coercing cmdlet boundary causes `RELEASE_MANIFEST_DATE_INVALID`. GREEN: full synthetic payload verification passes exact ordinary/date/offset/escaped notes, rejects non-UTC date and wrong field types. Actual hosted pwsh and old-Core fallback are not executed locally. |
| IR-03 / P1 | Both GitHub auth transports use a GET route that does not exist; permissive fakes hid failed real authorization. | Query the documented installation repository-list endpoint directly. Bind both numeric repository ID and case-insensitive full name, then require exact permissions and one selected repository. | RED: native real HTTP transport rejected a correct fixture; Node regression rejected the valid case. GREEN: native loopback and TypeScript fixtures accept only documented routes, reject ID/name/count mismatches and retain least privilege. Existing fabricated endpoint responses removed. No authenticated GitHub request. |
| IR-04 / P1 | Native device poll and logout acquire pending/credential locks in opposite order and can deadlock. | Both use `pending → credential_lock`; logout holds pending through store deletion so an in-flight grant cannot revive cleared authorization. | RED: bounded concurrent poll/logout test timed out. GREEN: both complete, and credentials, authorization state and pending are empty. Review confirmed the lock scopes. The test's short scheduling window is a residual test-strength consideration, not proof of a production regression. |
| IR-05 / P2 | Prototype property names can be treated as waiting reasons by the Codex event map. | Require `Object.hasOwn` before waiting-reason lookup. | RED: `toString` was not denied. GREEN: `toString`, `constructor`, `__proto__`, `hasOwnProperty` are `DENIED_EVENT`; independent in-memory review confirmed normal auth/rate/quota waiting results remain valid. |
| IR-06 / P2 | Logical-backup API can return an archive that restore rejects because hashing and JSON serialization disagree for Date, Buffer, sparse arrays or hidden `toJSON`. | Require plain/null-prototype JSON objects, serialize holes as null, and build independent row snapshots with the same deterministic serializer used for hashes. | RED: Date/Buffer were accepted and a nested sparse snapshot failed integrity on restore. GREEN: unsupported objects rejected before archive return; sparse/null-prototype/plain snapshots restore consistently without executing hidden `toJSON`. Normal desktop producer already normalizes dates/objects and rejects binary; production user-backup corruption was not demonstrated. |

Additional issues caught while constructing/reviewing these regressions:

- Windows PowerShell 5.1's default file decoding corrupted non-ASCII notes in
  the full synthetic payload test. Manifest and SBOM reads now explicitly use UTF-8;
  exact Turkish/escaped notes pass.
- The new workflow-step test initially assumed LF. A read-only reviewer reproduced
  failure against an in-memory CRLF copy. The test now executes extraction on
  both LF and CRLF variants, requires identical script bodies, and passes the
  real fake-signer execution. This does not impose a new checkout policy.
- The new native HTTP fixture now bounds accept, read and write waits, including
  when a future client regression exits before issuing every expected request.

## Focused RED → GREEN commands

### Follow-up finding IR-07: failed database initialization ownership

A later read-only inventory measured 38 historical `blogbot-*` direct temp
children rather than the earlier 37, all non-reparse. The additional legacy
injection test root prompted investigation. Running that old test alone passed
and left no new directory, so a causal link between the retained directory and
the following production defect was **not** established.

A new real-PGlite test independently proved that
`PGliteBackendRepository.open()` rejected an unverifiable legacy migration while
its partially initialized database still had `closed === false`. No repository
was returned, leaving no caller that could own its cleanup.

The database constructor's succeeding initialization steps now run in a
`try/catch`: failed readiness, migrations, protector creation or index backfill
await `database.close()` before rejecting. Successful shutdown preserves the
original error object. If shutdown also fails, an `AggregateError` explicitly
retains both errors and the original cause; it does not pretend cleanup succeeded.
No migration transaction, validation or data contract was relaxed.

Two new regressions failed before the fix: real migration rejection left an
open database; a cleanup failure did not retain the two-error contract. After
the fix both pass, as does the existing unverifiable-row/sentinel test. The
cleanup-error injection is scoped to the application DB and preserves PGlite's
internal initdb cleanup. It proves error propagation, not successful shutdown
under a real OS I/O failure. The independent backup/root-cause reviewer found
no blocking regression in the two-file change.

Changed source: `packages/database/src/pglite-backend-repository.ts`.
Regressions: `tests/integration/local-engine-pglite.test.ts`.
The refreshed broad run passed: 896 total tests, 892 passes, four explicit
live-provider skips, zero failures/cancellations, and `NewTempRootCount: 0`.
Output: `build/verification/independent-review-20260905/node-after-pglite-fix.log`.
The final lint-only control-flow adjustment collects both failures before
throwing from the outer catch, preserving the original cause without disabling
`preserve-caught-error`. Its three focused regressions, lint and typecheck pass.
The independent reviewer confirmed that even falsy thrown values are retained,
with no new blocking finding. Reviewed source SHA-256:
`16414AF64F6539287039A9872D075B01F2A7415C19846C13CE31B046D1FA819E`.

Fresh engine and fetcher executable smokes and all 17 preflight checks pass.
The native WebView rerun explicitly selects the new sidecars with the existing
unchanged Rust verification application and passes with exit 0. This
avoids accidentally testing the older engine beside the native application.
The refreshed native run's maximum measured route render was 208 ms (eleven
routes). Its test-owned application/Codex profiles were cleaned. The final
top-level temp inventory still has 38 historical roots, all non-reparse; there
are zero engine-smoke, fetcher-smoke or native-Codex roots. Historical roots
were not deleted during this follow-up.

### Follow-up finding IR-08: queue settlement and claim ownership

A further bounded read-only queue/scheduler review identified a stranded-job
candidate: after a handler failed, a transient rejection in the retry SELECT
or UPDATE left an ownerless `active` row. Polling continued, but only `created`
rows were claimable. The engine's redacted fault callback did not recover it.
Main reproduced both branches against real synthetic PGlite: each RED assertion
observed `active` instead of `created` after storage had recovered.

Three further deterministic RED cases exposed related transition boundaries:
an old retry could reset a newer active claim; an old successful handler could
complete that newer claim; and stop arriving during the retry read could
dead-letter an otherwise retryable job. An initial attempt-counter fence passed
those five cases, but independent review found that dead-letter revival resets
the counter. A sixth real-queue RED exhausted the normal retry budget, revived
the same key and proved that the old attempt-one handler could complete the new
attempt-one claim. The counter-only correction was not accepted as final.

The current correction in `apps/engine/src/local-queue.ts` retains only the
finished handler's pending failure transition on its worker, retries that
transition on subsequent polls and fences both retry and completion by a fresh
UUID per claim. A nullable `claim_token` column is added idempotently for old
queue tables. Retry counters and delays keep their existing meaning; the claim
token is internal ownership metadata, not a credential or part of handler data.
A stop check after the awaited retry read preserves interrupted work for startup.
No global active-row reset, provider operation or dependency change was added.

`tests/integration/local-queue-bookkeeping.test.ts` passed eight focused cases
with exit 0 (`36,065.3059 ms`): the six RED-proven scenarios plus controls for a
committed retry write followed by rejection, and recovery from pre-token queue
schema/logical rows. The compatibility control uses the real logical table
dump/restore functions and preserves the legacy row ID, payload and retry count;
it is not a real-user archive, installer or historical application-schema gate.
Lint/typecheck passed after correcting only the test callback's payload generic.
The final independent read-only `queue_final_review` returned no blocking source
findings. It checked worker-owned pending settlement, token fences on completion
and retry, fresh claim identity after revival, the post-read stop check and
nullable/idempotent legacy schema compatibility. It did not run tests or certify
external-effect idempotency. It identified one nonblocking coverage gap: the
stale-retry fixture paused before SELECT, not separately after a successful SELECT
and before UPDATE. The test-only follow-up below addresses that gap.

The first broad matrix is retained at
`build/verification/independent-review-20260905/node-queue-initial-matrix.log`:
unit 486/486, app 171/171, integration 249 total with 244 passes, four explicit
live-provider skips and one cancellation. The new test's original 15-second
whole-test budget expired under concurrent PGlite startup (`17,192.0648 ms`);
there was no failed behavior assertion. Its test-only budget is now 45 seconds,
while the independent five-second state probes and production timers are
unchanged. This initial matrix is not PASS.

The pre-extension broad rerun completed with observed process exit 0 at
`2026-09-05T11:10:58.2646368Z`: unit 486/486, app 171/171, integration 249 total,
245 passes and four explicit live-provider skips. Aggregate: 906 tests, 902
passes, zero failures and zero cancellations. Full output and terminal exit
metadata are retained in
`build/verification/independent-review-20260905/node-after-queue-fix.log`.
This matrix includes both synthetic legacy-migration crash tests and all eight
queue follow-up checks; it supersedes the earlier 896-test matrix for Node scope.
Reviewed source SHA-256:
`E718B550335BAF80264AFB5E70DD0329EE5C076D4797EB1DE6404B2F55F5FB66`.
Focused test SHA-256 at this pre-extension checkpoint:
`36F559CDAD1A96A5CCE9AA681ECF425112D946B0D674AC7C3E78BE7FE7B4DE72`.

#### After-read coverage follow-up

The stale-retry fixture now has separate before-read and after-read cases. In
the latter, the real SELECT executes while the old claim is current; its actual
nonempty result is retained until explicit recovery and a newer handler's real
claim have completed. Only then is the result returned. A progress job proves
the old worker finished settlement before asserting that the newer reservation
is still active with attempts 2 and exactly one newer handler call. This reaches
the retry UPDATE and would detect removal of its claim-token predicate; it cannot
pass by returning an empty SELECT. Both holds are released before owned runtime
and database cleanup.

The same independent reviewer confirmed that this closes the identified gap,
preserves the original before-read case and has no observed false-success path.
This is additional verification of existing behavior, not a new production
finding, source correction or newly observed RED failure. Production source,
dependencies and the live soak's selected source set did not change.

All nine focused cases passed with observed exit 0 at
`2026-09-05T11:38:02.8775975Z` (`30,011.8358 ms`). Typecheck and lint also pass.
Evidence: `build/verification/independent-review-20260905/queue-after-read-coverage.log`
and `static-after-read-coverage.log` in the same directory. Current test SHA-256:
`55420C7581BEC89916F476DA873BBB9078A07A0860E7B2E4ED61290CF0A81CA1`.

The expanded full matrix finished at `2026-09-05T11:41:03.2759476Z` with observed
process exit 0: unit 486/486, app 171/171, integration 250 tests with 246 passes
and four explicit live-provider skips. Aggregate: 907 tests, 903 passes, zero
failures and zero cancellations. Full output and terminal metadata are in
`build/verification/independent-review-20260905/node-after-read-coverage.log`.
This supersedes the 906-test matrix for the expanded test file. No production
source or build input changed, so the preceding rebuilt-engine/native evidence
continues to apply; no redundant rebuild or installer was generated.

#### IR-08 final local runtime verification

The first engine build was denied an esbuild ancestor-directory read by the
sandbox; this is retained as a failed build attempt, not a source defect or PASS.
The reviewed retry used `CARGO_NET_OFFLINE=true`, regenerated only validated
repository build/resource directories and completed with exit 0. It installed
no dependency and emitted no installer or signed release. SEA injection warns
about the modified executable signature; these are unsigned verification copies,
not proof of the signing workflow.

| Surface | Final evidence |
| --- | --- |
| Engine build | Exit 0 at `2026-09-05T11:18:59.9533835Z`; `engine-build-after-queue-fix-retry.log`. |
| Engine/fetcher smoke | Both exit 0; engine reports READY/PGlite/queue ready; fetcher rejects the deliberately invalid request. |
| Desktop preflight | All 17 checks pass without requesting installer artifacts. |
| Native WebView | Exit 0 at `2026-09-05T11:22:01.0235567Z`; 10 native read contracts, 11 routes and 13 visible action groups. Maximum observed route render: 133 ms. |
| Controller/preflight | 5/5 pass, no skips/failures/cancellations (`79,042.6676 ms`); four injected failure cases cannot persist PASS, plus real PGlite recovery/retention preflight. |
| Static/security | Typecheck, lint, repository security scan and redacted Gitleaks all exit 0. Both scans report no findings in their configured scope. |

Logs above are under `build/verification/independent-review-20260905/`:
`sidecar-smokes-after-queue-fix.log`, `native-after-queue-fix.log`,
`controller-after-queue-fix.log`, and `static-after-queue-fix.log`.
Eleven native screenshots are under `native-queue-screenshots/`; main visually
inspected dashboard and operations. Native acceptance used explicit paths to
the new engine and current sidecars, an unchanged Rust verification executable,
and fresh disposable application/Codex profiles. No live Codex reply or real
account authentication was attempted. WebDriver's window title remained
unavailable; readiness and visible headings were checked instead. The native
log records successful test-owned Codex cleanup. The only matching native
WebView root still present was historical `blogbot-native-webview-zK3qPc`, created
`2026-09-04T10:52:34Z`, not this run; it was not deleted.

New engine SHA-256:
`598E1493740EDDEDF34E35A77AFE6BB43CF1673D4B3E84BFDB479B527A433B00`.
The fetcher, secure-restore and native application hashes match their prior
verified copies and are recorded in the smoke log. Preflight durable evidence:
`build/verification/local-engine-soak/preflight-2026-09-05T11-19-45-243Z-004fe74f/evidence.ndjson`,
ending `PASS_PREFLIGHT_ONLY` after cleanup. Its selected 115-file source identity
is `90b98ce73fbb5ed68bfb57cb97c2d4e8e0b4a27c9926117e7d36f9a405822d6e`.
Preflight is not a 24-hour endurance result.

### Earlier focused regression runs

- `node --test --experimental-transform-types --test-name-pattern="prototype property|logical backup rejects non-JSON|logical backup hashes" tests/integration/pipeline-codex.test.ts tests/integration/logical-backup.test.ts`: three intended failures before source fixes, then three passes.
- `node --test --experimental-transform-types tests/unit/github-connector.test.ts`: new valid-route regression failed before the fix; final 24/24 pass after correcting old endpoint fakes without relaxing assertions.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml github_broker::tests:: -- --nocapture`: 32 passed and the two intended regressions failed before source fixes; then 34/34 passed.
- `node --test --experimental-transform-types tests/unit/release-scripts.test.ts`: two intended failures before source fixes; then 2/2 passed, including actual PS 5.1 subprocesses and fake signing/JSON boundaries.

## Broad verification snapshot before IR-08

| Surface | Latest authoritative evidence |
| --- | --- |
| Node unit | 486/486 passed in the official matrix; the final newline-normalized release-script file additionally passed 2/2 focused tests. |
| Desktop/Codex-runner apps | 171/171 passed in the official matrix. |
| Node integration | Refreshed after IR-07: 239 total, 235 passed, four explicit live-provider skips, no failure/cancellation, exit 0. Combined group totals: 896 tests, 892 passes, four skips; no new temp root. Output: `build/verification/independent-review-20260905/node-after-pglite-fix.log`. Earlier 237-test evidence remains historical at `integration.tap`. Final lint-only control-flow adjustment additionally passed the three focused database tests. |
| Rust tests | 255/255 passed after the production and bounded-fixture changes. |
| ESLint / TypeScript | Both exit 0. |
| Clippy / rustfmt | Both exit 0 on the rerun; the lost earlier Clippy handle is not counted as success. |
| Security scan / Gitleaks | Fresh repository scan reports no findings; redacted Gitleaks scan reports no leaks, both exit 0. No secret values were requested or logged. |
| Frontend production build | Exit 0. Sandbox esbuild parent-directory discovery failed; the same reviewed build passed with the read boundary escalated. No dependency change. |
| Context audit | `npm.cmd run token:audit`: 6,923 estimated tokens across its six configured primary context files. |
| Engine/fetcher/secure-restore build | Fresh unsigned sidecars built successfully. The same reviewed esbuild command required a parent-read sandbox escalation; generated deletion targets were first verified inside the workspace with no reparse points. |
| Sidecar smoke / preflight | Engine doctor: `READY`, PGlite and durable queue ready. Fetcher: exactly one expected invalid-request rejection. All 17 preflight checks pass. Fresh owner-scoped temp inventory: zero engine/fetcher/release-test residue. |
| Native application | The prior installer-free verification build is unchanged by IR-07. A fresh temporary-profile WebView run explicitly binds the newly built engine/fetcher/restore paths and exits 0 with `PASS`: ten native read contracts, eleven routes, thirteen visible-action groups, cold engine startup and draft recovery after restart. Public RSS reads are part of this harness; live Codex/Boby and optional live updater probes are disabled, and Codex home is an empty test-owned temporary directory. Refreshed output: `build/verification/independent-review-20260905/native-after-pglite-fix.log`; the preceding run remains at `native-smoke.log`. No installer or release was produced. |

### Fresh sidecar SHA-256 identities

These are unsigned local verification outputs, not release assets:

| Output | SHA-256 |
| --- | --- |
| Engine | `70A53B1D7D86A7D45B992ECEFBC721B6AD3241F03CF0BBB241BF521FF4E3EC1D` |
| Fetcher | `AD4153EB03D483DC7251B42C11E573AB0B8AA49ECC0F48406EEE2BA1AA3D97DA` |
| Secure restore | `D696E93EB7AEE1655151C92CFB18A859A72F0DF7328D16E0ADF151F78645A857` |

Unchanged native verification application SHA-256:
`3616191B6C7084955719F53DA7662A8FC55319E6EA860C0DA21AB14B18FA181D`
(7,076,352 bytes). Edge `152.0.4191.62` and EdgeDriver `152.0.4191.53`
completed this run without a driver-start failure or an installation/upgrade.
The native title API returned `WEBDRIVER_TITLE_UNAVAILABLE`; rendered headings,
bridge responses and interactions were verified, but an exact native title was
not proven by that API. This is a disclosed harness evidence limitation.

## Independent follow-up result

All three requested reviewers returned their findings and closure reviews. GitHub
and backup/runner reviewers found the original root causes resolved without new
blocking production findings. The release reviewer confirmed preservation of
pin/timestamp/cleanup/publication gates, found the test newline issue above, and
explicitly retained the real-pwsh/signing evidence gap. Source review is not a
replacement for execution evidence.

The release reviewer also re-read the final LF/CRLF regression and closed that
finding without a new finding. Reviewed test SHA-256:
`7A2AF09F06F0C1C9A191C116D78869918EBF242BC8E0311422A6FECAE74F5A84`.

Historical temporary-root review and release version promotion remain separate
maintenance/release tasks, not invented permission blockers for the completed
local fixes. The active board target and the twenty external acceptance entries
in the master checklist remain genuinely unverified.

## DATA-03 local observation follow-up — first run interrupted

Current status: the first long run was intentionally stopped before the IR-08
production change. Its final record is `FAILED` at `2026-09-05T09:04:12.306Z`
(`Channel closed`), and the Node test exited 1. Main first revalidated the exact
owned child's PID, parent, creation times, executable and fixture identity, then
terminated only that child at `2026-09-05T09:04:04.8003154Z`; the controller
performed its failure cleanup. The exact synthetic temp root no longer exists.
This was a deliberate invalidation for a confirmed source correction, not an
unexplained engine crash or a completed 24-hour run. Its durable evidence remains.
The replacement final-source run is recorded in
[the second-run interruption section](#data-03-second-run--interrupted-by-windows-restart).
The current observation is recorded in [the third-run section](#data-03-current-source-observation--third-run).

The last heartbeat was `2026-09-05T09:03:42.290Z`, after `34,135,639 ms` of the
continuous phase, with 1,137 heartbeat records. No partial duration is carried
into a later run. The earlier 6 September 02:36 Turkey-time estimate is superseded.

The assumption that every remaining external gate first needed user-supplied
targets was too broad. DATA-03 has a meaningful synthetic local-engine portion
that can run without a real account, secret or user database. A new opt-in test
uses the actual persistent engine, PGlite, durable queue and unmodified daily
maintenance timers. The external-effect boundary is a local fixture counter;
source fetching and actual publication are not exercised.

New verification-only files:

- `tests/soak/local-engine-24h.test.ts`: default short preflight or explicit
  `BLOGBOT_SOAK_MODE=24h`, real child interruption/restart, heartbeat/clock gates,
  source fingerprint and cleanup-before-PASS evidence.
- `tests/fixtures/local-engine-soak-child.ts`: synthetic-only environment,
  one real PGlite connection observed transparently, valid encrypted retention
  fixtures and bounded pass-through maintenance-event capture.
- `tests/soak/controller-negative.test.ts`: rejects first-phase network attempts,
  unexpected exit before clean shutdown, cleanup failure and refused spawn.

An independent review found four controller defects, not four new production
application findings. All four negative regressions failed for their intended
reasons before correction: two false successful exits, a durable PASS remaining
after cleanup failure, and an eight-second spawn-failure timeout. After fixes,
the final four negatives plus positive preflight passed 5/5; lint, typecheck,
security scan, redacted Gitleaks and diff whitespace checks passed. No soak temp
root remained after these preflights. An initial recursive Node-test invocation
error was harness bring-up noise, not counted as the intended RED evidence.

The closure reviewer confirmed the four source fixes and the bounded event
observer. Residual negative-wrapper limit: its emergency watchdog terminates
the direct controller, but does not independently prove descendant cleanup if
that controller hangs after a fixture child was created. The exercised failure
paths and final positive run cleaned up; no broader failure-cleanup claim is made.

The actual long mode's first evidence record is `2026-09-04T23:29:39.937Z`. It first waits for the
natural five-minute overdue-backup operation, interrupts only its own child,
then observes a new engine process for at least 24 hours. No timer acceleration,
power-setting change, provider access or real publication is used. A heartbeat
gap above 90 seconds or a clock discontinuity invalidates continuous evidence.

Initial real-time evidence passed: automatic backup completed at
`2026-09-04T23:34:43.651Z`, with exactly one observed `RUNNING → SUCCEEDED`
operation. Retention changed 28 automatic archive fixtures to 19 while the
manual archive's hash remained unchanged. A new engine process recovered the
interrupted job by `2026-09-04T23:34:46.641Z`: its attempts increased from one to
two with exactly one local effect, while the earlier completed job stayed at
one attempt/effect. The continuous daily window starts after that recovery;
this initial evidence is not the daily-timer result. The run's initial source
fingerprint covers 115 files and is
`931cda384a5c9f19719866b21522b9ead4a12eeec1bce11048a7c71ff589a7aa`.

Interrupted first-run evidence directory:
`build/verification/local-engine-soak/24h-2026-09-04T23-29-39-891Z-2d86f2b7/`.
A successful run's `evidence.ndjson` must end in `PASS_LOCAL_ENGINE_24H`, and its
Node test must exit 0 before local long-duration acceptance is claimed. `RUNNING`, a live
process, a short preflight, or elapsed time alone is not success. Real GitHub
effects, installed desktop behavior, source-evidence retention with a real
corpus and independent operator acceptance remain separate unverified scopes.

An interim read-only audit through `2026-09-05T08:10:40.390Z` observed 1,031
heartbeat records and `30,953,738 ms` of continuous-phase elapsed time. The
maximum interval between recorded heartbeats was `33.193 s`; none reported
the engine unready, a network attempt or more than one effect for any of the
three synthetic jobs. The original Node test process was still live. No
`FAILED` or `PASS_LOCAL_ENGINE_24H` record existed at this checkpoint. This is
only a progress observation exceeding eight hours, not a completed 24-hour acceptance.
At that interim checkpoint, no file in the running soak's selected source set had changed.
The separate migration verification below adds two test files outside that set.
The interrupted run did not reach its mandatory final source-fingerprint gate.

A separate read-only PowerShell computation at `2026-09-05T06:57:44.3769766Z`
reproduced the same ordinal path ordering and SHA-256 byte composition over the
test's selected 115-file scope. Its digest matched the initial source identity
above exactly. This is an interim source-identity check, not a replacement for
the mandatory final fingerprint and cleanup gates.
The same 115-file digest also matched at `2026-09-05T08:51:27.4939141Z`, before
the confirmed IR-08 regression and the controlled stop. It does not identify
the subsequently changed queue source.

## DATA-03 second run — interrupted by Windows restart

A fresh full run started at `2026-09-05T11:25:03.690Z` (5 September 14:25 Turkey
time), after IR-08's final local source, matrix, rebuilt-engine/native and
controller verification. This run is now INTERRUPTED_HOST_RESTART, not accepted. Its initial phase
waits for the actual overdue automatic backup before terminating/restarting only
its owned fixture engine. The continuous 24-hour phase and its completion
estimate begin at successful recovery, not at initial process launch.

The natural overdue backup succeeded at `2026-09-05T11:30:06.672Z`. The owned
engine was then terminated/restarted by the controller and durable recovery
completed at `2026-09-05T11:30:09.351Z`. At recovery the engine was ready, network
attempts were zero, and both the earlier completed job and interrupted job had
exactly one synthetic local effect. Continuous observation ran from this recovery
point until the host restart described below. The previous 6 September 14:31
Turkey completion estimate is invalid; this elapsed time is not transferable
to another run.

- Durable evidence: `build/verification/local-engine-soak/24h-2026-09-05T11-25-03-656Z-4abfa349/evidence.ndjson`.
- Process output/terminal exit log: `build/verification/independent-review-20260905/long-after-queue-fix.log`.
- Synthetic owned root: `blogbot-engine-soak-BoGk1e`; no user profile, real account or provider network access.
- Selected source identity: 115 files, SHA-256 `90b98ce73fbb5ed68bfb57cb97c2d4e8e0b4a27c9926117e7d36f9a405822d6e`.

An independent read-only PowerShell computation at
`2026-09-05T11:26:27.5090130Z` reproduced the exact ordinal path ordering and
SHA-256 byte composition, matching the initial identity. Its record is in
`build/verification/independent-review-20260905/long-source-identity-checks.log`.
The same independent computation again matched all 115 files at
`2026-09-05T11:42:10.3130882Z`, after the test-only after-read coverage extension
and its passing full matrix. That integration test is outside the selected
soak source set. The live controller session was also polled successfully;
this source-identity checkpoint is not inferred from a state file alone.
The old run's elapsed time is not reused. Completion still requires the real
duration, timer/retention/recovery assertions, final source identity, clean
shutdown and cleanup, durable `PASS_LOCAL_ENGINE_24H` and observed Node exit 0.
No such final result exists for this run. Its last heartbeat was at
`2026-09-05T19:32:52.005Z`, with `28,962,637 ms` of continuous observation
(8 hours, 2 minutes, 42.637 seconds). All 964 recorded heartbeats were healthy,
but neither the daily window nor final shutdown/cleanup completed.

Read-only Windows evidence confirms a host restart: User32 event 1074 at
`2026-09-05T19:32:48.7716907Z` identifies `restart` with reason code `0x0`;
EventLog 6006 at `19:33:06.7378340Z` and 6005 at `19:33:50.3184790Z`, together
with the new system uptime, confirm shutdown/startup. Both owned process IDs
were absent after restart; the tool session was also missing. No Node crash
event was found in the checked window, and no PASS/FAILED journal entry or
observed Node exit code exists. The supported conclusion is interruption by
host restart, not a reproduced application-code failure or a clean test exit.

The incident summary and fresh unchanged-source fingerprint are retained in
`build/verification/independent-review-20260905/long-host-restart-20260905.log`.
Periodic source and resource observations remain in
`long-source-identity-checks.log` and `long-resource-checks.log` in the same
directory; they are interim evidence only. The non-reparse old fixture root
`blogbot-engine-soak-BoGk1e` is preserved, not deleted; cleanup is unverified.
No power/update setting, source code, user data, account or external system was
changed during diagnosis. Real external effects and installed-desktop lifecycle
acceptance remain separate gates.

## DATA-03 current-source observation — third run

A fresh isolated run started after the confirmed host restart, using the same
115-file source identity and Node `v25.9.0`. Its wrapper started at
`2026-09-05T19:44:13.6123312Z`. Status is INTERRUPTED_HOST_RESTART_NOT_ACCEPTED. The natural
overdue automatic backup succeeded at `2026-09-05T19:49:17.728Z`; controlled
restart and durable recovery completed at `2026-09-05T19:49:20.599Z`.
Continuous observation started immediately after recovery, not at wrapper launch.
The former conditional completion estimate of 6 September 22:50:21 Turkey time
is invalid following the host restart described below.

- Durable evidence: `build/verification/local-engine-soak/24h-2026-09-05T19-44-14-186Z-e4115838/evidence.ndjson`.
- Process output/exit log: `build/verification/independent-review-20260905/long-after-host-restart.log`.
- Initial journal entry: `2026-09-05T19:44:14.245Z`; synthetic owned root: `blogbot-engine-soak-rZ40Eh`.
- Source SHA-256: `90b98ce73fbb5ed68bfb57cb97c2d4e8e0b4a27c9926117e7d36f9a405822d6e`.

At recovery, the completed and interrupted jobs each had exactly one local
effect; the future job was still correctly queued. By the heartbeat at
`2026-09-05T19:53:20.750Z`, all three were completed with exactly one synthetic
effect each, with zero network attempts and verified backups. This is early
recovery/scheduling evidence, not the final daily-maintenance result.

At `2026-09-05T19:55:38.9928383Z`, a scoped read-only process check matched
the controller and recovery child by executable, creation time, parent,
fixture path, owned root and recovery arguments, without disclosing the raw
command line. The live terminal session was also successfully polled.
Evidence: `build/verification/independent-review-20260905/long-third-run-process-identity.log`.
An independent PowerShell computation at `2026-09-05T19:55:43.1069677Z`
matched the same 115-file source digest. Evidence:
`build/verification/independent-review-20260905/long-third-run-source-identity-checks.log`.

No elapsed time from either earlier run is reused. Acceptance still requires
the complete real-time window, daily backup and retention assertions, final
source identity, clean shutdown and cleanup, durable `PASS_LOCAL_ENGINE_24H`
and an observed Node exit 0. No Windows power or update policy was changed.

### Third-run terminal observation — host restart, no accepted test result

On 6 September, the observer handle and terminal session 98581 became unavailable.
A read-only process check also found neither controller PID 26044 nor engine
PID 20228. This was not classified from the observer failure alone.
The journal stopped at `2026-09-06T18:03:09.528Z`, with 2,666 heartbeats and
80,028,921 ms (22 h 13 min 48.921 s) of continuous observation. It contains no
`PASS_LOCAL_ENGINE_24H`, `PASS_PREFLIGHT_ONLY` or `FAILED` terminal result;
the wrapper log contains no observed exit status. Daily retention, final
shutdown and cleanup therefore remain unverified.

Scoped System event metadata corroborated a host restart: User32 event 1074 at
`2026-09-06T18:03:32.0024812Z`, EventLog 6006 at
`2026-09-06T18:03:44.4237315Z`, and EventLog 6005 at
`2026-09-06T18:04:29.6662064Z`. Raw event messages, account names and initiating
command lines were not disclosed. This establishes the interruption context,
not a new application-code defect or the identity of the restart initiator.

The last hourly source check at `2026-09-06T17:50:31.9186892Z` matched the same
115-file digest. The 22-hour resource sample recorded engine private memory
337.047 MiB, unchanged from the prior hourly sample; these interim measurements
are not leak-freedom or 24-hour acceptance evidence. Existing journals and
fixture data were not deleted. No replacement run was started after this
interruption; a new uninterrupted window is required, with no elapsed-time reuse.

## DATA-01 and DATA-02 bounded acceptance follow-up

The requested root-cause reviewer compared the remaining archive, legacy
migration and selected-site gates with their existing local tests. Main
confirmed the two follow-ups below; the reviewer then completed a read-only
closure review without finding a blocking false-success or ownership defect.
Execution results in this section are the main session's evidence, not tests
independently run by the reviewer.

### DATA-01 — documentation-only correction

The runbook and master checklist had incorrectly asked for archive restoration
into a new Windows profile. The active recovery decision in ADR 0003 and the
logical-backup contract retain the existing profile's DPAPI-bound data key.
The procedure now targets a separate disposable application/data directory
under the same Windows user, preserves the original workspace and expressly
does not claim cross-profile or cross-machine recovery. A recovery key for the
outer archive alone does not remove the inner data-key boundary. No recovery
implementation or architecture decision changed, and no real archive was opened.
DATA-01 remains open for the authorized real archive, source baseline and
expected row/media manifest.

### DATA-02 — new local execution evidence

The existing marker-resume test manually prepared a partial checkpoint and then
closed/reopened normally. New verification-only files now exercise actual
process termination after a real encryption-migration page commit:

- `tests/integration/legacy-migration-crash.test.ts`
- `tests/fixtures/legacy-migration-crash-child.ts`

Two copies of the same closed synthetic database start with 401 plaintext
revision rows. The baseline upgrades normally. In the interruption copy, a
pass-through observer pauses only the owned child after the real migration's
commit-progress signal; the parent terminates that child and waits for its
terminal event. Raw PGlite inspection, without application migration, then
finds exactly 200 sealed rows, the `legacy-000199` checkpoint, no completion
sentinel and no list-index backfill. Resume preserves all 401 rows and their
input plaintext hash, preserves the first committed page's ciphertext, clears
the checkpoint, creates the completion sentinel and fills the list index.
Another normal reopen leaves the ciphertext unchanged. Schema-migration
**ledger** hashes also match; this is not a physical-schema equivalence claim.

A second, deliberately late-termination control finishes migration before
pausing. The verifier rejects it with exactly `MIGRATION_NOT_INTERRUPTED`,
so a normal completed upgrade cannot masquerade as interruption recovery.
The custom output is an `OBSERVATION`, not PASS before teardown; acceptance
uses the final Node exit status and completed cleanup.

The final focused run passed 2/2 with no skips, failures or cancellations
(`17,751.712 ms`). Lint, typecheck, the repository security scan and redacted
Gitleaks passed. The final matching `blogbot-migration-crash-*` temp-root count
was zero. The earlier 896-test full Node matrix predates these two additions
and was not rerun during the old active soak. Both tests subsequently passed
within both the IR-08 906-test matrix and the expanded 907-test matrix recorded above.

Verified source SHA-256:

- Integration test: `067BF831E7BC033952B436345EF05DC9466C39A47339C15C18D95CDC0CC97667`
- Child fixture: `9CF1F192753707884A4837DF2162F1EAE3B6DE35EC9CDD9C502C22C06C27A6DB`

Scope remains synthetic legacy **encryption** migration on the current schema,
at the first committed-page boundary. It does not prove a real historical DDL
upgrade, the oldest supported profile, every interruption point, media recovery,
power loss during an in-flight transaction or external publication effects.
Those DATA-02 acceptance inputs remain required. No production source, actual
user database, credential, dependency or release artifact changed.

SITE-01's existing local no-write structural fixture was not repeated merely
to inflate evidence. Real schema/route/SEO compatibility still needs the
selected authorized clone, its commit identity and expected output manifest.

## Primary contracts

- [GitHub installation repository list](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token) defines the supported GET route used by IR-03.
- [Pinned Tauri CLI 2.11.4 bundler source](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs) shows main-binary backup/restore around package-specific bundling, explaining IR-01.
- [Microsoft ConvertFrom-Json documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/convertfrom-json?view=powershell-7.5#notes) documents Core date conversion and `DateKind` introduced in 7.5.
- [Newtonsoft reader DateParseHandling](https://www.newtonsoft.com/json/help/html/P_Newtonsoft_Json_JsonReader_DateParseHandling.htm) describes the per-reader control used by the older-Core fallback.

## Unresolved acceptance

The master checklist's external-provider, actual signed-CI, clean Windows,
long-running, real data and human-review requirements remain open. No code-only
test proves them. Actual pwsh (including the pre-7.5 fallback) and real signing,
timestamp-chain validation and fail-closed certificate cleanup need environment
execution evidence. Board attachment awaits the identified board/tool. This
report does not authorize any excluded operation and does not mark the goal done.
