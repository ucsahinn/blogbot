# OPE uçtan uca tamamlanma ve kanıt denetimi

Tarih: 2026-08-17

Bu denetim, OPE masaüstü uygulamasının yerel backend, Tauri bridge, editoryal akış, Boby, updater, UI ve paketleme yüzeylerini mevcut çalışma ağacındaki kod ve çalıştırılmış kanıtlarla eşleştirir. Testlerin yeşil olması gerçek Codex, GitHub, ImageGen hesabı veya temiz Windows makinesi kanıtı olarak yorumlanmaz.

## Ürün sınırı ve değişmez kurallar

- OPE Windows üzerinde local-first çalışır; engine, PGlite ve durable queue yerel source of truth'tur.
- Dış kaynak yalnız kanıttır; kaynağın gövdesi yayın metni olarak kopyalanmaz.
- Yayın, tam immutable revision hash'i ve insan onayı olmadan gerçekleşemez.
- Revision, kaynak/iddia, medya, adapter, hedef veya zaman değişirse önceki önizleme ve onay geçersizdir.
- Codex, GitHub, hosting ve ImageGen bağlantısı yoksa UI `WAITING`, `DEGRADED`, `UNAVAILABLE` veya `NOT_CONFIGURED` gösterir; dış etki başlatılmaz.
- CMD/console pencereleri kullanıcıya açılmaz; native yardımcı süreçler `CREATE_NO_WINDOW` ile başlatılır.

## Faz matrisi

| Faz | Yerel kod ve kanıt | Durum | Eksik canlı kanıt / koşul |
|---|---|---|---|
| Runtime/Doctor | engine stdio protocol, Tauri bridge, `smoke:engine` | PASS | temiz makine ve restart/forced-close kanıtı |
| PGlite/encryption/identity | encrypted JSON, source repository, secure store, native tests | PASS | yeni Windows kullanıcı profilinde upgrade/restore |
| Durable queue/recovery | local queue, PGlite Codex store, outbox worker, restart tests | PASS | GUI zorla kapanma sonrası gerçek kullanıcı profili |
| Source URL/RSS/Atom/sitemap/OPML | fetcher, SSRF policy, source scan integration tests | PASS | canlı read-only URL seti |
| Source save/review/scan | typed source commands, native/browser contracts | PASS | gerçek kullanıcının kaynak havuzu |
| Candidate/dedupe/promotion | bounded candidate projection, corroboration and promotion tests | PASS | gerçek yayın akışında kalite ölçümü |
| Draft creation | DRAFT.CREATE, Codex task resolver, review-only materializer | PASS / Codex gated | gerçek Codex login ve completed output |
| Boby/Luna Low | BOBY.GUIDE, persistent session, status polling, offline local fallback | PASS / runtime gated | gerçek Codex/Luna Low oturumu |
| TR/EN revision | final-review materializer, parity gates, revision list/get | PASS / Codex gated | gerçek bilingual Codex output |
| Claims/evidence/SEO | typed quality gates, claim evidence and final review tests | PASS fail-closed | farklı haber türleriyle canlı kalibrasyon |
| ImageGen/media | ImageGen provider, bounded prompt, output hashing, media repair | PASS / provider gated | `BLOGBOT_IMAGEGEN_API_KEY` ile gerçek provider/materialization |
| Approval | exact revision hash, normal/high-risk approval, secure store | PASS | ikinci Windows onayının gerçek kullanıcı profili |
| Publication preview | V2 bundle, adapter policy, revision/approval/hash checks | PASS | gerçek seçili adapter dry-run |
| Publication/outbox | native GitHub broker, idempotent effects and reconciliation | PASS / broker gated | GitHub auth, required checks, deploy workflow |
| Backup/restore | encrypted portable backup, retention, secure restore filesystem | PASS | yeni Windows profilinde gerçek restore |
| Diagnostics | redacted engine/bridge/startup logs, directory export/open | PASS locally | installed app klasör açma ve gerçek incident package |
| Unsigned updater | HTTPS + SHA-256 manifest, visible bootstrapper and failure timeout | PASS locally | gerçek release handoff/upgrade on clean machine |
| UI/accessibility/responsive | all primary routes, keyboard, a11y, overflow/zoom tests | PASS | human visual review on additional desktop scales |
| Native packaging | Tauri exe/MSI/NSIS, WebView2 bootstrapper, preflight | PASS | clean Windows install/upgrade/rollback |

## Güncel doğrulama kanıtı

- `npm.cmd test`: 494 test, 493 pass, 0 fail, 1 skip.
- `npm.cmd run lint`: PASS.
- `npm.cmd run typecheck`: PASS.
- `npm.cmd run native:lint`: PASS (`clippy -D warnings`).
- `cargo test --lib`: 130 pass, 0 fail.
- `npm.cmd run smoke:engine`: Doctor `READY`; PGlite ve durable queue `ready`.
- `npm.cmd run security:verify`: security scan 0 finding, npm audit 0 vulnerability, gitleaks 0 leak.
- `npm.cmd run test:browser`: 135/135 pass.
- Gerçek Tauri/WebView smoke: `PASS`; engine/PGlite/worker healthy, bridge error yok, tüm ana rotalar 11–140 ms render.
- Native smoke gerçek durum: Codex `DEGRADED/UNAVAILABLE`, GitHub `NOT_CONFIGURED`, site adapter `DEGRADED`; bu durumlar başarıya çevrilmedi.
- `npm.cmd run desktop:preflight -- --artifacts-dir apps/desktop/src-tauri/target/release/bundle`: tüm kontroller PASS.

## Bu turdaki kök neden düzeltmeleri

### ImageGen bridge aktarımı

ImageGen provider `BLOGBOT_IMAGEGEN_API_KEY` okuyordu ancak Tauri sidecar ortam allowlist'inde bulunmadığı için paketlenmiş engine'e ulaşamıyordu. Allowlist'e yalnızca açıkça yapılandırılmış `BLOGBOT_IMAGEGEN_API_KEY` ve `BLOGBOT_IMAGEGEN_MODEL` eklendi. Anahtar PGlite, ayarlar veya tanı paketine yazılmaz; test allowlist'in yalnızca bu explicit istisnayı kabul ettiğini doğrular.

### Boby offline tekrar hatası

Codex/Luna Low hazır değilken her kullanıcı sorusu aynı başarısızlık mesajına düşüyordu. Boby artık bağlantı yokken kaynak, aday, taslak, SEO, inceleme, yayın, güncelleme ve tanı soruları için local-only, dış etki başlatmayan somut rehberlik verir. Codex hazır olduğunda gerçek Boby oturumu ve aynı konuşma polling akışı korunur.

### Updater görünürlük ve takılma koruması

Kapanış sonrası bootstrapper ayrı checklist, durum işaretleri ve progress bar gösterir: paket doğrulama, uygulama kapanması, sihirbaz başlangıcı, kurulum ve yeniden açılış. Ana uygulama 60 saniyede kapanmazsa sonsuz bekleme yerine açıklanabilir hata gösterir. Installer görünür başlatılır; launcher console penceresi açmaz.

## Kalan gerçek kapılar

Aşağıdaki maddeler kaynak kod veya sahte credential ile “tamamlandı” sayılamaz:

1. Codex/Luna Low hesabının bu Windows kullanıcı profiline bağlanması ve gerçek Boby + draft output smoke'u.
2. ImageGen anahtarının güvenli çalışma ortamına açıkça verilmesi ve gerçek görselin revision media package'a materialize edilmesi.
3. GitHub device authorization, repo/branch/required-check dry-run ve gerçek deploy workflow reconciliation.
4. Gerçek seçilmiş site adapter ile publication preview ve insan onay hash'ine bağlı enqueue.
5. Temiz Windows makinesinde kurulum, upgrade, rollback ve updater bootstrapper handoff.

Bu kapılar hazır olmadığında beklenen davranış OPE'nin bloke/degraded görünmesidir; bunları yerel test sonucu varmış gibi raporlamak ürün güvenlik sözleşmesine aykırıdır.

## Paket kanıtı

Güncel yerel build sürümü kaynakta `0.1.34` olarak paketlendi:

- exe: `apps/desktop/src-tauri/target/release/blogbot.exe`
  - SHA-256: `83A3CBF8D90F268F65299DC36356919A2174FC5F512792574DDABBBAB195C3AD`
- NSIS: `apps/desktop/src-tauri/target/release/bundle/nsis/OPE_0.1.34_x64-setup.exe`
  - SHA-256: `01A48C82B9CCEE2CEB460BACBED256A9B3583D6B759822BAEECD04B401C7D302`
- MSI: `apps/desktop/src-tauri/target/release/bundle/msi/OPE_0.1.34_x64_en-US.msi`
  - SHA-256: `A28B6F1AD9E52526547F904940EA2C5426E81BDE8886732C8F30EAF8450F649D`

Bu paketler bu turda yerel olarak üretildi; commit/push/release işlemi ayrıca doğrulanmalıdır.