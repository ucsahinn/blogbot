# OPE uçtan uca backend denetimi

Tarih: 2026-08-16

Bu belge mevcut çalışma ağacını, yerel backend'i, Tauri köprüsünü, masaüstü akışlarını ve test/paketleme sözleşmelerini kanıtla eşleştirir. Yeşil test sonucu Codex, GitHub, hosting veya temiz Windows kurulumunun canlı olarak doğrulandığını kanıtlamaz.

## Mimari sözleşme

OPE yerel Windows masaüstü uygulamasıdır. Tauri WebView yalnız allowlist edilmiş komutlara gider; Rust bridge Node engine sidecar'ını stdio üzerinden çalıştırır; engine PGlite ve pg-boss üzerinde tek yazardır. Remote Blogbot API, remote worker, remote Blogbot database veya localhost HTTP control-plane ürün sözleşmesinin parçası değildir. Kanıt: `AGENTS.md`, `PRODUCT.md`, `docs/architecture/system.md`.

Kalıcı invariants: insan onayı tam immutable revision hash'ine bağlı olmadan yayın yok; çalıştırılmamış kontrol başarı sayılmaz; revision/bundle/adapter/hedef/schedule değişirse eski preview/onay geçersizdir; dış kaynak güvenilmeyen kanıttır; fetch/Codex/GitHub/yayın çevrimdışı ortamda fail-closed'dur; ücretli API fallback açıkça etkinleştirilmedikçe seçilmez.

## Faz matrisi

| Faz | Kod kanıtı | Test kanıtı | Güncel durum | Eksik canlı kanıt |
|---|---|---|---|---|
| Runtime/doctor | `apps/engine/src/stdio-entrypoint.ts`, `apps/desktop/src-tauri/src/engine_bridge.rs` | engine smoke, native test | Uygulandı | temiz Windows kurulum/restart |
| PGlite/encryption/identity | `packages/database/src/encrypted-json.ts`, `source-repository.ts` | database/encryption/migration testleri | Uygulandı | gerçek kullanıcı profili upgrade/restore |
| Durable queue/restart | engine queue, `publication-outbox-worker.ts` | queue/Codex/publication worker testleri | Uygulandı | zorla kapanma sonrası GUI restart |
| Source URL/RSS/Atom/sitemap/OPML | `apps/fetcher`, `source-scan.ts`, `packages/security/src/url-policy.ts` | source protocol, SSRF, fetcher integration | Uygulandı | canlı URL read-only denemesi |
| Source test/review/save/scan | `SOURCE.TEST/REVIEW/SAVE/SCAN` | source repository/native/browser smoke | Uygulandı | gerçek kullanıcı kaynak havuzu |
| Candidate/dedupe/promotion | engine `CANDIDATE.LIST`, native promote/dismiss | source protocol/native/demo tests | Uygulandı | gerçek kaynak havuzunda kalite ölçümü |
| Draft creation | `DRAFT.CREATE`, `apps/engine/src/codex-draft.ts` | workflow/Codex worker/instant-create | Uygulandı, Codex'e bağlı | gerçek Codex login/runtime |
| Boby guide | `BOBY.GUIDE`, `apps/codex-runner/src/boby-guide-task.ts` | Boby task/workflow/UI tests | Uygulandı, runtime'a bağlı | canlı Luna Low/Codex cevap testi |
| TR/EN revision | final-review materializer, `REVISION.LIST/GET` | editorial protocol/revision tests | Uygulandı | gerçek Codex parity çıktısı |
| Claims/evidence/SEO gates | `packages/editorial/src/quality-gates.ts`, `codex-draft.ts` | quality-gates/final-review/claim testleri | Uygulandı, unresolved claim fail-closed | haber türleriyle kalibrasyon |
| Visual/imagegen | `packages/visuals`, imagegen provider/policy | visual/imagegen/media repair testleri | Uygulandı, provider'a bağlı | gerçek provider ve materialization |
| Normal/high-risk approval | `APPROVAL.GRANT`, `APPROVAL.GRANT_HIGH_RISK` | approval/revision/native tests | Uygulandı, secure-store'a bağlı | gerçek Windows ikinci onay |
| Publication preview | `PUBLICATION.PREVIEW`, manifest/policy/hash | publication composition/review tests | Uygulandı | configured adapter preview |
| Publication enqueue/outbox | `PUBLICATION.ENQUEUE`, Rust GitHub broker | outbox/publisher/native broker tests | Uygulandı, broker'a bağlı | gerçek GitHub auth/check/deploy |
| Effective-once effects | `apps/publisher/src/github-effects.ts`, broker claim/complete | idempotency/effects tests | Uygulandı | gerçek remote retry/partial failure |
| Backup/verify/restore | engine backup + `secure_preview_fs.rs` | backup/restore/retention tests | Uygulandı | yeni Windows kullanıcı profili |
| Diagnostics | Tauri exporter + Operations | diagnostics/bridge/native tests | Uygulandı | installed app klasör açma |
| Unsigned updater | `unsigned_updater.rs`, release workflow | updater contract/native tests | Uygulandı, HTTPS+SHA-256 | gerçek release/installer handoff |
| UI/native packaging | OPE logo v2, Tauri icons, preflight | build/browser/native smoke/preflight | Uygulandı | temiz makine GUI smoke |

## Gerçek engine komut yüzeyi

`apps/engine/src/stdio-entrypoint.ts` capability listesi `SOURCE.LIST/TEST/SAVE/REVIEW/SCAN`, `CANDIDATE.LIST`, `REVISION.LIST/GET/REPAIR_MEDIA`, normal ve high-risk approval, `PUBLICATION.PREVIEW`, capability varsa `PUBLICATION.ENQUEUE`, `BACKUP.CREATE/VERIFY` ve `DRAFT.CREATE` komutlarını açar. `BOBY.GUIDE`, `JOB.RETRY` ve local state akışları workflow command katmanındadır.

`REVISION.SAVE` dış çağrılara açık değildir; yalnız iç draft/final-review materializer revision yazar. Bu eksik değil, immutable revision sözleşmesini koruyan güvenlik sınırıdır. Native bridge aday promotion/dismissal, draft, Boby, approval, publication ve media repair akışlarını typed command olarak taşır; generic action channel kullanılmaz.

## Capability-gated dış kapılar

Codex/Luna Low gerçek oturum, GitHub device authorization/repository/required checks, hosting adapter/deploy workflow ve gerçek image provider yerel kodla uydurulamaz. Bu kapılarda OPE'nin `WAITING`, `DEGRADED` veya `UNAVAILABLE` göstermesi ve dış etkiyi başlatmaması gerekir. Bu durumları “backend tamamlandı” diye gizlemek ürün invariants'ına aykırı olur.

## 2026-08-16 doğrulama

- `npm.cmd run build`: başarılı; `ope-logo-v2` bundle'a dahil edildi.
- `npm.cmd run test:all`: 493 test, 492 başarılı, 0 başarısız, 1 atlandı.
- UI sözleşmesi ve ikon üretimi `ope-logo-v2.png` kaynağına güncellendi.

## Kapanış kapısı

Aşağıdaki komutlar bu denetimi tamamlamak için çalıştırılmalıdır:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build:engine
npm.cmd run smoke:engine
npm.cmd run security:verify
npm.cmd run native:test
npm.cmd run native:lint
npm.cmd run test:browser
npm.cmd run desktop:preflight -- --artifacts-dir apps/desktop/src-tauri/target/release/bundle
```

Bu rapor canlı Codex/GitHub/hosting hesabı veya temiz Windows makinesi kanıtı olmaksızın “her dış entegrasyon tamamlandı” iddiasında bulunmaz. Bu iddia ancak ilgili connector yetkilendirilip gerçek read-only check, dry-run ve approval-bound publication testleri kaydedildiğinde yapılabilir.
## Final local package evidence

- `npm.cmd run check:all`: başarılı; Node 493 testte 492 pass/0 fail/1 skip, lint, typecheck, frontend build, engine build/smoke, security verify, native 130 pass ve clippy `-D warnings` başarılı.
- `npm.cmd run test:browser`: 135/135 başarılı.
- `npm.cmd run icons:generate`: OPE logo v2 kaynağıyla favicon ve Tauri ikonlarını üretti.
- `npm.cmd run desktop:preflight -- --artifacts-dir apps/desktop/src-tauri/target/release/bundle`: tüm kontroller başarılı.
- MSI: `apps/desktop/src-tauri/target/release/bundle/msi/OPE_0.1.31_x64_en-US.msi`
  - SHA-256: `6A181ED848B0E95FF19F6DB8D6C7D3F43CCC07EB902613619A6E0DF0A98F73F8`
- NSIS: `apps/desktop/src-tauri/target/release/bundle/nsis/OPE_0.1.31_x64-setup.exe`
  - SHA-256: `7022AB8D46A11A1A299AFF4CAC334CA3D9AB2F44BE2ED6B163FB884C4AEA0CBB`

Bu teslim yerel olarak doğrulanmış kaynak ve paket durumudur. Commit, push, GitHub Release, canlı Codex/GitHub/hosting authorization veya production publication bu denetimde yapılmamıştır.
## CI follow-up

GitHub Verify run `31912997995` on `a95cdac` exposed two native fixture failures, both caused by a 10-second Python descendant startup timeout on the hosted Windows runner. The fixture now uses a bounded 30-second wait, checks whether the child exited early, and polls at 50 ms. Local verification after the fix: native tests 130/130 and clippy clean.