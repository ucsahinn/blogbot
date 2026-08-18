# OPE uçtan uca doğrulama ve düzeltme raporu — 2026-08-18

## Kapsam

Bu rapor mevcut OPE çalışma ağacındaki backend, local engine, PGlite, durable queue, Tauri bridge, Boby, updater, UI, güvenlik ve paketleme yüzeylerini güncel kaynak ve doğrulama çıktılarıyla eşler.

Ürün sınırı korunmuştur: OPE local-first Windows masaüstü uygulamasıdır; engine, PGlite ve durable queue yerel source of truth'tur. Dış kaynak kanıttır. Yayın immutable revision hash ve insan onayı olmadan başlayamaz. Codex, ImageGen, GitHub veya site adaptörü hazır değilse dış etki fail-closed kalır. Güncelleme imzasızdır; güven zinciri HTTPS + SHA-256 ile sınırlıdır.

## Bu turda düzeltilen bug

Tanı paketi `C:\Users\ulasc\AppData\Local\Blogbot\diagnostics\blogbot-diagnostics-1787019485` içindeki ekran görüntüsünde Boby metinleri üst üste binmişti.

Kök neden, `.boby-panel` sabit CSS grid satırlarının koşullu “Boby'yi bağla / Durumu yenile” alanlarıyla uyuşmaması ve `overflow: hidden` altında mesaj alanının dar pencerede taşmasıydı.

`apps/desktop/src/styles.css` içinde panel flex kolon yerleşimine geçirildi; mesaj alanına `flex: 1`, `min-height: 0`, dikey scroll ve yatay taşma koruması; başlık içeriğine dar genişlik koruması eklendi.

Tanı paketindeki tek bridge olayı `ENGINE_READ_FAILED: ENGINE_CLOSED_PIPE` kaynak kaydetme sırasında oluşmuş; sonraki engine/doctor/state/source-save olayları başarılıdır. Mutation yanıtı kaybolduğunda otomatik retry yapılmaması bilinçli fail-closed davranıştır; aksi halde duplicate mutation riski doğar.

## Güncel doğrulama

- Node: 502 test; 501 pass, 0 fail, 1 intentional skip.
- Browser/E2E: 137/137 pass.
- Native Rust: 131/131 pass.
- ESLint ve TypeScript typecheck: PASS.
- Desktop production build: PASS; version 0.1.36.
- Engine sidecar build ve smoke: PASS; `READY`, `persistence: pglite`, `queue: ready`.
- Native clippy: PASS with `-D warnings`.
- Desktop preflight: all checks PASS.
- Security scan: 0 finding; npm audit: 0 vulnerability; gitleaks: 0 leak.
- Token audit: 6,569 estimated governed-context tokens.
- `git diff --check`: PASS.
- `npm.cmd run check:all`: PASS; the complete local chain passed in one sequential run.

## Backend ve akış matrisi

Runtime/Doctor, PGlite, durable queue/recovery, source URL/RSS/Atom/OPML/SSRF, source scan/review/save, candidate promotion, draft/research persistence, claims/evidence/SEO, TR/EN revision, image/media policy, approval, publication preview/outbox, backup/restore/diagnostics, Boby bridge ve unsigned updater yerel testlerde PASS veya açıkça provider/connector-gated durumdadır. Exact-hash, idempotency, redaction, request-id routing, fail-closed external effects ve human approval invariant'ları testlerle korunmaktadır.

## Native hazırlık notu

Temiz çalışma ağacında native testten önce sidecar resource klasörü üretilmelidir:

```powershell
npm.cmd run build:engine
npm.cmd run native:test
```

Bu sıralamayla native test 131/131 geçmiştir.

Ek olarak `apps/desktop/src-tauri/resources/engine-node_modules/.gitkeep` sentinel'i eklendi. Böylece Tauri ACL glob'u temiz checkout'ta klasör yokluğu nedeniyle kırılmaz; gerçek engine node modülleri yine `build:engine` tarafından üretilen paket kaynağıdır.

## Yerel olarak kanıtlanamayan dış kapılar

Gerçek Codex/Luna Low oturumu, gerçek ImageGen provider çağrısı, GitHub authorization/check/deploy, configured site adapter yayını ve temiz Windows install/upgrade/rollback henüz credential veya temiz makine kanıtı gerektirir. Uygulama bu durumlarda WAITING/DEGRADED/UNAVAILABLE gösterip dış etkiyi başlatmamalıdır; mevcut testler bunu doğrular.

## Çalışma ağacı

Kaynak değişiklikleri: `apps/desktop/src/styles.css`, `apps/desktop/tests/ui-contract.test.ts` ve `apps/desktop/src-tauri/resources/engine-node_modules/.gitkeep`.

Korunan kullanıcı dosyaları: `.env.example`, `IDEA.md`.

Bu turda commit/push/release yapılmadı.
