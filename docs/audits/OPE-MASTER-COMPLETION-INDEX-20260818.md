# OPE master completion index — 2026-08-18

Bu indeks, OPE için bu çalışma zincirinde üretilen tüm önemli audit, mimari karar ve dış kapı belgelerini tek yerde toplar. Aktif ürün sözleşmesi local-first Windows masaüstü uygulamasıdır; eski remote-backend ADR'leri tarihçedir.

## Faz kanıt matrisi

| Faz | Aktif kanıt | Yerel durum | Dış kapı |
|---|---|---|---|
| Runtime, Doctor, PGlite, queue | `end-to-end-verification-20260818.md`, engine smoke | PASS | Temiz makine restart |
| Bridge, Tauri permissions, process isolation | `end-to-end-backend-audit-20260816.md`, native tests | PASS | Yok |
| Source ingestion, RSS/Atom/OPML, SSRF | backend audit, source integration tests | PASS | Gerçek URL kalite kalibrasyonu |
| Candidate, research, draft | backend audit, workflow tests | PASS / Codex-gated | Gerçek Codex hesabı |
| Boby/Luna Low | Boby persona/policy/routing, UI/native/browser tests | PASS / live-gated | Gerçek Luna Low session |
| Claims, evidence, TR/EN, SEO | quality/revision/approval tests | PASS fail-closed | Gerçek haber havuzu kalibrasyonu |
| ImageGen/media | visual policy/provider tests | PASS / provider-gated | Gerçek ImageGen provider |
| Approval and high-risk approval | revision approval tests, secure-store tests | PASS fail-closed | Gerçek Windows user confirmation |
| Publication preview/outbox | publication preview/composition/outbox tests | PASS / connector-gated | GitHub/site adapter |
| Backup, restore, diagnostics | backup/native/diagnostics tests | PASS locally | Temiz profil restore |
| Updater | unsigned updater contract/native tests | PASS locally | Temiz Windows upgrade/rollback |
| UI, accessibility, responsive, Boby layout | browser 137/137, UI contract 42/42 | PASS | Gerçek installed EXE visual smoke |
| Packaging and security | check:all, preflight, npm audit, gitleaks | PASS | Release identity is unsigned by policy |

## Canonical reports

- [End-to-end verification and fixes](end-to-end-verification-20260818.md)
- [External gates handoff](external-gates-handoff-20260818.md)
- [End-to-end completion audit final](end-to-end-completion-audit-20260817-final.md)
- [End-to-end backend audit](end-to-end-backend-audit-20260816.md)
- [Static audit remediation ledger](static-audit-remediation-20260811.md)

## Architecture and product decisions

- [Local-first runtime ADR](../adr/0004-local-first-runtime.md)
- [Durable editorial state ADR](../adr/0005-durable-editorial-state.md)
- [Runtime isolation ADR](../adr/0003-runtime-isolation.md)
- [Unsigned update/recovery ADR](../adr/0003-local-recovery-and-unsigned-update-boundaries.md)
- [System architecture](../architecture/system.md)
- [Boby persona](../boby/BOBY_PERSONA.md)
- [Boby prompt policy](../boby/BOBY_PROMPT_POLICY.md)
- [Boby Codex routing](../boby/BOBY_CODEX_ROUTING.md)

## Current verified command gate

```powershell
npm.cmd run check:all
npm.cmd run test:browser
npm.cmd run desktop:preflight:json
```

Current evidence: Node 502 tests with 0 failures, browser 137/137, native 131/131, engine READY/PGlite ready/queue ready, security and gitleaks clean, lint/typecheck/build/clippy/preflight passing.

## Completion boundary

Local source and verification work is complete. The remaining items require a real account, provider, GitHub/site target, or clean Windows profile and therefore cannot be truthfully completed by source edits alone. No credentials are stored in this repository.
