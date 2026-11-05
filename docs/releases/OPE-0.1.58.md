# OPE 0.1.58

İmzasız Windows sürümü; elle kurulum içindir ([ADR 0009](../adr/0009-unsigned-manual-delivery.md)).
Uygulama içi otomatik güncelleme kurulumu kapalıdır. Bu sürüm bakım ve temizlik
sürümüdür; kullanıcıya görünen davranış, yayın, onay ve veri modeli değişmedi.

## Workflow notes input

The release workflow `notes` input uses this exact single paragraph:

```text
OPE 0.1.58: bakim ve temizlik surumu. Kullaniciya gorunen davranis degismedi. rustls, rustls-webpki, webpki-roots ve quinn-proto kilit surumleri RustSec bildirimlerine gore yukseltildi, yinelenen tip bildirimi dosyasi kaldirildi, Verify ve Release is akislarinin gitleaks sabitlemesi esitlendi, belge dizinindeki eksik kayitlar tamamlandi, yuklu makinede zamanlama nedeniyle dusebilen Codex zaman asimi temizlik testi kararli hale getirildi. Imzasiz Windows surumu; elle kurulum icindir. Uygulama ici otomatik guncelleme kapalidir. 24 saat, temiz makine, gercek arsiv ve GitHub yayin provasi kabul testleri acik kalmistir. Unsigned Windows build. Publisher identity is not certificate-verified. Manual installation only; in-app update installation is disabled.
```

## Değişiklikler

- **Temizlik:** `scripts/desktop-preflight.mjs.d.ts`, `desktop-preflight.d.mts`
  ile birebir aynıydı ve NodeNext çözümlemesi yalnız `.d.mts` dosyasını okuyordu;
  yinelenen dosya kaldırıldı. İnceleme kuyruğu kartındaki gereksiz `Section`
  tür dönüşümü ve kullanılmayan içe aktarma silindi.
- **Bağımlılık güvenliği:** `cargo audit` masaüstü kilit dosyasında 11 açık
  bildirdi: `rustls` 0.23.45 (RUSTSEC-2026-0346..0349), `rustls-webpki`
  0.103.14 (RUSTSEC-2026-0382), `webpki-roots` 1.0.9 (RUSTSEC-2026-0381) ve
  Windows hedef grafiğinde bulunmayan `quinn-proto` 0.11.15 (RUSTSEC-2026-0338..0342).
  Dördü de yalnız `Cargo.lock` içinde yama sürümüne yükseltildi (`rustls` 0.23.46,
  `rustls-webpki` 0.103.16, `webpki-roots` 1.0.11, `quinn-proto` 0.11.19);
  `Cargo.toml` değişmedi ve denetim artık sıfır açık bildiriyor. Kalan 12 uyarı (bakımsız `unic-*`, `proc-macro-error`, `zbus`
  ailesi; `glib`/`tokio` unsound; yanked `async-executor`) Tauri/GTK geçişli
  bağımlılıklarıdır ve denetimde izinli uyarı olarak kalır.
- **CI tutarlılığı:** Verify iş akışındaki `gitleaks-action` sabitlemesi Release
  iş akışıyla aynı sürüme (v2.3.9) eşitlendi.
- **Belgeler:** `docs/README.md` dizini, listelenmemiş olan 0.1.56 sürüm notunu ve
  2026-09-05 bağımsız inceleme raporunu artık gösteriyor.
- **Test kararlılığı:** 0.1.57 notunda belgelenen "JSONL kapandıktan sonra süre
  aşımı" entegrasyon testi, zaman aşımı raporunun bilinçli olarak arka planda
  süren süreç ağacı temizliğinden önce döndüğünü hesaba katacak şekilde sınırlı
  ama daha geniş bir temizlik penceresi kullanıyor. Üretim kodu değişmedi.

## Doğrulama

2026-11-05, bu geliştirme makinesinde: birim 491, uygulama 176, entegrasyon
246 (4 canlı sağlayıcı testi atlandı), tarayıcı 186 (185 paralel koşuda; tek
düşüş işletim sistemi `ERR_NO_BUFFER_SPACE` kaynaklıydı ve tek başına geçti),
Rust 257 test; lint, tip denetimi, Vite derlemesi, `cargo audit` (0 açık, 12
izinli uyarı), `security:scan`, `npm audit`, gitleaks (sızıntı yok), motor ve
fetcher sidecar derlemesi, motor ve fetcher smoke, `desktop:preflight:json`
geçti. Makinenin C: sürücüsü koşu sırasında doldu; cargo `target` ve npm
önbelleği temizlenerek yeniden koşuldu, Rust adımları yalnız doğrulama için
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0` ile çalıştırıldı.

## Açık kalan kabul kapıları

24 saat soak, temiz Windows makinesi, gerçek arşiv geri yükleme, kurulu yaşam
döngüsü matrisi, gerçek site, GitHub App ile yayın provası ve kota nedeniyle
bekleyen canlı Codex taslak turu bu sürümde geçmiş sayılmaz.
