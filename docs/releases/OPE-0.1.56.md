# OPE 0.1.56

İmzasız Windows sürümü; elle kurulum içindir ([ADR 0009](../adr/0009-unsigned-manual-delivery.md)).
Uygulama içi otomatik güncelleme kurulumu kapalıdır. Görev ve kanıt kaydı:
[teslimat planı](../audits/delivery-plan-20260928.md).

## Workflow notes input

The release workflow `notes` input uses this exact single paragraph:

```text
OPE 0.1.56: rustls guvenlik yamasi (RUSTSEC-2026-0285), zamanlayici ve kaynak okuma yolunun gorunur tanilari, dusurulen autostart ve yedek dogrulama hatalarinin kaydi, kurulum adim rozetleri, cevrimdisi genel bakis basligi, kisa pencerede kenar cubugu ve metin duzeltmeleri. Imzasiz Windows surumu; elle kurulum icindir. Uygulama ici otomatik guncelleme kapalidir. 24 saat, temiz makine, gercek arsiv ve GitHub yayin provasi kabul testleri acik kalmistir. Unsigned Windows build. Publisher identity is not certificate-verified. Manual installation only; in-app update installation is disabled.
```

## Düzeltmeler

- **Güvenlik:** `rustls` 0.23.43 → 0.23.45 (RUSTSEC-2026-0285, TLS 1.3 el sıkışma
  sınırı). Yalnız GitHub HTTPS istemcisini etkiliyordu.
- **Zamanlayıcı:** okunamayan planlı revizyon artık iz bırakmadan düşmüyor;
  `REVISION_UNAVAILABLE` atlama kaydı olarak raporlanıyor.
- **Kaynak okuma:** engine doctor yanıtı kaynakların yalıtılmış fetcher sidecar'ı
  mı yoksa süreç içi yedek yol mu üzerinden okunduğunu bildiriyor; paketli engine
  smoke'u sidecar'ı zorunlu kılıyor.
- **Masaüstü:** başarısız autostart geri alma ve yedek doğrulama kaydı hataları
  tanılama günlüğüne yazılıyor.
- **Arayüz:** ilk başlangıç adım rozetleri Türkçe başlıkları (ğ, ç) örtmüyor;
  çevrimdışı genel bakış "kontrol altında" demiyor; kısa pencerelerde hazırlık
  kartı "Hakkında"yı örtmüyor; "Hakkında" imzasız derlemede sabit yayıncı imzası
  iddia etmiyor; takvim metninden iç kod `NEXT_SLOT` kaldırıldı; aday toplu işlem
  çubuğu aralıklı.
- **Temizlik:** hiç oluşturulmayan çalışma durumu ve eski token yardımcıları
  kaldırıldı; kanıt üretmeyen `pilot:report` betiği kaldırıldı.

## Açık kalan kabul kapıları

24 saat soak, temiz Windows makinesi, gerçek arşiv geri yükleme, kurulu yaşam
döngüsü matrisi, gerçek site, GitHub App ile yayın provası ve kota nedeniyle
bekleyen canlı Codex taslak turu bu sürümde geçmiş sayılmaz.
