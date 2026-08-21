# Uçtan uca doğrulama ve yayın kanıtı — 2026-08-20

Bu sayfa, 2026-08-20 tamamlama turunun **yerel ve canlı GitHub doğrulama kaydıdır**. Okuyucu,
hangi davranışın gerçekten gözlendiğini, hangi yerel kapının tamamlandığını ve
hangi kabulün hâlâ dış ortam gerektirdiğini buradan ayırt edebilir.
Kanıtlar 2026-08-21 OPE 0.1.38 release, updater ve final hotfix kaynak anıyla yenilenmiştir.

Canonical bulgu kapatma defteri
[2026-08-20 master completion index'tedir](OPE-MASTER-COMPLETION-INDEX-20260820.md).
2026-08-19 ve daha eski raporlar tarihsel baseline olarak korunur; güncel açık
code finding sayısı için kullanılmaz.

## Doğrulama ilkesi

1. Önce dar regresyon testleriyle değişen davranış kanıtlandı.
2. Ardından tam Node ve gerçek browser suite'i çalıştırıldı.
3. Exact 79 untracked `.codex-*` scratch, açık kullanıcı onayıyla kalıcı
   silindi; canonical lint ve `check:all` final kaynak anında yeniden koşuldu.
4. Açık kurulum onayıyla Rust 1.88.0 MSRV ve RustSec kapıları, ayrıca paketli
   `apps/desktop/src-tauri/target/release/blogbot.exe` native WebView smoke çalıştırıldı.
5. GitHub PR, Verify, Release, tag/target, asset ve updater uçları canlı ve salt-okunur
   doğrulandı.
6. Temiz makine, installed uygulama, rollback, provider, 24 saat veya production
   hedef isteyen kanıtlar yerel/GitHub release başarısına dahil edilmedi.

`PASS`, yalnız aynı satırdaki gözlenen koşumu ifade eder.
`UNVERIFIED_EXTERNAL` ise bir code finding değildir.

## Güncel gözlenen kapılar

| Kapı | Komut | Sonuç | Kanıt kapsamı |
|---|---|---|---|
| OPE desktop sürümü | Üç manifest + canlı release | **0.1.38 RELEASED** | [v0.1.38](https://github.com/ucsahinn/blogbot/releases/tag/v0.1.38), target/tag SHA `e28bd1336c7034d76c54746a5be52bb2c9b92c86`. |
| Tam Node suite | `npm.cmd run test:all` | **PASS — 762 toplam, 761 pass, 0 fail, 1 skip** | Final hotfix full suite; 80794.3964 ms. Tek skip, optional live Codex hesabı gerektirir. |
| Engine stdio suite | `tests/unit/engine-stdio.test.ts` full koşumu | **PASS — 49/49** | Backup helper'ın manuel/otomatik çağrı yolları ve FK-topological restore dahil engine stdio regresyon ailesi. |
| L4 backup no-replace/error path | Focused `tests/unit/engine-stdio.test.ts` koşumu | **PASS — 4/4** | Yarışmacı hedef korunur; ENOSPC/IO kısmi temp'i temizlenir; exclusive temp-create `EEXIST` başka writer'ın temp dosyasını silmez. |
| Restore FK-order | Focused `tests/unit/engine-stdio.test.ts` koşumu | **PASS — 1/1** | Gerçek PGlite `sources`→`entry_versions`→`entry_latest` ve derived capabilities regresyonu; RED `expected 1`, `actual []` sonrası GREEN. |
| Pipeline Codex suite | `tests/integration/pipeline-codex.test.ts` full koşumu | **PASS — 39 toplam, 38 pass, 0 fail, 1 skip** | 17631.9225 ms; tek skip kasıtlı live Codex probudur. |
| Codex deadline/probe | Focused `tests/integration/pipeline-codex.test.ts` koşumu | **PASS — 3/3** | En az 5 saniyelik bounded startup capability probe bütçesi, 1 saniyelik task deadline'dan bağımsızdır; slow-probe fixture yanlış `UNSUPPORTED_CLI` yerine gerçek task sonucunu `PROCESS_TIMEOUT` olarak korur. |
| Codex capability cache | Focused `tests/integration/pipeline-codex.test.ts` koşumu | **PASS — 2/2** | Normalize edilmiş 5–10 saniyelik probe bütçesi cache key'in parçasıdır; transient marker arızası sonraki retry'ı zehirlemez, eşzamanlı 5 ve 10 saniyelik çağrılar timeout sonucunu paylaşmaz. Yalnız cache'deki aynı rejected promise silinir; in-flight dedupe korunur. |
| Browser suite | `npm.cmd run test:browser` | **PASS — full 142/142, 2.4 dakika** | Yerel Playwright QA uygulaması; clean installed kullanıcı kabulü değildir. |
| TypeScript | `npm.cmd run typecheck` | **PASS** | Final kaynak anı. |
| Kaynak kapsamlı ESLint | `npx.cmd eslint apps packages tests scripts playwright.config.ts eslint.config.js` | **PASS** | Uygulama, paket, test, script ve config kaynakları temiz. |
| Canonical ESLint | `npm.cmd run lint` | **PASS** | Exact 79 `.codex-*` scratch onayla silindikten sonra repo kökünden final koşum. |
| Frontend/desktop build | `npm.cmd run build` ve desktop production build | **PASS — fresh OPE 0.1.38** | Yerel build; publish değildir. |
| SEA build | `npm.cmd run build:engine` | **PASS** | Engine ve fetcher sidecar üretildi; release/package değildir. |
| Engine smoke | `npm.cmd run smoke:engine` | **PASS — `READY`, PGlite ready, queue ready** | Yerel packaged sidecar el sıkışması. |
| Fetcher smoke | `npm.cmd run smoke:fetcher` | **PASS — beklenen `FETCHER_REQUEST_FAILED`** | Invalid plan'in child sınırında fail-closed reddi. |
| Security | `npm.cmd run security:verify` | **PASS** | `security:scan` 0 bulgu; offline npm audit 0 vulnerability; Gitleaks no leaks. |
| Native Rust | `npm.cmd run native:test` | **PASS — 213/213** | Canonical final hotfix native gate. |
| Strict Clippy | `npm.cmd run native:lint` | **PASS — `-D warnings`** | Canonical native lint gate. |
| Packaged native WebView smoke | `npm.cmd run smoke:native-webview` | **PASS** | Fresh `apps/desktop/src-tauri/target/release/blogbot.exe` ile local engine `READY`; PGlite/durable queue, source review+scan, candidate/draft, instant-create, settings/schedule, pause/resume, diagnostics, setup ve tüm primary routes doğrulandı. Production/dış kabul değildir. |
| Packaging ve native-smoke sözleşmesi | Typecheck + scoped lint + `tests/unit/packaging-readiness.test.ts` | **PASS — packaging 25/25** | Connector `migration`, release ordering ve prepared-sidecar sözleşmeleri doğrulandı. |
| Desktop preflight | `npm.cmd run desktop:preflight:json` | **PASS — fresh koşumda tüm kontroller** | Package sözleşmesi ve artifact bütünlüğü; publish kanıtı değildir. |
| Release provenance + RustSec contract | Focused `tests/unit/packaging-readiness.test.ts` | **PASS — 2/2** | Workflow `gh release create ... --target "${{ github.sha }}"` kullanır ve `cargo-audit` 0.22.2'yi pinler. |
| Context budget | `npm.cmd run token:audit` | **PASS — 6837 tahmini token** | Layered context-size denetimi. |
| Backup prerequisite binding | Focused native command testi + commands suite | **PASS — focused 1/1; commands 92/92** | Engine'in döndürdüğü aynı 64-hex `archiveSha256` verified/restore-preview gözlemlerini bağlar; farklı SHA iki timestamp'i resetler, hashesiz legacy kayıt `READY` değildir. |
| Prepared sidecar bütünlüğü | Packaging 25/25 + prepared MSI/NSIS build | **PASS** | `BuildEngineScriptInvocations=1`, `PreparedDesktopInvocations=1`, `PreparedPreflightInvocations=1`; engine `fa7c2dcdeaac0eaf81cf5f17e9e384c4cf63a70f5e919ec3525516ae9431b408`, fetcher `bc6a9d7662679d05dd820a02633e039dcb4e18c31c1eacea6af06bc687485a3c`, restore `088995810f549bd0a0272f976f3b516bee2ef2c08f8daf28bf538aeb8f9778a5` before/after değişmedi. |

## Canonical cleanup, aggregate ve MSRV kapıları

| Kapı | Sonuç | Kanıt | Çözüm sınırı |
|---|---|---|---|
| Scratch cleanup | **PASS** | Exact 79 untracked `.codex-*` (75 patch + 4 CJS) kullanıcı onayıyla kalıcı silindi; kalan 0 | İşlem kullanıcı tarafından açıkça onaylandı |
| `npm.cmd run lint` | **PASS** | Canonical repo-root lint | Yok |
| `npm.cmd run check:all` | **PASS** | Final hotfix zinciri: Node 762/761/0/1; lint; typecheck; web/desktop build; engine+fetcher smoke; security scan, npm audit, Rust cargo-audit ve Gitleaks; native 213/213; strict Clippy | GitHub Release ayrıca canlı doğrulandı; deploy kanıtı değildir |
| Rust 1.88.0 locked check | **PASS** | `cargo +1.88.0 check --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --locked` | Yok |
| Rust 1.88.0 locked test | **PASS — 213/213** | `cargo +1.88.0 test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --quiet` | Yok |
| Rust 1.88.0 locked Clippy | **PASS** | `cargo +1.88.0 clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | Yok |
| RustSec | **PASS — 0 vulnerability** | `cargo-audit` 0.22.2 Windows x64; plist 1.10, quick-xml 0.41, time 0.3.55, quinn-proto 0.11.15 | 17 izinli informational warning: Windows graph'ında GTK/glib/proc-macro yok; Tauri urlpattern zincirindeki UNIC unmaintained kayıtları non-vulnerability upstream residual |

Scratch temizliği ve Rust toolchain/Clippy kurulumu ayrı açık kullanıcı onaylarıyla
yapıldı. `apps/desktop/src-tauri/Cargo.lock` Rust 1.88.0 için MSRV-aware dependency fallback ile
çözüldü. Bu yerel
başarılar 108 canonical ürün bulgusunun sayısını değiştirmez.

## Final review repair kanıtı

| Yüzey | Sonuç | Kaynak kanıtı |
|---|---|---|
| GitHub publication | **PASS** | `apps/desktop/src-tauri/src/commands.rs`, `apps/desktop/src-tauri/src/github_publication.rs` ve `apps/desktop/src-tauri/src/github_broker.rs`: base-SHA capture CAS/mutate + truthful writes; merged current-base approved-file kontrolü normal revert'i yakalar; token rotation authorization latch'i temizler |
| Git Data P1 | **PASS — adapter 23/23, native 213/213** | `apps/desktop/src-tauri/src/github_rest_adapter.rs`: 1–10 MiB dosyalarda Git Data API blob/tree/commit/non-force ref update ve Git blob read fallback; approved-path audit complete untruncated commit tree karşılaştırır ve truncated tree'yi reddeder. TDD 4 RED sonrası GREEN. |
| Backup prerequisite P2 | **PASS — focused 1/1, commands 92/92** | `apps/desktop/src-tauri/src/commands.rs`: verified/restore-preview gözlemleri engine tarafından dönen aynı 64-hex `archiveSha256` değerine bağlıdır; farklı SHA iki timestamp'i resetler, hashesiz legacy kayıt `READY` sayılmaz. TDD RED eksik `update_backup_verification_record` regresyonunu yakaladı. |
| Restore FK-order P1 | **PASS — focused 1/1, engine-stdio 49/49** | `apps/engine/src/stdio-entrypoint.ts` `applyLogicalRestore`: `pg_catalog` FK metadata topological order; `DELETE` child→parent, `INSERT` parent→child. Scope dışı FK, duplicate veya cycle delete öncesi fail-closed; gerçek PGlite zinciri TDD RED→GREEN ile doğrulandı. |
| Logical backup | **PASS** | `packages/backup/src/logical-backup.ts` ve `tests/integration/logical-backup.test.ts`: salt 16, IV 12, tag 16; güvenli benzersiz/generated-column subset; iç içe non-finite sayı reddi |
| Visual transaction | **PASS** | `packages/visuals/src/index.ts`: tüm render'lar temp'te stage edilir, atomic no-replace commit yapılır ve önceden var olan hedef korunur |
| PGlite migration | **PASS** | `packages/database/src/pglite-backend-repository.ts` ve `tests/integration/local-engine-pglite.test.ts`: v5→v6 operational sequence backfill/replay regresyonu |
| Çürütülen adaylar | **Source-backed false positive** | Fetcher guard `apps/fetcher/src/sea-entrypoint.ts` + `packages/security/src/url-policy.ts`, V2 hero claim'i `packages/contracts/src/index.ts` enforcement'ıyla çürütüldü; canonical bulgu eklenmedi |

## Yerel prepared 0.1.38 installer kanıtı

Prepared MSI/NSIS build PASS durumundadır; sidecar before/after bütünlüğü yukarıdaki
kapı tablosunda kayıtlıdır. Yerel build dosyaları release provenance kimliği olarak
kullanılmaz. Yayınlanan authoritative EXE ve updater manifesti aşağıdaki canlı
GitHub tablosunda exact size/hash ile kaydedilir. Bu yerel build clean-VM kurulum
veya rollback kanıtı değildir.

## Canlı v0.1.38 GitHub Release ve updater kanıtı

| Yüzey | Durum | Canlı kanıt |
|---|---|---|
| Product PR | **VERIFIED_EXTERNAL** | [PR #1](https://github.com/ucsahinn/blogbot/pull/1) `MERGED` 2026-08-21T02:20:48Z; merge commit `1915a588579fccaee8f60658c412d28d8978eb3e`; `release: OPE 0.1.38`. |
| Release hotfix PR | **VERIFIED_EXTERNAL** | [PR #2](https://github.com/ucsahinn/blogbot/pull/2) `MERGED` 2026-08-21T03:16:48Z; merge commit `e28bd1336c7034d76c54746a5be52bb2c9b92c86`; `fix: prepare sidecars before release tests`. |
| Main Verify | **VERIFIED_EXTERNAL** | [run 32442821205](https://github.com/ucsahinn/blogbot/actions/runs/32442821205) success, head SHA `e28bd1336c7034d76c54746a5be52bb2c9b92c86`; node 2m28s, browser 3m56s, native 18m29s. |
| İlk release denemesi | **FAIL-CLOSED** | [run 32440419950](https://github.com/ucsahinn/blogbot/actions/runs/32440419950) `test:all` aşamasında fail etti; `build:engine` testten sonra konumlandığı için sonraki publish adımları skip oldu, tag veya release bırakılmadı. |
| Başarılı release run | **VERIFIED_EXTERNAL** | [run 32443949089](https://github.com/ucsahinn/blogbot/actions/runs/32443949089) 2026-08-21T03:35:52Z→04:07:00Z success; head SHA `e28bd1336c7034d76c54746a5be52bb2c9b92c86`; secret-scan 7s ve release job success; build-engine/prepared desktop/preflight invocation sayıları `1/1/1`. |
| Release nesnesi | **VERIFIED_EXTERNAL** | [v0.1.38](https://github.com/ucsahinn/blogbot/releases/tag/v0.1.38) published 2026-08-21T04:06:56Z; draft değil, prerelease değil; tag ve `targetCommitish` tam olarak `e28bd1336c7034d76c54746a5be52bb2c9b92c86`. |
| Updater manifest | **VERIFIED_EXTERNAL** | Release asset [`latest.json`](https://github.com/ucsahinn/blogbot/releases/download/v0.1.38/latest.json): 713 bayt, SHA-256 `e61e7d20eb8e399856a9f7076580242bba9d2f148d1f82071a0d5d9dccce811a`. [`releases/latest/download/latest.json`](https://github.com/ucsahinn/blogbot/releases/latest/download/latest.json) HTTP 200 ve asset ile byte-identical; version `0.1.38`, `windows-x86_64` URL'si yayınlanan installer URL'si, manifest SHA `9d8bda7bbc9b8fa2dc9c8e6a2a38243d890b1d292fd5e68520d14bf01bfbcd17`. |
| Yayınlanan EXE | **VERIFIED_EXTERNAL / `NotSigned`** | [`OPE_0.1.38_x64-setup.exe`](https://github.com/ucsahinn/blogbot/releases/download/v0.1.38/OPE_0.1.38_x64-setup.exe): 61,694,796 bayt, SHA-256 `9d8bda7bbc9b8fa2dc9c8e6a2a38243d890b1d292fd5e68520d14bf01bfbcd17`; doğrudan indirme HTTP 200 ve release asset ile byte-identical. |

Release ve updater feed yayındadır; ancak EXE Authenticode ile imzalı değildir.
`NotSigned` ve Windows SmartScreen itibarı/uyarısı, installed kabul yapılana kadar açık risktir.
Clean-VM kurulum, gerçek installed update ve rollback bu kanıtla doğrulanmış sayılmaz.

`package.json` içindeki `check:all`, Node testleri, lint, typecheck, frontend
build, engine/fetcher build ve smoke, security scan/npm audit/`security:rust`
cargo-audit/Gitleaks, native test ve strict Clippy'yi sıralı çalıştırır.
Browser, desktop preflight ve token audit bu
aggregate script'in dışında ayrıca çalıştırılır.

## Davranış kapsamı

108 canonical bulgunun yerel düzeltmeleri şu sınırları kapsar:

- mantıksal backup, doğrulama, retention, atomik restore ve bakım timeout'ları;
- durable PGlite/queue, CAS/lease, migration, retention ve restart recovery;
- kaynak ayrıştırma, SSRF/fetcher child sınırı, Markdown ve XML güvenliği;
- Codex/Boby süreç bütçeleri, claim-specific evidence, V3 kalite kapıları ve
  terminal retry politikaları;
- exact-hash approval/revoke, immutable media, preview/outbox/materialization;
- GitHub publication state machine, base/head/merge bağları ve duplicate-effect
  koruması;
- native bridge/IPC, updater doğrulaması, tray/preferences, diagnostics ve UI
  browser akışları;
- workflow doğrulama yüzeyinde release öncesi browser/fetcher/security kapıları.

Bu liste bir canlı provider veya production site sonucu değildir. Her bulgunun
kaynak, regresyon ailesi ve dış kabul sınırı master defterde ayrı satırdır.

## Dış kabul defteri

| Durum | Kabul | Gereken gerçek ortam/kanıt |
|---|---|---|
| `UNVERIFIED_EXTERNAL` | Codex/Luna | Gerçek device login, oturum, timeout/retry ve üretilen revision gözlemi |
| `UNVERIFIED_EXTERNAL` | ImageGen | Gerçek provider yetkisi, provenance, hata ve local fallback gözlemi |
| `VERIFIED_EXTERNAL` | GitHub Release | PR #1/#2 merge, main Verify, release run, tag/target SHA, release nesnesi ve iki yayın asset'ı canlı doğrulandı |
| `VERIFIED_EXTERNAL` | Updater feed | `latest.json` ve doğrudan EXE URL'si HTTP 200; manifest/release asset byte-identity, version, size ve SHA doğrulandı |
| `UNVERIFIED_EXTERNAL` | Uygulama içi GitHub publication/deploy | Device auth, gerçek içerik publication PR/merge, ref cleanup ve deploy dispatch |
| `UNVERIFIED_EXTERNAL` | Temiz profil restore | Başka/temiz Windows profilinde gerçek PGlite logical backup → verify → restore → açılış kontrolü |
| `UNVERIFIED_EXTERNAL` | Installed update/rollback | Temiz Windows VM'de kurulum, installed native/WebView smoke, gerçek update ve rollback |
| `UNVERIFIED_EXTERNAL` | 24 saat scheduler | Kesintisiz gerçek süreyle overdue catch-up, günlük backup, retention ve duplicate-effect gözlemi |
| `UNVERIFIED_EXTERNAL` | Search Console/site | Gerçek site adapter, DNS/public URL, Search Console, production CI ve deploy sonucu |

Bu kabuller için credential repository'ye yazılmamalıdır. Tamamlanan release ayrı
operatör onayıyla yürütüldü; gelecekteki GitHub mutation, site, DNS, Search Console,
installer veya deploy işlemleri yeniden açık operatör onayı ister.

## Release ve uzak durum sınırı

Bu çalışma turunda:

- product PR #1 ve release-ordering hotfix PR #2 merge edildi; final target SHA
  `e28bd1336c7034d76c54746a5be52bb2c9b92c86` main'e ulaştı;
- main Verify run 32442821205 ve release run 32443949089 success oldu;
- `v0.1.38` tag/release aynı target SHA ile yayınlandı;
- `latest.json` ve `OPE_0.1.38_x64-setup.exe` release asset'ları ile canlı updater
  indirme uçları HTTP 200, byte-identity, size ve SHA düzeyinde doğrulandı;
- yayınlanan EXE `NotSigned`; SmartScreen ve installed güven/UX riski açıktır;
- deploy, production URL, Search Console veya hosting canlı doğrulanmadı.

Bu rapor, GitHub `v0.1.38` Release'in ve updater feed'in yayınlandığını doğrular.
`Production hazır`, `canlıda çalışıyor`, `installed update/rollback kabul edildi`
veya `deploy tamamlandı` iddialarını taşımaz. Yerel code finding durumu
**108/108 `CLOSED_LOCAL`**; kalan uzak/installed kabuller yukarıdaki satırlarda
`UNVERIFIED_EXTERNAL` olarak kalır.

## Yerel ve release kapanış sonucu

Scratch cleanup, canonical lint/`check:all`, Rust 1.88.0 MSRV/RustSec, yerel
prepared installer ve packaged native WebView smoke PASS durumundadır. GitHub
`v0.1.38` Release ile updater feed `VERIFIED_EXTERNAL` durumundadır. Clean-VM
installed update/rollback, deploy, production site ve provider kabulleri açık kalır.
