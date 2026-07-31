# Windows istemcisi önkoşulları

Bu belge, son kullanıcının Blogbot'u açması ve özellikleri aşamalı olarak hazır
hale getirmesi içindir. Sihirbaz bir açılış kilidi değildir: Blogbot eksik
bağlayıcılarla da açılır ve her hazır olmayan işlem için gerekçe gösterir.

## Destek hedefi

- Windows 10 22H2 x64
- Güncel Windows 11 x64
- Kullanıcı profiline yazma izni
- Uygulama, yerel veri ve yedekler için yeterli disk alanı
- Doğru sistem saati ve `Europe/Istanbul` yayın zaman dilimi

ARM64, eski Windows sürümleri ve kullanıcı oturumu olmadan servis gibi çalışma
V1 kapsamında değildir.

## Paketle birlikte gelenler

| Bileşen | Görevi |
|---|---|
| Tauri masaüstü uygulaması | Yerel React/Vite arayüzü ve dar Rust komut köprüsü |
| Blogbot engine sidecar | Kaynak, revizyon, kuyruk ve zamanlama sahibi |
| PGlite çalışma dosyaları | Yerel kalıcı veri |
| pg-boss | Yerel kalıcı iş kuyruğu |
| WebView2 bootstrapper | WebView2 yoksa kullanıcı onayıyla resmi kurulumu başlatır |

Son kullanıcı Node.js, npm, Rust, Cargo, Visual Studio Build Tools, Git, Docker,
PostgreSQL, Caddy, VPN aracı veya GitHub CLI kurmaz. AI taslakları için Codex
çalışma zamanı ayrı bir bağlayıcıdır: Blogbot onu paket içine gömmez veya
sessizce kurmaz. Kullanıcı Codex'i kurup device login yaptığında Kurulum Merkezi
runner testini geçirir; bu bağlantı yoksa kaynak ve yerel editör açık kalır,
yalnız AI taslak işleri bekler.

## Kullanıcıdan istenebilecek bilgiler

| Özellik | Gerekli bilgi veya eylem | Zorunluluk |
|---|---|---|
| Temel yerel çalışma | Windows kullanıcı profili ve çalışan WebView2 | Uygulamayı kullanmak için |
| Güvenli depo | Windows profilinde DPAPI erişimi | Hassas yerel ayarlar için |
| Codex | Ayrı Blogbot giriş akışının tamamlanması | AI araştırma/taslak için |
| GitHub | Seçilen site deposuna sınırlı yetkili giriş | PR ve yayın takibi için |
| Yazar profili | Görünen ad, biyografi ve uzmanlık | Yayın paketi için |
| Kaynaklar | URL, RSS, Atom, sitemap veya OPML | İçerik keşfi için |
| Takvim | Gün, saat ve haftalık slotlar | Planlı çalışma için |
| Yedek | Kullanıcının seçtiği klasör ve doğrulanmış recovery key | Yayını açmak için |

Secret, token, cookie, private key veya connection string uygulama loguna,
tanılama paketine ya da repository dosyalarına yazılmaz.

## Doctor kontrolleri

Mevcut masaüstü kodu şu yerel kontrolleri raporlar:

- Windows çalışma zamanı;
- WebView2;
- Windows güvenli anahtar deposu/DPAPI;
- paketlenmiş engine sidecar;
- PGlite ve pg-boss doctor sonucu;
- sistem saati için dikkat durumu;
- Codex ve doğrulanmış yedek için hazır değil/bloklu durumu.

Codex, GitHub, yedek/restore ve yayın zincirinin tamamı henüz production-ready
olarak belgelenmez. Bir kontrol uygulanmadıysa `Hazır` gösterilemez.

## Özelliklerin kapanma davranışı

- Engine başlatılamazsa state-changing yerel komutlar kapanır; uygulama yine
  açılır.
- İnternet yoksa yerel içerik görüntüleme ve düzenleme sürer; kaynak testi,
  Codex, GitHub ve yayın kapanır.
- Codex girişi veya kotası yoksa ilgili işler bekler; ücretli API'ye otomatik
  geçilmez.
- GitHub hazır değilse içerik onayı yerelde korunabilir ancak PR/merge/deploy
  başlatılamaz.
- Yerel engine çalışırken başlangıçta ve 24 saatte bir otomatik şifreli yedek
  alınır. Otomatik kopyalar iç yerel veri anahtarıyla korunur ve 14 günlük günlük
  / 8 haftalık haftalık retention planıyla tutulur.
- Doğrulanmış şifreli yedek ve recovery key olmadan üretim yayını açılamaz.
- Bilgisayar veya Windows oturumu kapalıyken hiçbir Blogbot işi çalışmaz.

## Bu V1'de istenmeyenler

VPN profili, uzak Blogbot API adresi, cihaz eşleştirme kodu, uzak PostgreSQL
parolası veya sunucu Codex oturumu istenmez. Böyle bir alan ya da talimat
görülürse eski uzak-backend akışından kalmıştır ve V1 kurulumu için
kullanılmamalıdır.

## Doğrulama

Geliştirme çalışma alanında paketlenmiş engine kanıtı:

```powershell
npm.cmd run build:engine
npm.cmd run smoke:engine
```

Başarılı smoke yanıtı `status: "READY"`, `persistence: "pglite"` ve
`queue: "ready"` alanlarını içerir. Bu komutlar son kullanıcı kurulumu değildir;
geliştirme ve paketleme doğrulamasıdır.
