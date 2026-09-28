# OPE 0.1.56 teslimat planı ve görev panosu

Açıldı: 2026-09-28. Bu dosya 0.1.56 döngüsünün tek görev panosudur. Her faz
bitince güncellenir. Kanıt dosyaları `build/verification/0.1.56/` altında
yereldir ve Git'e girmez; burada yalnız yolları ve ölçülen sonuçlar yazılır.

Durum anahtarı: `TODO`, `DOING`, `DONE`, `BLOCKED`, `OUT_OF_SCOPE`.
`DONE` yalnız komut, test veya ekran kanıtı varken yazılır.

## Görev sözleşmesi

- **Hedef:** kalan her yapılacak kalemi toplamak, uygulamayı çalıştırıp gözle
  doğrulamak, kalan hataları düzeltmek ve imzasız v0.1.56'yı teslim etmek.
- **Girdiler:** v0.1.55 kaynak ağacı (`6d05db5`), master kontrol listesi,
  dış kabul runbook'u, 2026-09-28 kod ve doküman taraması.
- **Sert sınırlar:** her commit, push, `gh` yazması, silme, installer koşusu ve
  kota tüketen Codex çağrısı ayrı onay ister. Gerçek profil yalnız okunur.
  Kod imzalama ve gerçek site bu döngünün dışındadır.
- **Bitti koşulu:** yerel kapılar yeşil, kapsam içi dış kapıların kanıtı var,
  v0.1.56 Release hash'leri yerelde yeniden doğrulandı, kurulu uygulama 0.1.56.

## Kullanıcı kararları

| Konu | Karar |
| --- | --- |
| Hedef site | Gerçek site kapsam dışı; tek-kullanımlık Astro fixture deposu yeter |
| Kapsam içi dış kapılar | Gerçek Codex taslak + Boby; GitHub App kaydı ve fixture deposunda yayın provası; `DATA-01` |
| Kapsam dışı | İmzalama, temiz VM, 24 saat soak, kurulu yaşam döngüsü matrisi, gerçek site, sağlayıcı kota/kalite/ImageGen, tatbikatlar |
| Profil | Gerçek profil salt-okunur ve önce yedeklenir; yıkıcı işlemler geçici profilde |
| Bitiş | Düzelt, commit, push, imzasız v0.1.56 Release |
| Pano | Bu dosya |

## Görevler

### Ön koşul

| Kalem | Durum | Kanıt |
| --- | --- | --- |
| WebView2 153.0.4234.48 ile eşleşen msedgedriver | DONE | `build/webdriver/153.0.4234.48/msedgedriver.exe` |

### Faz 0 — baseline

| Kalem | Durum | Kanıt |
| --- | --- | --- |
| Tam doğrulama merdiveni, düzeltme yapmadan | DONE | `build/verification/0.1.56/phase0/SUMMARY.md` |

Ölçülen sonuç: unit 489/489, app 171/171, tarayıcı 155/155, native WebView
11 rota, soak ön kontrolü 1/1, lint/typecheck/build/smoke yeşil. Entegrasyon
grubunda 2 dosya ve Rust testleri ilk koşuda düştü; ikisi de makinedeki bellek
baskısı ve `target/` dosya kilidi kaynaklıydı ve yalnız koşulunca 36/36 ile
255/255 geçti. Tek gerçek bulgu: `rustls` 0.23.43 için RUSTSEC-2026-0285.

### Faz 1 — doküman uzlaştırma

| Kalem | Durum |
| --- | --- |
| Bekleyen 0.1.55 kapanış dokümanlarını commit et | DONE |
| README ve docs/README güncel deftere işaret etsin | DONE |
| Restore ifadesi: aynı profil, ayrı dizin (ADR 0003) | DONE |
| Dış kabul runbook'u 0.1.56 kapsamı ve imzasız WIN-05/DATA-04 | DONE |
| Olay runbook'u rolleri, imzasız rollback, hosting notu | DONE |
| Güvenlik raporuna ADR 0009 notu | DONE |
| AGENTS/threat-model/deploy dokümanında site-nötr hosting ifadesi | DONE |
| GitHub App araştırma JSON'undaki bayat boşluk | DONE |
| Master kontrol listesine 0.1.56 bölümü ve triyaj | DONE |
| Temizlik: 128 `artifacts/*.patch` ve bayat gitleaks raporu silindi; eski `blogbot-*` temp kökleri zaten yoktu | DONE |

### Faz 2 — kod düzeltmeleri

| Kalem | Durum |
| --- | --- |
| Ölü kod ve eski token yardımcıları | DONE |
| `pilot:report` kaldırma | DONE |
| Codex usage role `expect` | DONE — değişiklik gerekmez: roller üç sabit JSON nesnesinden kurulur |
| Autostart rollback hatası tanılama günlüğüne | DONE |
| Backup-verification kaydı hatası tanılama günlüğüne | DONE |
| Eksik revizyon için scheduler atlama kaydı | DONE |
| Fetch transport'unun doctor'da görünmesi | DONE |
| Baseline bulgusu: `rustls` 0.23.45'e yükseltme | DONE |
| Paketli engine smoke'u fetcher sidecar'ı zorunlu kılsın | DONE |
| Sidecar ortamının test anahtarı tetikleyicilerini devralmadığı açık test | DONE |
| Faz 2 kapanışı: `check:all` + tarayıcı testleri | DONE |

Faz 2 kapanış ölçümü: tarayıcı 155/155; `check:all` ilk koşuda yük altındaki
iki zaman aşımıyla düştü (migration çocuk süreci ve kuyruk testi 45 sn sınırı).
İki dosya yalnız başına 11/11, tüm entegrasyon grubu 246 geçti + 4 canlı
sağlayıcı atlaması; lint, typecheck, build, engine derleme, iki smoke, güvenlik
ve 257 Rust testi yeşil.

### Faz 3 — görsel doğrulama

| Kalem | Durum |
| --- | --- |
| qa.html: 11 rota × 2 boyut + 17 hata durumu, sayfa hatası ve yatay taşma yok | DONE |
| İlk başlangıç adım rozetleri Türkçe başlıkları örtüyordu (ğ, ç) | DONE — düzeltildi, test eklendi |
| Çevrimdışı genel bakış "kontrol altında" diyordu | DONE — düzeltildi, test eklendi |
| Kısa pencerelerde hazırlık kartı "Hakkında"yı örtüyordu | DONE — sıkı kenar çubuğu, test eklendi |
| "Hakkında" imzasız derlemede sabit yayıncı imzası iddia ediyordu | DONE — düzeltildi, test eklendi |
| Takvim metninde iç kod `NEXT_SLOT`; aday toplu çubuğunda boşluk yok | DONE — düzeltildi, test eklendi |
| Tüm rota/durum/sekmelerde görünen iç kod taraması (17 durum × 11 rota, tüm sekmeler) | DONE — `NEXT_SLOT` sonrası bulgu yok |
| Native smoke, geçici profil, yeni exe, 1280×800 | DONE — PASS, 11 rota görüntüsü |
| Gerçek profil yedeği (repo dışında, `C:\Users\ulasc\OPE-profile-backup-20260928`) | DONE |
| Gerçek profil salt-okunur durum özeti (kurulu 0.1.55 ile) | DONE — PASS; motor/PGlite/Codex sağlıklı, 11 rota, 0 hata |

Risk kaydı: OPE'nin gerçek veritabanı `%LOCALAPPDATA%\Blogbot\data`
altında; bu klasör eski "Blogbot 0.1.30" kurulumunun kurulum klasörüdür.
0.1.30 kaldırıcısı çalıştırılırsa gerçek veri silinebilir. Kaldırma adımı
operatör kararına bırakıldı; kaldırıcı çalıştırılmadı.

### Faz 4 — kapsam içi dış kapılar

| Kalem | Durum |
| --- | --- |
| Gerçek Codex taslak + Boby | BLOCKED — hesap kotası: gerçek yanıt `WAITING_CODEX`/`USAGE_LIMIT`; kota yenilenince yeniden koşulacak |
| Gerçek kota sinyalinin tipli bekleme durumuna eşlenmesi (PROV-01 kanıtı) | DONE — `build/verification/0.1.56/phase4/live-boby-waiting-reason.json` |
| GitHub App kaydı (operatör) | BLOCKED — operatör henüz kaydetmedi; kayıt bağlantısı ve adımlar hazır |
| Fixture deposu `ucsahinn/ope-acceptance-fixture` (public, sentetik), squash-only, sıkı `build` korumalı `main` | DONE — deploy workflow elle tetiklenip build başarılı |
| Yayın provası (PR → check → merge → dispatch → ref temizliği) | TODO — GitHub App kaydı bekleniyor |
| `DATA-01` aynı profilde ayrı dizine restore | OUT_OF_SCOPE — operatör kararı 2026-09-28; sentetik backup/restore testleri yeşil |

### Faz 5 — sürüm

| Kalem | Durum |
| --- | --- |
| Beş yerde sürüm 0.1.56 ve `docs/releases/OPE-0.1.56.md` | DONE — unit 491/491, app 171/171, cargo check |
| Yerel installer ve artifact ön kontrolü | DONE — `build:desktop` ve `desktop:preflight --artifacts-dir` geçti |

Yerel imzasız installer'lar (yayımlanan dosyalarla aynı olmaları beklenmez;
CI kendi derlemesini yapar):

| Dosya | Bayt | SHA-256 |
| --- | ---: | --- |
| `OPE_0.1.56_x64-setup.exe` | 62838560 | `cc0a80253db0e732d576a38dff36cf86386764e06044907b61650b38ba410473` |
| `OPE_0.1.56_x64_en-US.msi` | 91232222 | `8cd163efbfd2558b2d3018924ad18f10412adf2bb3ecee65b520eae0a061c96e` |

Beş dosyalık payload doğrulaması (`verify-release-payload.ps1`) CI'ın ürettiği
`latest.json` ve SPDX SBOM'u gerektirir; yayımlanan payload üzerinde koşulacak.
| Push, Verify CI, Release workflow | DONE — `f92cc8c`; Verify 36470168204 ve Release 36475756901 başarılı |
| Yayımlanan payload hash doğrulaması | DONE — 4/4 varlık GitHub digest'iyle eşleşiyor; provenance ve SBOM attestation doğrulandı; ayrıntı: [kapanış raporu](unsigned-release-closure-20260928.md) |
| Bu makinede 0.1.55 → 0.1.56 kurulum | TODO — ayrı onay bekliyor |
| Blogbot 0.1.30 kaydını güvenli kaldırma (veri klasörünü paylaşıyor) | DONE — kaldırıcı çalıştırılmadı; eski ikililer, iki kısayol ve kayıt girdisi `C:\Users\ulasc\OPE-profile-backup-20260928\blogbot-0.1.30-quarantine` altına alındı; `data`, `secrets`, `diagnostics`, `logs` yerinde |
