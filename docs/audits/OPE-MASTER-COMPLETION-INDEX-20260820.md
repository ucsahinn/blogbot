# OPE master completion index — 2026-08-20

Bu belge, Blogbot'un 2026-08-20 tarihli **yerel tamamlama referansıdır** ve
2026-08-19 tarihli master indeks ile backend denetimini tarihsel başlangıç
noktası olarak supersede eder. Kanıt matrisi 2026-08-21 tarihinde OPE 0.1.38
yerel kaynak kapıları, GitHub Release ve canlı updater sonuçlarıyla yenilenmiştir. Eski belgeler
silinmedi veya yeniden yazılmadı.

## Sonuç

- Canonical denetim 183 iddia üretti; bağımsız incelemede 151'i doğrulandı.
- İlk düzeltme turunda 43 doğrulanmış bulgu kapatıldı.
- Kalan 108 bulgunun tamamı bu çalışma alanında giderildi:
  **108/108 `CLOSED_LOCAL`** (1 kritik, 7 yüksek, 42 orta, 58 düşük).
- Bu durum yalnız yerel kaynak, regresyon testi ve gözlenen yerel komut
  kanıtıdır. GitHub Release ve updater feed kanıtları ayrıca canlı doğrulanmıştır;
  sağlayıcı, site, kurulum, deploy ve uzun süreli zamanlayıcı kapıları ayrı tutulur.
- OPE desktop 0.1.38, target SHA `e28bd1336c7034d76c54746a5be52bb2c9b92c86` ile
  [GitHub Release v0.1.38](https://github.com/ucsahinn/blogbot/releases/tag/v0.1.38) olarak yayınlandı.
- [PR #1](https://github.com/ucsahinn/blogbot/pull/1) ve
  [PR #2](https://github.com/ucsahinn/blogbot/pull/2) merge edildi; release ve updater
  asset'ları yayınlandı. Deploy, production URL, Search Console veya installed kabul yapılmadı.

`CLOSED_LOCAL`, code finding'in kaynakta giderildiği ve aşağıdaki regresyon
ailesinin mevcut olduğu anlamına gelir; bir dış kapının çalıştırıldığı anlamına
gelmez. Dış kapısı olmayan satırlarda `Yok` yazılır.

## Regresyon ailesi anahtarı

| Aile | Başlıca test kanıtı |
|---|---|
| `BACKUP` | `tests/integration/logical-backup.test.ts`, `tests/integration/portable-backup.test.ts`, `tests/unit/engine-stdio.test.ts` ve native secure-fs/command testleri |
| `CODEX` | `tests/unit/codex-draft-review.test.ts`, `tests/integration/pipeline-codex.test.ts`, `tests/integration/engine-editorial-protocol.test.ts`, codex-runner testleri |
| `DB` | `tests/unit/persistence-fixes.test.ts`, `tests/integration/source-repository.test.ts`, PGlite entegrasyon testleri |
| `PUB` | publication preview/outbox/scheduler testleri, `tests/integration/production-publication-composition.test.ts` ve native GitHub testleri |
| `DESKTOP` | desktop bridge/model/contract testleri, browser suite ve native command testleri |
| `CONTRACT` | contracts, revision approval, quality gates, site-adapter ve visual-policy testleri |
| `RUNTIME` | engine stdio/workflow/queue testleri ile native bridge testleri |
| `SEC` | URL, Markdown, source-document ve fetcher boundary testleri |

## 108 bulguluk kapatma defteri

### Kritik — 1/1 `CLOSED_LOCAL`

| ID | Yerel kapatma | Kaynak | Regresyon | Dış kapı |
|---|---|---|---|---|
| C1 | Canlı PGlite dosya yürüyüşü yerine doğrulanabilir mantıksal yedek üretimi | `packages/backup/src/logical-backup.ts`; `apps/engine/src/stdio-entrypoint.ts` | `BACKUP` | `UNVERIFIED_EXTERNAL`: temiz profil restore |

### Yüksek — 7/7 `CLOSED_LOCAL`

| ID | Yerel kapatma | Kaynak | Regresyon | Dış kapı |
|---|---|---|---|---|
| H1 | Gecikmiş günlük yedek için açılış catch-up ve tekil zamanlama | `apps/engine/src/stdio-entrypoint.ts` | `BACKUP` | `UNVERIFIED_EXTERNAL`: 24 saatlik gerçek zamanlayıcı |
| H2 | İddia kanıtı artık iddiaya özgü alıntı aralığı ve hash taşıyor | `apps/engine/src/codex-draft.ts`; `packages/editorial/src/revision.ts` | `CODEX`, `CONTRACT` | `UNVERIFIED_EXTERNAL`: canlı Codex ve gerçek haber havuzu |
| H3 | `publication-target` kapısı sabit sözleşmeye alındı; ekstra kapılar paketi bozmuyor | `apps/engine/src/codex-draft.ts`; `packages/editorial/src/revision.ts` | `CODEX`, `CONTRACT` | Yok |
| H4 | Otomatik ve manuel yedek doğrulaması yapısal olarak gerçek veri biçimine uyarlandı | `packages/backup/src/logical-backup.ts`; `apps/engine/src/stdio-entrypoint.ts` | `BACKUP` | `UNVERIFIED_EXTERNAL`: temiz profil restore |
| H5 | Dashboard iş/outbox penceresi UUID yerine monoton sıra ile en yeniyi seçiyor | `packages/database/src/pglite-backend-repository.ts` | `DB` | Yok |
| H6 | İş ve outbox yazımları sürüm/CAS ve ortak mutasyon sırası ile korunuyor | `packages/database/src/pglite-backend-repository.ts`; `apps/engine/src/stdio-entrypoint.ts` | `DB`, `RUNTIME` | Yok |
| H7 | `PUBLISH` için doğrulanmış branch/base SHA üreticisi ve kalıcı bağ kuruldu | `apps/desktop/src-tauri/src/commands.rs`; `apps/desktop/src-tauri/src/github_rest_adapter.rs`; `apps/engine/src/codex-draft.ts` | `PUB`, `CODEX` | `UNVERIFIED_EXTERNAL`: GitHub auth, gerçek base SHA ve branch |

### Orta — 42/42 `CLOSED_LOCAL`

| ID | Yerel kapatma | Kaynak | Regresyon | Dış kapı |
|---|---|---|---|---|
| M1 | Tanılama paketindeki başlık ve plan ayrıntıları allowlist/redaction ile sınırlandı | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP` | Yok |
| M2 | Native restore child süreci stdin hatası, timeout ve kill ile fail-closed | `apps/engine/src/stdio-entrypoint.ts` | `BACKUP`, `RUNTIME` | `UNVERIFIED_EXTERNAL`: temiz profil restore |
| M3 | Restore hedefi staging + atomic rename ile ya tamamen oluşuyor ya geri alınıyor | `apps/desktop/src-tauri/src/secure_preview_fs.rs` | `BACKUP` | `UNVERIFIED_EXTERNAL`: temiz profil restore |
| M4 | `backup.*` istekleri bakım timeout sınıfına alındı | `apps/desktop/src-tauri/src/engine_bridge.rs` | `BACKUP`, `RUNTIME` | Yok |
| M5 | Yarım kalan Boby Codex işleri bounded recovery ile toparlanıyor | `apps/engine/src/stdio-entrypoint.ts` | `CODEX`, `RUNTIME` | `UNVERIFIED_EXTERNAL`: canlı Codex session |
| M6 | `DENIED_EVENT` izolasyon duruşu kalıcı kodla işaretleniyor ve yeniden oynatılmıyor | `apps/engine/src/stdio-entrypoint.ts` | `CODEX` | `UNVERIFIED_EXTERNAL`: canlı Codex izolasyon olayı |
| M7 | Süre dolumu process close sonrasında da timeout sonucuna üstün geliyor | `apps/codex-runner/src/cli-port.ts` | `CODEX` | `UNVERIFIED_EXTERNAL`: canlı Codex process timeout |
| M8 | Codex binary yolu oturum içinde yeniden keşfedilebiliyor | `apps/desktop/src-tauri/src/engine_bridge.rs`; `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP`, `CODEX` | `UNVERIFIED_EXTERNAL`: gerçek Codex login/runtime |
| M9 | Aday durumu durable draft işinden türetiliyor; ikinci yazım arızası tekrar üretmiyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/engine/src/stdio-entrypoint.ts` | `DESKTOP`, `RUNTIME` | Yok |
| M10 | Eksik `deploy` önkoşulu başarı sayılmıyor; açıkça `MISSING` üretiliyor | `apps/desktop/src/app-model.ts`; `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP` | `UNVERIFIED_EXTERNAL`: gerçek deploy hedefi |
| M11 | Ölçülmeyen Windows/WebView2/saat koşulları dürüst `ATTENTION` durumu veriyor | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP` | `UNVERIFIED_EXTERNAL`: temiz Windows önkoşul ölçümü |
| M12 | Başarılı backup verify kaydı önkoşul durumuna kalıcı olarak yansıyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/engine/src/stdio-entrypoint.ts` | `BACKUP`, `DESKTOP` | `UNVERIFIED_EXTERNAL`: kullanıcı arşiviyle restore provası |
| M13 | Aday/düzenleme komutları sağlayıcı durumuna göre açık visual policy taşıyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/engine/src/codex-draft.ts` | `CONTRACT`, `DESKTOP` | `UNVERIFIED_EXTERNAL`: ImageGen provider |
| M14 | Engine'in kabul ettiği komutlar ortak contract doğrulamasına eklendi | `packages/contracts/src/index.ts`; `apps/engine/src/stdio-entrypoint.ts` | `CONTRACT` | Yok |
| M15 | Broker claim anında dosya byte/hash değerleri onaylı manifestle yeniden eşleşiyor | `apps/engine/src/stdio-entrypoint.ts` | `PUB`, `CONTRACT` | Yok |
| M16 | Sıfır iddialı taslak schema ve final gate düzeyinde reddediliyor | `apps/engine/src/codex-draft.ts` | `CODEX`, `CONTRACT` | Yok |
| M17 | V3 kalite değerlendirmeleri final revision ve approval yoluna bağlandı | `packages/editorial/src/quality-gates.ts`; `apps/engine/src/codex-draft.ts` | `CONTRACT`, `CODEX` | `UNVERIFIED_EXTERNAL`: gerçek içerik kalibrasyonu |
| M18 | Approval revoke, onayı silmek yerine immutable revocation kaydı ekliyor; yayın öncesi final kontrol bu kaydı fail-closed uyguluyor | `packages/contracts/src/index.ts`; `packages/database/src/backend-repository.ts`; `packages/database/src/pglite-backend-repository.ts`; `packages/database/src/in-memory-backend-store.ts`; `apps/engine/src/stdio-entrypoint.ts` | `CONTRACT`, `PUB` | Yok |
| M19 | SEO ve contradiction model beyanlarına deterministik yerel backstop eklendi | `apps/engine/src/codex-draft.ts`; `packages/editorial/src/quality-gates.ts` | `CODEX`, `CONTRACT` | `UNVERIFIED_EXTERNAL`: gerçek içerik kalibrasyonu |
| M20 | Makale türü seçilen bölümün sözleşmesinden türetiliyor | `apps/engine/src/codex-draft.ts`; `packages/contracts/src/index.ts` | `CODEX`, `CONTRACT` | Yok |
| M21 | Restore writer stdin yazımını ve child sonucunu ayrı ayrı onaylıyor | `apps/engine/src/stdio-entrypoint.ts` | `BACKUP`, `RUNTIME` | `UNVERIFIED_EXTERNAL`: temiz profil restore |
| M22 | Çalıştırıcı olmayan `JOB.RETRY` başarı raporlamıyor ve state silmiyor | `apps/engine/src/stdio-entrypoint.ts` | `CODEX`, `RUNTIME` | Yok |
| M23 | Taslak kanıt toplama ortak, komut timeout'undan kısa toplam bütçe ile sınırlı | `apps/engine/src/stdio-entrypoint.ts`; `apps/engine/src/codex-draft.ts` | `CODEX`, `RUNTIME` | `UNVERIFIED_EXTERNAL`: yavaş gerçek kaynaklar |
| M24 | Retention purge sonrası latest işaretçisi hayatta kalan en yeni kayda taşınıyor | `packages/database/src/source-repository.ts` | `DB` | Yok |
| M25 | Retention purge keyset pagination ve sınırlı batch kullanıyor | `packages/database/src/source-repository.ts` | `DB` | Yok |
| M26 | Büyük legacy migrasyonları bounded keyset sayfalarıyla ilerliyor | `packages/database/src/pglite-backend-repository.ts` | `DB` | `UNVERIFIED_EXTERNAL`: büyük gerçek profil yükseltmesi |
| M27 | Legacy plaintext yalnız tabloya özgü yapısal doğrulamadan sonra yeniden mühürleniyor | `packages/database/src/encrypted-json.ts`; `packages/database/src/pglite-backend-repository.ts` | `DB` | `UNVERIFIED_EXTERNAL`: eski gerçek profil migrasyonu |
| M28 | Başarısız required check terminal yayın hatası oluyor; sonsuz polling yok | `apps/desktop/src-tauri/src/github_publication.rs`; `apps/desktop/src-tauri/src/commands.rs` | `PUB` | `UNVERIFIED_EXTERNAL`: GitHub check failure |
| M29 | GitHub `skipped` ve `neutral` sonuçları publisher sözleşmesiyle uyumlu | `apps/desktop/src-tauri/src/github_rest_adapter.rs` | `PUB` | `UNVERIFIED_EXTERNAL`: GitHub checks |
| M30 | Stale outbox etkisi terminal duruma geçiyor; sonsuz reclaim yok | `apps/engine/src/stdio-entrypoint.ts`; `apps/engine/src/publication-outbox-worker.ts` | `PUB`, `RUNTIME` | Yok |
| M31 | Native local-state CAS retry ilk çatışmada güncel değeri bir kez bounded olarak yeniden okuyup mutasyonu yeniden uyguluyor | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP`, `RUNTIME` | Yok |
| M32 | Tauri app exit, tray ve update yolları ortak cleanup üzerinden sahip olunan engine/local-dev süreçlerini bounded olarak temizliyor | `apps/desktop/src-tauri/src/lib.rs`; `apps/desktop/src-tauri/src/tray.rs`; `apps/desktop/src-tauri/src/unsigned_updater.rs`; `apps/desktop/src-tauri/src/engine_bridge.rs`; `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP`, `RUNTIME` | `UNVERIFIED_EXTERNAL`: installed app exit/tray/update |
| M33 | Updater payload'u çalıştırmadan hemen önce tekrar doğrulanıyor | `apps/desktop/src-tauri/src/unsigned_updater.rs` | `DESKTOP` | `UNVERIFIED_EXTERNAL`: installed updater/rollback |
| M34 | Tanılama ve UI kısaltmaları Unicode code point sınırını bozmuyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/desktop/src` | `DESKTOP` | Yok |
| M35 | Publication pause/fault broker döngüsünü ve UI durumunu dürüstçe durduruyor | `apps/desktop/src-tauri/src/github_broker.rs`; `apps/desktop/src-tauri/src/commands.rs` | `PUB`, `DESKTOP` | `UNVERIFIED_EXTERNAL`: GitHub broker fault |
| M36 | Normal approval grant/revoke komutlarının idempotency anahtarları kullanıcı onayı sonrası gözlenen CAS/version değerini içeriyor | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP`, `CONTRACT` | `UNVERIFIED_EXTERNAL`: gerçek Windows confirmation |
| M37 | Engine ve local-dev logları boyut/adet sınırıyla rotate ediliyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/desktop/src-tauri/src/engine_bridge.rs` | `DESKTOP`, `RUNTIME` | `UNVERIFIED_EXTERNAL`: uzun süreli installed kullanım |
| M38 | Değiştirilen/superseded revision farkı predecessor üzerinden doğrulanıyor | `apps/engine/src/codex-draft.ts`; `packages/editorial/src/revision.ts` | `CODEX`, `CONTRACT` | Yok |
| M39 | Kapatılmış PR yayın başarısı sayılmıyor | `apps/desktop/src-tauri/src/github_rest_adapter.rs`; `apps/desktop/src-tauri/src/github_publication.rs` | `PUB` | `UNVERIFIED_EXTERNAL`: gerçek kapalı PR |
| M40 | Merge sonucu `merge_sha` ile beklenen head/base bağlarına karşı doğrulanıyor | `apps/desktop/src-tauri/src/github_rest_adapter.rs`; `apps/desktop/src-tauri/src/github_publication.rs` | `PUB` | `UNVERIFIED_EXTERNAL`: GitHub merge |
| M41 | Publication lease CAS ile claim/renew/complete sahibine bağlandı | `packages/database/src/pglite-backend-repository.ts`; `apps/engine/src/publication-outbox-worker.ts` | `DB`, `PUB` | Yok |
| M42 | Yayın enqueue UI thread'i bloklamadan durable queue'ya bırakılıyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/engine/src/stdio-entrypoint.ts` | `DESKTOP`, `PUB` | Yok |

### Düşük — 58/58 `CLOSED_LOCAL`

| ID | Yerel kapatma | Kaynak | Regresyon | Dış kapı |
|---|---|---|---|---|
| L1 | Retention yalnız otomatik yedeklerde çalışıyor; manuel arşivleri silmiyor | `apps/engine/src/stdio-entrypoint.ts`; `packages/backup/src/retention.ts` | `BACKUP` | Yok |
| L2 | Retention arızası başarılı yedek sonucunu geri almıyor, ayrı tanılanıyor | `apps/engine/src/stdio-entrypoint.ts` | `BACKUP` | Yok |
| L3 | Secure preview filesystem kök `HANDLE` sahipliği açık; başarı ve hata yollarında handle sızıntısı yok | `apps/desktop/src-tauri/src/secure_preview_fs.rs` | `BACKUP`, `DESKTOP` | `UNVERIFIED_EXTERNAL`: temiz profil restore |
| L4 | Manuel ve otomatik yedek, random UUID temp adına yazıp sibling hard-link ile atomik no-replace commit eden tek helper'ı kullanıyor; outer `finally` ENOSPC/IO sonrası kısmi temp'i temizliyor, exclusive temp-create `EEXIST` ise başka writer'ın dosyasını silmiyor | `apps/engine/src/stdio-entrypoint.ts`; `tests/unit/engine-stdio.test.ts` | `BACKUP`, `RUNTIME` | `UNVERIFIED_EXTERNAL`: gerçek backup klasörü |
| L5 | Tanılama arşiv adları çakışmaya dayanıklı benzersiz kimlik taşıyor | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP` | Yok |
| L6 | Codex CLI yeteneği per-command açıkça kapatılabiliyor | `apps/codex-runner/src/cli-port.ts`; `apps/codex-runner/src/structured-runner.ts` | `CODEX` | `UNVERIFIED_EXTERNAL`: gerçek Codex CLI |
| L7 | Production yayın dizininde tehlikeli/geçici prefix'ler fail-closed | `packages/site-adapter/src/astro-generic.ts`; `apps/engine/src/publication-preview.ts` | `PUB`, `CONTRACT` | Yok |
| L8 | Malformed veya aşırı uzun runner stream satırları sınırda reddediliyor | `apps/codex-runner/src/cli-port.ts` | `CODEX`, `SEC` | `UNVERIFIED_EXTERNAL`: gerçek bozuk Codex stream |
| L9 | İşlem ve tarama kimlikleri çakışmaya dayanıklı UUID/counter kullanıyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/engine/src/stdio-entrypoint.ts` | `DESKTOP`, `RUNTIME` | Yok |
| L10 | Codex app-owned session'ları 14 gün ve en fazla 32 kayıtla bounded tutuluyor | `apps/codex-runner/src/cli-port.ts` | `CODEX` | `UNVERIFIED_EXTERNAL`: 14 günlük gerçek session retention |
| L11 | ImageGen yokken açık provenance'lı yerel görsel fallback kullanılır | `packages/visuals/src/index.ts`; `apps/engine/src/stdio-entrypoint.ts` | `CONTRACT` | `UNVERIFIED_EXTERNAL`: ImageGen provider |
| L12 | Kullanılmayan/gereksiz IPC izin yüzeyi kaldırıldı | `apps/desktop/src-tauri/permissions/default.toml`; `apps/desktop/src-tauri/src/lib.rs` | `DESKTOP`, `SEC` | Yok |
| L13 | Yalnız onaylı site-adapter resolver'ı seçilebiliyor; bilinmeyen adapter engine ve desktop'ta fail-closed | `packages/site-adapter/src/index.ts`; `packages/site-adapter/src/astro-generic.ts`; `apps/engine/src/codex-draft.ts`; `apps/engine/src/stdio-entrypoint.ts`; `apps/desktop/src/publication-files.ts` | `CONTRACT`, `PUB` | `UNVERIFIED_EXTERNAL`: gerçek site adapter hedefi |
| L14 | Native IPC sözleşmesi ve smoke gerçek komut isimlerini doğruluyor | `scripts/native-webview-smoke.mjs`; `apps/desktop/src/bridge.ts` | `DESKTOP` | `UNVERIFIED_EXTERNAL`: installed native WebView smoke |
| L15 | Mimari ve operasyon belgeleri yerel/uzak sınırıyla eşitlendi | `docs/architecture/system.md`; `docs/operations/github-actions-deploy.md` | `CONTRACT` | `UNVERIFIED_EXTERNAL`: GitHub/site yapılandırması |
| L16 | High-risk Windows reauth kısa zaman penceresine bağlandı | `apps/engine/src/stdio-entrypoint.ts`; `apps/desktop/src-tauri/src/commands.rs` | `CONTRACT`, `DESKTOP` | `UNVERIFIED_EXTERNAL`: gerçek Windows confirmation |
| L17 | Bridge, engine ve belgeler 1.000.000 bayt NDJSON sınırında eşitlendi | `apps/desktop/src-tauri/src/engine_bridge.rs`; `apps/engine/src/stdio-entrypoint.ts`; `README.md` | `RUNTIME`, `CONTRACT` | Yok |
| L18 | Görsel üretim provenance'ı revision hash ve incelemeye dahil | `packages/visuals/src/index.ts`; `apps/engine/src/stdio-entrypoint.ts`; `packages/editorial/src/revision.ts` | `CONTRACT` | `UNVERIFIED_EXTERNAL`: ImageGen provider |
| L19 | V2/V3 media sözleşmesi gerçek shape, byteSize ve hero zorunluluğuyla uyumlu | `packages/contracts/src/index.ts`; `packages/editorial/src/revision.ts` | `CONTRACT` | Yok |
| L20 | Canonical JSON prototype anahtarlarını sessizce yutmuyor | `packages/editorial/src/revision.ts` | `CONTRACT`, `SEC` | Yok |
| L21 | Media repair yerel fallback'i ImageGen başarısı gibi damgalamıyor | `apps/engine/src/stdio-entrypoint.ts`; `packages/visuals/src/index.ts` | `CONTRACT` | `UNVERIFIED_EXTERNAL`: ImageGen failure |
| L22 | Superseded/başarısız revision media dizinleri bounded prune ediliyor | `apps/engine/src/stdio-entrypoint.ts`; `packages/visuals/src/index.ts` | `CONTRACT`, `RUNTIME` | `UNVERIFIED_EXTERNAL`: uzun süreli gerçek media üretimi |
| L23 | Zorunlu gate'ler korunurken ek gate'ler geçerli kabul ediliyor | `packages/editorial/src/revision.ts` | `CONTRACT` | Yok |
| L24 | Rust bridge response protocol version'ını da doğruluyor | `apps/desktop/src-tauri/src/engine_bridge.rs` | `RUNTIME`, `DESKTOP` | Yok |
| L25 | Site artifact translation key ve hash normalizasyonu doğrulanıyor | `packages/site-adapter/src/artifact.ts` | `CONTRACT`, `PUB` | Yok |
| L26 | Üretilen görsel byteSize tek okuma sonucundan kalıcılaştırılıyor | `packages/visuals/src/index.ts`; `apps/engine/src/stdio-entrypoint.ts` | `CONTRACT` | Yok |
| L27 | Scheduler tek bozuk revision yüzünden diğerlerini engellemiyor | `apps/engine/src/publication-scheduler.ts` | `PUB` | Yok |
| L28 | Otomatik backup/restore komutları maintenance timeout kullanıyor | `apps/desktop/src-tauri/src/engine_bridge.rs` | `BACKUP`, `RUNTIME` | Yok |
| L29 | `media.read` hata kodları sabit, mesajları ayrı ve redakte | `apps/engine/src/stdio-entrypoint.ts` | `RUNTIME`, `CONTRACT` | Yok |
| L30 | In-memory enqueue change feed olayı üretiyor | `packages/database/src/in-memory-backend-store.ts` | `DB`, `PUB` | Yok |
| L31 | Source scan completion değeri ve kalıcı kayıt aynı anda kuruluyor | `packages/database/src/source-repository.ts` | `DB` | Yok |
| L32 | Deploy intent marker yeniden denemede duplicate dispatch'i önlüyor | `apps/desktop/src-tauri/src/github_rest_adapter.rs`; `apps/desktop/src-tauri/src/github_publication.rs` | `PUB` | `UNVERIFIED_EXTERNAL`: gerçek GitHub workflow dispatch |
| L33 | PR head SHA onaylı publication effect'e bağlanıyor | `apps/desktop/src-tauri/src/github_rest_adapter.rs`; `apps/desktop/src-tauri/src/github_publication.rs` | `PUB` | `UNVERIFIED_EXTERNAL`: GitHub PR head mutation |
| L34 | Onaylı dosya ve preview digest sırası UTF-8 byte düzeninde ortak | `apps/engine/src/stdio-entrypoint.ts`; `apps/engine/src/publication-preview.ts`; `apps/desktop/src-tauri/src/github_publication.rs` | `PUB`, `CONTRACT` | Yok |
| L35 | Başarılı yayın sonrası branch/ref temizliği bounded ve best-effort | `apps/desktop/src-tauri/src/github_rest_adapter.rs`; `apps/desktop/src-tauri/src/github_publication.rs` | `PUB` | `UNVERIFIED_EXTERNAL`: gerçek GitHub ref cleanup |
| L36 | Scheduler yalnız ilgili due revision state/outbox kayıtlarını seçiyor | `packages/database/src/pglite-backend-repository.ts`; `apps/engine/src/publication-scheduler.ts` | `DB`, `PUB` | Yok |
| L37 | Terminal bekleme nedenleri restart'ta tekrar QUEUED yapılmıyor | `apps/engine/src/pglite-codex-job-store.ts`; `apps/engine/src/stdio-entrypoint.ts` | `CODEX`, `DB` | `UNVERIFIED_EXTERNAL`: canlı Codex retry sınırı |
| L38 | Approval expectedVersion, kullanıcı onayından sonra okunuyor | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP`, `CONTRACT` | `UNVERIFIED_EXTERNAL`: gerçek Windows confirmation |
| L39 | Revision media okuması 32 MiB ve pozitif byteSize sınırı uyguluyor | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP`, `SEC` | Yok |
| L40 | Büyük broker claim/media istekleri bakım timeout ve response sınırı kullanıyor | `apps/desktop/src-tauri/src/engine_bridge.rs`; `apps/engine/src/stdio-entrypoint.ts` | `RUNTIME`, `PUB` | Yok |
| L41 | Local-dev stop degraded durumda da çalışıyor ve app exit'te sahipli process kapanıyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/desktop/src-tauri/src/lib.rs` | `DESKTOP` | `UNVERIFIED_EXTERNAL`: gerçek app exit |
| L42 | Secure-store key aday sırası tek, açık ve test edilebilir hale getirildi | `apps/desktop/src-tauri/src/secure_store.rs` | `DESKTOP`, `SEC` | `UNVERIFIED_EXTERNAL`: gerçek Windows DPAPI profili |
| L43 | Şifreli backup önkoşulu verified/restore-preview gözlemlerini engine'in döndürdüğü aynı 64-hex `archiveSha256` değerine bağlıyor; farklı SHA iki timestamp'i resetliyor, hashesiz legacy kayıt `READY` sayılmıyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/engine/src/stdio-entrypoint.ts` | `BACKUP`, `DESKTOP` | `UNVERIFIED_EXTERNAL`: temiz profil restore |
| L44 | Tray canlı durum satırları ve review-ready bildirimi gerçek projection ile güncelleniyor | `apps/desktop/src-tauri/src/tray.rs`; `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP` | `UNVERIFIED_EXTERNAL`: installed tray/notification |
| L45 | Bildirim tercihi restart sonrası engine state'ten yeniden yükleniyor | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP` | `UNVERIFIED_EXTERNAL`: installed restart |
| L46 | Source scan operasyon kimliği nanosaniye + sayaçla çakışmaya dayanıklı | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP`, `RUNTIME` | Yok |
| L47 | Setup connector yalnız kullanıcı tarafından grant edilen klasörü inceleyebiliyor | `apps/desktop/src-tauri/src/commands.rs` | `DESKTOP`, `SEC` | `UNVERIFIED_EXTERNAL`: native folder picker grant |
| L48 | Branch protection 404 eyleme dönük fail-closed sonuca çevriliyor | `apps/desktop/src-tauri/src/github_rest_adapter.rs` | `PUB` | `UNVERIFIED_EXTERNAL`: korumasız gerçek GitHub branch |
| L49 | GitHub token kopyaları borrowed/zeroizing yaşam süresiyle sınırlandı | `apps/desktop/src-tauri/src/github_broker.rs`; `apps/desktop/src-tauri/src/github_rest_adapter.rs` | `PUB`, `SEC` | `UNVERIFIED_EXTERNAL`: gerçek GitHub auth |
| L50 | Yetki durumu yalnız dosya varlığına değil doğrulanmış token ve reauth sonucuna bağlı | `apps/desktop/src-tauri/src/github_broker.rs`; `apps/desktop/src-tauri/src/commands.rs` | `PUB`, `DESKTOP` | `UNVERIFIED_EXTERNAL`: revoked/expired GitHub token |
| L51 | GitHub ve update manifest response gövdeleri açık byte bütçeleriyle okunuyor | `apps/desktop/src-tauri/src/github_rest_adapter.rs`; `apps/desktop/src-tauri/src/unsigned_updater.rs` | `PUB`, `SEC` | `UNVERIFIED_EXTERNAL`: gerçek büyük/bozuk response |
| L52 | Publication drainer broker hatalarını yutmuyor; tanılamaya sabit kod yazıyor | `apps/desktop/src-tauri/src/commands.rs`; `apps/desktop/src-tauri/src/engine_bridge.rs` | `PUB`, `RUNTIME` | `UNVERIFIED_EXTERNAL`: gerçek broker fault |
| L53 | Root-anchored FQDN biçimi localhost/metadata hostname politikasını aşamıyor | `packages/security/src/url-policy.ts` | `SEC` | Yok |
| L54 | Percent-encoded ve katmanlı image path traversal reddediliyor | `packages/security/src/markdown-policy.ts` | `SEC` | Yok |
| L55 | Fetcher child HTTPS/hostname/IP/timeout/response sınırını kendi trust boundary'sinde doğruluyor | `apps/fetcher/src/sea-entrypoint.ts`; `packages/security/src/url-policy.ts` | `SEC` | `UNVERIFIED_EXTERNAL`: gerçek public HTTPS fetch |
| L56 | Ölü `../images/` allowance kaldırıldı; dokümanlanan allowlist enforcement ile aynı | `packages/security/src/markdown-policy.ts` | `SEC` | Yok |
| L57 | 6to4 ve Teredo üzerinden gömülü özel/link-local IPv4 atlatması engellendi | `packages/security/src/url-policy.ts` | `SEC` | Yok |
| L58 | DOCTYPE/ENTITY güvenlik kontrolü content sniff öncesinde her feed yoluna uygulanıyor | `packages/security/src/source-document.ts` | `SEC` | Yok |

## Faz ve final kapı matrisi

| Yüzey | Durum | 2026-08-20 final kanıtı | Kalan sınır |
|---|---|---|---|
| Canonical 108 bulgu | **108/108 `CLOSED_LOCAL`** | Kaynak ve regresyon aileleri yukarıda | Dış kapılar ayrı |
| OPE desktop sürümü | **0.1.38 RELEASED** | Üç manifest aynı sürümde; [v0.1.38](https://github.com/ucsahinn/blogbot/releases/tag/v0.1.38) target/tag SHA `e28bd1336c7034d76c54746a5be52bb2c9b92c86` | Artifact `NotSigned`; installed/production kabul ayrı |
| Node testleri | **PASS** | Final hotfix full suite: 762 toplam; 761 pass; 0 fail; 1 kasıtlı optional live Codex skip; 80794.3964 ms | Skip yalnız canlı Codex hesabı gerektirir |
| Codex probe/deadline/cache | **PASS** | Pipeline 39 toplam; 38 pass; 0 fail; 1 kasıtlı live Codex skip; 17631.9225 ms; deadline/probe focused 3/3; cache recovery/budget-key focused 2/2 | `apps/codex-runner/src/cli-port.ts` task deadline'dan bağımsız 5–10 saniyelik bounded probe bütçesini cache key'e dahil eder; yalnız aynı rejected promise'ı silerek in-flight dedupe'u korur ve retry'a izin verir |
| Browser testleri | **PASS** | Final full 142/142; 2.4 dakika | Installed kullanıcı profili kabulü değildir |
| TypeScript typecheck | **PASS** | `npm.cmd run typecheck` | Yok |
| Kaynak kapsamlı ESLint | **PASS** | `apps`, `packages`, `tests`, `scripts` ve config dosyaları temiz | Yok |
| Scratch temizliği | **PASS** | Onayla kalıcı silinen exact 79 untracked `.codex-*`: 75 patch + 4 CJS; kalan 0 | Kullanıcı açıkça onayladı |
| Canonical ESLint | **PASS** | `npm.cmd run lint` | Yok |
| Desktop production build | **PASS** | Fresh OPE 0.1.38 production build | Yerel artifact üretimidir |
| Engine/fetcher SEA build | **PASS** | `npm.cmd run build:engine` | Kurulum paketi değildir |
| Engine smoke | **PASS** | `READY`; PGlite ready; queue ready | Installed EXE değildir |
| Fetcher smoke | **PASS** | Beklenen invalid-plan sonucu `FETCHER_REQUEST_FAILED` | Gerçek public HTTPS fetch ayrıca dış kapıdır |
| Security verify | **PASS** | `security:scan` 0 bulgu; offline npm audit 0 vulnerability; Gitleaks no leaks | Canlı credential/provider doğrulaması değildir |
| Native Rust testleri | **PASS** | Canonical 213/213 | Clean installed kabul ayrı |
| Strict Clippy | **PASS** | Canonical `npm.cmd run native:lint`; `-D warnings` | Yok |
| Rust MSRV 1.88.0 | **PASS** | `+1.88.0 --locked --all-targets` check PASS; test 213/213; strict Clippy PASS | `apps/desktop/src-tauri/Cargo.lock` MSRV-aware/fallback çözüldü |
| RustSec audit | **PASS** | `cargo-audit` 0.22.2 Windows x64: 0 vulnerability; plist 1.10, quick-xml 0.41, time 0.3.55, quinn-proto 0.11.15 | 17 izinli informational warning; Windows graph'ında GTK/glib/proc-macro uyarıları yok; Tauri urlpattern zincirindeki UNIC unmaintained uyarıları non-vulnerability upstream residual |
| Packaged native WebView smoke | **PASS** | Fresh `apps/desktop/src-tauri/target/release/blogbot.exe`: engine `READY`; local PGlite/durable queue, source review+scan, candidate/draft, instant-create, settings/schedule, pause/resume, diagnostics, setup ve tüm primary routes doğrulandı | Yerel paketli runtime kanıtıdır; production/dış kabul değildir |
| Desktop preflight | **PASS** | Fresh koşumda tüm kontroller PASS | Installer artifact'larının publish edildiği anlamına gelmez |
| Yerel prepared installer kanıtı | **PASS** | Prepared MSI/NSIS build tamamlandı; sidecar before/after bütünlüğü ayrı satırda doğrulandı | Yerel build dosyaları release provenance kimliği değildir; authoritative yayın asset'ı aşağıdaki canlı kanıttır |
| GitHub merge/target | **VERIFIED_EXTERNAL** | [PR #1](https://github.com/ucsahinn/blogbot/pull/1) `MERGED` → `1915a588579fccaee8f60658c412d28d8978eb3e`; [PR #2](https://github.com/ucsahinn/blogbot/pull/2) `MERGED` → `e28bd1336c7034d76c54746a5be52bb2c9b92c86` | Product/release hotfix merge kanıtı; deploy değildir |
| Main Verify | **VERIFIED_EXTERNAL** | [run 32442821205](https://github.com/ucsahinn/blogbot/actions/runs/32442821205) success; head SHA `e28bd1336c7034d76c54746a5be52bb2c9b92c86`; node 2m28s, browser 3m56s, native 18m29s | Uzak CI kanıtı; production kabul değildir |
| Release execution | **VERIFIED_EXTERNAL** | İlk [run 32440419950](https://github.com/ucsahinn/blogbot/actions/runs/32440419950) `test:all` aşamasında fail etti ve tag/release bırakmadı; hotfix sonrası [run 32443949089](https://github.com/ucsahinn/blogbot/actions/runs/32443949089) 2026-08-21T03:35:52Z→04:07:00Z success, head SHA `e28bd1336c7034d76c54746a5be52bb2c9b92c86` | Secret-scan 7s ve release job success; canlı tag/release target SHA ile eşleşti |
| Release provenance workflow | **PASS** | `gh release create ... --target "${{ github.sha }}"`; `cargo-audit` 0.22.2 pinli; focused provenance + RustSec contract 2/2 | Workflow kaynak sözleşmesi; uzak çalıştırma/yayın kanıtı değildir |
| Final review repair kanıtı | **PASS** | GitHub base-SHA CAS/mutate ve truthful writes; merged publication current-base approved-file doğrulaması; token rotation authorization-latch temizliği; logical backup envelope/schema/finite guardları; FK-topological logical restore; visual temp+atomic no-replace; PGlite v5→v6 sequence replay | Fetcher guard ve V2 hero iddiaları source-backed false positive olarak kapatıldı |
| Prepared sidecar bütünlüğü | **PASS** | Packaging 25/25; `BuildEngineScriptInvocations=1`, `PreparedDesktopInvocations=1`, `PreparedPreflightInvocations=1`; engine `fa7c2dcdeaac0eaf81cf5f17e9e384c4cf63a70f5e919ec3525516ae9431b408`, fetcher `bc6a9d7662679d05dd820a02633e039dcb4e18c31c1eacea6af06bc687485a3c`, restore `088995810f549bd0a0272f976f3b516bee2ef2c08f8daf28bf538aeb8f9778a5` before/after değişmedi | Prepared MSI/NSIS build PASS; imza sağlanmadı |
| Yayınlanan updater/release asset'ları | **VERIFIED_EXTERNAL / `NotSigned`** | `latest.json`: 713 bayt, SHA-256 `e61e7d20eb8e399856a9f7076580242bba9d2f148d1f82071a0d5d9dccce811a`; EXE: 61,694,796 bayt, SHA-256 `9d8bda7bbc9b8fa2dc9c8e6a2a38243d890b1d292fd5e68520d14bf01bfbcd17` | HTTP 200 ve release asset byte-identity doğrulandı; `NotSigned`/SmartScreen riski açık |
| Git Data P1 hardening | **PASS** | `apps/desktop/src-tauri/src/github_rest_adapter.rs`: 1–10 MiB dosyalarda Git Data API blob/tree/commit/non-force ref update ve Git blob read fallback; approved-path audit complete untruncated tree karşılaştırır, truncated tree'yi reddeder | TDD 4 RED; adapter 23/23 GREEN; full native 213/213 |
| Backup prerequisite P2 | **PASS** | `apps/desktop/src-tauri/src/commands.rs`: verified ve restore-preview gözlemleri aynı engine kaynaklı 64-hex `archiveSha256` değerine bağlı; farklı SHA iki timestamp'i resetler, hashesiz legacy kayıt `READY` değildir | TDD RED: eksik `update_backup_verification_record`; focused 1/1 GREEN; commands 92/92 |
| Restore FK-order P1 | **PASS** | `apps/engine/src/stdio-entrypoint.ts`: `applyLogicalRestore`, `pg_catalog` FK metadata'sından topological sıra kurar; `DELETE` child→parent, `INSERT` parent→child; scope dışı FK, duplicate veya cycle delete öncesi fail-closed | `tests/unit/engine-stdio.test.ts`: gerçek PGlite `sources`→`entry_versions`→`entry_latest` ve derived capabilities; focused 1/1, engine-stdio 49/49 |
| Token audit | **PASS** | 6837 tahmini token | Yok |
| Canonical `check:all` | **PASS** | Final hotfix zinciri: Node 762/761/0/1; lint; typecheck; web/desktop build; engine+fetcher smoke; security scan, npm audit, Rust cargo-audit ve Gitleaks; native 213/213; strict Clippy | GitHub Release ayrıca canlı doğrulandı; deploy kanıtı değildir |

Scratch temizliği, canonical aggregate, Rust 1.88.0 MSRV/RustSec, yerel prepared
artifact ve packaged native smoke tamamlandı. GitHub `v0.1.38` Release, updater
manifesti ve yayınlanan EXE ayrıca canlı doğrulandı. Bu kanıtlar temiz-VM installed
kabulü, rollback, deploy veya production ortam kabulü değildir.
Son koşum ayrıntıları
[uçtan uca doğrulama raporunda](end-to-end-verification-20260820.md) tutulur.

## `UNVERIFIED_EXTERNAL` kapıları

Aşağıdakiler açık code finding değildir; gerçek hesap, makine, zaman veya uzak
hedef gerektiren kabul kapılarıdır:

- canlı Codex/Luna ve ImageGen oturumları;
- uygulama içi GitHub device auth, içerik publication akışı, ref cleanup ve deploy dispatch;
- temiz Windows profilinde backup/restore ve PGlite kurtarma;
- temiz Windows VM'de installer, installed native/WebView smoke, update ve rollback;
- kesintisiz 24 saat scheduler/retention gözlemi;
- Search Console, DNS, public site ve production deploy doğrulaması.

GitHub `v0.1.38` Release ve updater feed yayını doğrulanmıştır. Kalan kapılar
yürütülmeden ürünün installed, production'da çalışır veya deploy edilmiş olduğu
iddia edilemez.

## Tarihsel zincir

- [Backend tamamlanma denetimi — 2026-08-19](backend-completeness-audit-20260819.md):
  canonical bulguların tarihsel kaynak raporu; açık durum sayıları artık güncel
  değildir.
- [Önceki master indeks — 2026-08-19](OPE-MASTER-COMPLETION-INDEX-20260819.md):
  tarihsel baseline; bu belge tarafından supersede edilmiştir.
- [Uçtan uca doğrulama — 2026-08-20](end-to-end-verification-20260820.md):
  güncel komut kanıtı ve dış kabul sınırı.
