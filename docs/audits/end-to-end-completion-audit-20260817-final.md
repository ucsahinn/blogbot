# OPE uçtan uca tamamlanma ve kanıt denetimi — 0.1.36

Tarih: 2026-08-17
Commit: `e9940fc` (`release: prepare OPE 0.1.36`)

Bu rapor mevcut `main` çalışma ağacındaki kodu ve bu turda çalıştırılan doğrulamaları eşler. Yerel testlerin yeşil olması; gerçek Codex/Luna Low hesabı, ImageGen sağlayıcısı, GitHub yetkisi veya temiz Windows makinesi anlamına gelmez. Bu dış kapılar ayrı tutulmuştur.

## Ürün sınırı

- OPE local-first Windows masaüstü uygulamasıdır; engine, PGlite ve durable queue yerel source of truth'tur.
- Dış kaynak yalnızca kanıttır; kaynak gövdesi yayın metni olarak kopyalanmaz.
- Yayın, tam immutable revision hash'i ve insan onayı olmadan başlayamaz.
- Revision, kaynak/iddia, medya, adapter, hedef veya zaman değişirse önceki preview/onay geçersizdir.
- Codex, GitHub, ImageGen veya site connector hazır değilse uygulama WAITING/DEGRADED/UNAVAILABLE gösterir ve dış etki başlatmaz.
- Kullanıcıya CMD penceresi açılmaz; native yardımcı süreçler GUI/no-window sınırlarıyla başlatılır.

## Faz kanıt matrisi

| Faz | Durum | Kanıt |
|---|---|---|
| Runtime/Doctor | PASS | `npm.cmd run smoke:engine`, Doctor `READY`, PGlite ve queue `ready` |
| PGlite/encryption/identity | PASS | database/native secure-store testleri |
| Durable queue/recovery | PASS | Node integration, native restart/recovery ve idempotency testleri |
| Source URL/RSS/Atom/OPML/SSRF | PASS | source/fetcher/security testleri |
| Source save/review/scan | PASS | source repository, integration, native ve browser testleri |
| Candidate/dedupe/promotion | PASS | workflow/native/browser senaryoları |
| Draft/research persistence | PASS / Codex gated | durable job metadata, bounded evidence snapshot ve workflow testleri |
| Boby/Luna Low | PASS / runtime gated | Boby bridge/UI/native tests; gerçek oturum dış kapıdır |
| TR/EN revision, claims, evidence, SEO | PASS fail-closed | editorial quality/revision/approval testleri |
| ImageGen/media | PASS / provider gated | prompt boundary, media policy ve renderer testleri |
| Approval/high-risk approval | PASS fail-closed | exact hash/version/secure-store native ve domain testleri |
| Publication preview/outbox | PASS / connector gated | manifest/hash/idempotency/publisher/native testleri |
| Backup/restore/diagnostics | PASS locally | backup, secure restore, redaction ve browser testleri |
| Updater | PASS locally | HTTPS+SHA-256 manifest, visible bootstrapper contract/native testleri; canlı clean-machine handoff dış kapıdır |
| UI/accessibility/responsive | PASS | 137/137 browser; a11y, keyboard, overflow, zoom ve route senaryoları |
| Native packaging | PASS locally | desktop preflight, engine build, native test/clippy |

## Doğrulama sonuçları

- `npm.cmd run test:all`: 502 test; 501 pass, 0 fail, 1 bilinçli skip.
- Browser/E2E: 137/137 pass.
- `npm.cmd run lint`: PASS.
- `npm.cmd run typecheck`: PASS.
- `npm.cmd run build`: PASS; desktop version `0.1.36`.
- `npm.cmd run build:engine`: PASS.
- `npm.cmd run smoke:engine`: PASS; Doctor `READY`, PGlite `ready`, queue `ready`.
- `npm.cmd run native:test`: 131/131 pass.
- `npm.cmd run native:lint`: PASS with `-D warnings`.
- `npm.cmd run desktop:preflight:json`: all checks PASS.
- `npm.cmd run security:verify`: security scan 0 finding, npm audit 0 vulnerability, gitleaks 0 leak.
- `npm.cmd run token:audit`: 6,569 estimated tokens across governed context files.
- Release workflow `32008514821`: PASS; version verification, unsigned installer build, updater manifest and GitHub publication all passed.

## Bu turda doğrulanan kök neden düzeltmeleri

1. Local queue ve publication outbox insert/read yarışları atomic idempotency ile kapatıldı.
2. Retryable source scan sonuçları kalıcı FAILED durumuna yanlışlıkla düşmüyor.
3. Draft evidence snapshot ve progress stage durable job metadata'ya yazılıyor.
4. Codex/ImageGen promptlarında kaynak alanları untrusted data olarak sınırlandı.
5. Boby native probe sonucu eski bootstrap snapshot tarafından ezilmiyor.
6. Bootstrap bridge/workspace okumaları bounded timeout ve güvenli retry ile korunuyor.
7. Mutation sonrası projection refresh hatası başarı mesajını ezmiyor; kullanıcıya tek ve doğru degraded notice gösteriliyor.

## Harici doğrulama kapıları

Aşağıdaki maddeler mevcut kod/test ile dürüstçe PASS sayılamaz ve credential/harici makine gerektirir:

1. Bu Windows profilinde gerçek Codex/Luna Low hesabıyla Boby ve completed draft output smoke.
2. Açıkça sağlanmış ImageGen anahtarıyla gerçek provider çağrısı ve revision media materialization.
3. GitHub device authorization, repository scope, required checks ve deploy workflow reconciliation.
4. Kullanıcının seçtiği gerçek site adapter ile publication preview ve approval-bound enqueue dry-run.
5. Temiz Windows profilinde install, upgrade, rollback ve updater handoff.
6. Gerçek kullanıcı kaynak havuzunda editoryal kalite kalibrasyonu.

Bu kapılar tamamlanmadan ürünün dış entegrasyonları tamamlandı iddiası yapılmamalıdır. Uygulamanın beklenen güvenli davranışı bu durumlarda fail-closed ve kullanıcıya görünür WAITING/DEGRADED durumudur.

## Release

- Commit: `441f593` — local workflow/startup/backend düzeltmeleri.
- Version commit: `e9940fc` — OPE 0.1.36 manifest bump.
- Branch: `main`, remote ile eşit.
- Release: `v0.1.36`, imzasız HTTPS + SHA-256 GitHub release.

## Bilinçli olarak release'e alınmayan dosyalar

- `.env.example`
- `IDEA.md`

Bu dosyalar mevcut çalışma ağacında kullanıcı dosyaları olarak korunmuş, release commit'lerine alınmamıştır.