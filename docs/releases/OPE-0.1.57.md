# OPE 0.1.57

İmzasız Windows sürümü; elle kurulum içindir ([ADR 0009](../adr/0009-unsigned-manual-delivery.md)).
Uygulama içi otomatik güncelleme kurulumu kapalıdır. Bu sürüm arayüz ve doğruluk
düzeltmeleridir; yayın, onay ve veri modeli davranışı değişmedi.

## Workflow notes input

The release workflow `notes` input uses this exact single paragraph:

```text
OPE 0.1.57: arayuz dogruluk ve erisilebilirlik surumu. Hata bildirimleri artik uyari tonunda, ekran cokmeleri yerel olarak yakalaniyor, onay diyalogu modal ve klavye guvenli, kaynak ve inceleme sekmeleri klavye ile gezilebiliyor, Istanbul saati her yerde tutarli, adaylar yenilemede kaybolmuyor, saglik ve yayin metinleri sade Turkce. Imzasiz Windows surumu; elle kurulum icindir. Uygulama ici otomatik guncelleme kapalidir. 24 saat, temiz makine, gercek arsiv ve GitHub yayin provasi kabul testleri acik kalmistir. Unsigned Windows build. Publisher identity is not certificate-verified. Manual installation only; in-app update installation is disabled.
```

## Düzeltmeler

- **Dayanıklılık:** bir ekranın beklenmeyen veriyle çökmesi tüm uygulamayı
  düşürmüyor; "Ekranı yeniden dene" ile toparlanıyor. Yenileme hataları sessizce
  yutulmuyor, aday listesi yenilemede kaybolmuyor.
- **Doğruluk:** başarısız okuma/kaydetme bildirimleri onay renginde değil uyarı
  renginde; ölçülmeyen gecikme "Ölçülmedi"; onaydan önce "Onay neyi kapsar";
  yayın ve çıktı durumları Türkçe ve tutarlı; tarihler her yerde İstanbul saatiyle.
- **Erişilebilirlik:** onay diyaloğu gerçekten modal (arka plan inert, Escape,
  odak tuzağı); odak, devre dışı kalan düğmeden düşmüyor; kaynak modu ve sekme
  listeleri ok tuşlarıyla gezilir; Hakkında paneli Escape ile kapanır.
- **Düzen:** inceleme sekmeleri dil anahtarıyla sıkışmıyor ve 960 px'te taşmıyor;
  eksik medya durumu açıklayıcı ve eyleme bağlı; planlanan yayın satırları
  hizalı; Codex rol kartları çift kenarlıksız; kısa pencerelerde kenar çubuğu.
- **Metin:** sağlık ve kuyruk etiketlerinde "PGlite", "pg-boss", "stdio", "runner",
  "hash", "Debug" gibi iç terimler sade Türkçe ile değiştirildi.

## Doğrulama

Tarayıcı 186, uygulama 176, birim 491, entegrasyon 246, Rust 257 test; lint,
tip denetimi, motor ve fetcher smoke, güvenlik taraması ve yerel WebView smoke
geçti. Entegrasyon paketi paralel koşuda, yoğun makinede bir Codex zaman aşımı
temizlik testinde zamanlama nedeniyle düşebiliyor; `--test-concurrency=1` ile
ve tek başına geçiyor.

## Açık kalan kabul kapıları

24 saat soak, temiz Windows makinesi, gerçek arşiv geri yükleme, kurulu yaşam
döngüsü matrisi, gerçek site, GitHub App ile yayın provası ve kota nedeniyle
bekleyen canlı Codex taslak turu bu sürümde geçmiş sayılmaz.
