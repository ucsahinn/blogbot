# OPE master completion index — 2026-08-19

Bu indeks, 2026-08-18 tarihli indeksin yerini alır. Aktif ürün sözleşmesi
local-first Windows masaüstü uygulamasıdır; eski remote-backend ADR'leri
tarihçedir.

2026-08-18 indeksi her fazı "PASS" olarak gösteriyordu. O tablo yeşil test
sonuçlarını doğru raporluyordu, fakat testlerin kapsamadığı davranışları
kapsamıyordu. 2026-08-19 denetimi 183 iddia üretti, bunların 151'i bağımsız
çürütme turundan geçti ve 28'i aynı turda kapatıldı. Aşağıdaki matris artık
"testler yeşil mi" yerine **"gerçek kullanıcı yolunda çalışıyor mu"** sorusunu
yanıtlar.

## Faz kanıt matrisi

| Faz | Yerel durum | Bu turda değişen | Dış kapı |
|---|---|---|---|
| Runtime, Doctor, PGlite, queue | PASS | `state` artık CAS sürümünü döndürüyor; 50 değişiklik sonrası tüm mutasyonların kalıcı olarak kilitlenmesi giderildi | Temiz makine restart |
| Bridge, Tauri permissions, process isolation | PASS | — | Yok |
| Source ingestion, RSS/Atom/OPML, SSRF | PASS | Besleme ayrıştırıcısındaki karesel markup temizliği doğrusala çevrildi (256 KB → 43 s'den ms'ye) | Gerçek URL kalite kalibrasyonu |
| Candidate, research, draft | PASS / Codex-gated | Anlık Oluştur seçilen bölümü koruyor ve sekiz bölümün tamamını kabul ediyor; kaynak metni çıkarımı doğrusal; Codex materyalizasyon tekrarı artık kilitlenmiyor | Gerçek Codex hesabı |
| Boby/Luna Low | PASS / live-gated | Boby cevabı artık masaüstüne ulaşıyor (önceden her okuma "bulunamadı" dönüyordu); kapsam guardrail'i artık okunaklı Türkçe ve testleri gerçekten çalışıyor | Gerçek Luna Low session |
| Claims, evidence, TR/EN, SEO | PASS fail-closed | Markdown politikası körleşmesi kapatıldı; iddia–kanıt çözünürlüğü açık ürün kararı | Gerçek haber havuzu kalibrasyonu |
| ImageGen/media | PASS / provider-gated | — | Gerçek ImageGen provider |
| Approval and high-risk approval | PASS fail-closed | — | Gerçek Windows user confirmation |
| Publication preview/outbox | PASS / connector-gated | Zamanlanmış yayın artık gerçekten kuyruğa giriyor; önizleme tekrarı, zamanlayıcı zehirlenmesi ve LOCAL_DEV manifest/paket ayrışması giderildi | GitHub/site adapter |
| GitHub yayın mutabakatı | KISMEN | ~3 KB üstü dosya, birleşme-sonrası tur hataları ve geçici hataların kalıcı `FAILED` sayılması giderildi; kapalı PR ve merge-sonrası dal doğrulaması **açık** | Gerçek GitHub auth/check/deploy |
| Backup, restore, diagnostics | **KISITLI** | Geri yüklenemeyecek yedek artık "başarılı" raporlanmıyor. Biçim gerçek veri dizinini taşıyamıyor ve günlük anlık görüntü hâlâ tetiklenmiyor — ürün kararı bekliyor | Temiz profil restore |
| Updater | PASS locally | Kurulum yalnız hash doğrulandıktan sonra başlatılıyor ve çalıştırmadan önce yeniden doğrulanıyor | Temiz Windows upgrade/rollback |
| UI, accessibility, responsive, Boby layout | PASS | — | Gerçek installed EXE visual smoke |
| Packaging and security | PASS | Sürüm tutarlılığı kapısı eklendi; release workflow artık kalite kapısını çalıştırıyor | Release identity is unsigned by policy |

## Canonical reports

- [Backend uçtan uca tamamlanma denetimi (2026-08-19)](backend-completeness-audit-20260819.md) — **güncel**
- [End-to-end verification and fixes](end-to-end-verification-20260818.md)
- [External gates handoff](external-gates-handoff-20260818.md)
- [End-to-end completion audit final](end-to-end-completion-audit-20260817-final.md)
- [End-to-end backend audit](end-to-end-backend-audit-20260816.md)
- [Static audit remediation ledger](static-audit-remediation-20260811.md)
- [Önceki master index (2026-08-18)](OPE-MASTER-COMPLETION-INDEX-20260818.md)

## Architecture and product decisions

- [Local-first runtime ADR](../adr/0004-local-first-runtime.md)
- [Durable editorial state ADR](../adr/0005-durable-editorial-state.md)
- [Runtime isolation ADR](../adr/0003-runtime-isolation.md)
- [Unsigned update/recovery ADR](../adr/0003-local-recovery-and-unsigned-update-boundaries.md)
- [System architecture](../architecture/system.md)
- [Site bağımsız ürün sınırı](../architecture/site-neutral-product.md)
- [Boby persona](../boby/BOBY_PERSONA.md)
- [Boby prompt policy](../boby/BOBY_PROMPT_POLICY.md)
- [Boby Codex routing](../boby/BOBY_CODEX_ROUTING.md)

## Current verified command gate

```powershell
npm.cmd run check:all
npm.cmd run test:browser
npm.cmd run desktop:preflight:json
```

Güncel kanıt: Node 530 testte 529 pass / 0 fail / 1 kasıtlı skip, browser
137/137, native 140/140, engine `READY`/PGlite ready/queue ready, güvenlik
taraması ve npm audit temiz, lint/typecheck/build/clippy/preflight PASS.

## Sürüm kararı

**FIX BEFORE RELEASE.** Yerel editoryal yol (kaynak → taslak → inceleme → onay
→ yerel klasöre üretim) çalışır ve testlerle korunur. Sürüm öncesi iki yetenek
kullanıcıya vaat edilemez: yedekleme/kurtarma ve canlı `PUBLISH` yayını. İkisi
de fail-closed davranır, gerekçeleri ve önerilen tasarımları
[2026-08-19 raporunun karar bölümündedir](backend-completeness-audit-20260819.md).

## Tamamlanma sınırı

Yerel kaynakta **açık ve kanıtlı** bir iş listesi vardır: 123 doğrulanmış bulgu
hâlâ açıktır (1 kritik, 7 yüksek, 53 orta, 62 düşük) ve tamamı
[2026-08-19 raporunda](backend-completeness-audit-20260819.md) dosya/satır
kanıtıyla listelenir. Tek açık kritik madde, yedekleme biçiminin gerçek PGlite
veri dizinini taşıyamamasıdır ve mimari bir ürün kararı gerektirir.

Bunun dışındaki kalan maddeler gerçek hesap, sağlayıcı, GitHub/site hedefi veya
temiz Windows profili gerektirir ve yalnız kaynak düzenlemesiyle dürüstçe
tamamlanamaz. Bu repository'de hiçbir credential saklanmaz.
