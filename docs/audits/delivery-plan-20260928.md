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
| Tam doğrulama merdiveni, düzeltme yapmadan | DOING | `build/verification/0.1.56/phase0/STATUS.txt` |

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
| Temizlik: `artifacts/*.patch`, eski temp kökleri, bayat gitleaks raporu | TODO |

### Faz 2 — kod düzeltmeleri

| Kalem | Durum |
| --- | --- |
| Ölü kod ve eski token yardımcıları | TODO |
| `pilot:report` kaldırma | TODO |
| Codex usage role paniği | TODO |
| Autostart rollback hatası | TODO |
| Backup-verification kaydı hatası | TODO |
| Eksik revizyon için scheduler atlama kaydı | TODO |
| Fetch transport'unun doctor'da görünmesi | TODO |
| Baseline'da çıkan hatalar | TODO |

### Faz 3 — görsel doğrulama

| Kalem | Durum |
| --- | --- |
| Native smoke, geçici profil | TODO |
| qa.html hata durumları ekran görüntüleri | TODO |
| Gerçek profil yedeği ve salt-okunur gezinti | TODO |

### Faz 4 — kapsam içi dış kapılar

| Kalem | Durum |
| --- | --- |
| Gerçek Codex taslak + Boby | TODO |
| GitHub App kaydı (operatör) | TODO |
| Fixture Astro deposu ve yayın provası | TODO |
| `DATA-01` aynı profilde ayrı dizine restore | TODO |

### Faz 5 — sürüm

| Kalem | Durum |
| --- | --- |
| Beş yerde sürüm 0.1.56 ve `docs/releases/OPE-0.1.56.md` | TODO |
| Yerel installer ve payload doğrulaması | TODO |
| Push, Verify CI, Release workflow | TODO |
| Yayımlanan payload hash doğrulaması | TODO |
| Bu makinede kurulum ve Blogbot 0.1.30 kaldırma | TODO |
