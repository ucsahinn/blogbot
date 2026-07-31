# Blogbot

Blogbot, seçtiğiniz içerik sitesi için tek bir Windows bilgisayarında çalışan yerel editoryal
otomasyon uygulamasıdır. Kaynakları tarar, Türkçe içerik ile gerçeğe sadık
İngilizce yerelleştirmeyi hazırlar, kanıt ve kalite kontrollerini gösterir ve
yalnız kullanıcının onayladığı değişmez revizyonu yayın akışına alır.

Blogbot'un paneli, API'si, veritabanı ve işçileri uzak bir sunucuda çalışmaz.
Blogbot belirli bir siteye, alan adına, GitHub hesabına veya hosting sağlayıcısına
bağlı değildir. İsterseniz seçtiğiniz projenin kendi yayın akışına bağlanır;
istemiyorsanız yalnızca yerel klasöre dosya üretir.

## Hedef V1 kullanıcı akışı

Bu bölüm tamamlanmış özellik listesi değil, V1'in uçtan uca hedef akışıdır.
Bugün paketlenmiş masaüstüne gerçekten bağlanmış yüzeyler aşağıdaki
**Uygulama durumu** bölümünde ayrıca belirtilir.

1. Blogbot normal bir Windows uygulaması gibi açılır.
2. Kullanıcı URL, RSS, Atom, sitemap veya OPML kaynağı ekler ve kaynağı test eder.
3. Yerel engine kaynakları zamanlamaya göre ya da **Şimdi tara** komutuyla tarar.
4. Adaylar kaynak yeterliliği, güncellik, özgünlük ve konu uygunluğuyla sıralanır.
5. **Anlık oluştur** seçilen kaynaklardan TR/EN inceleme paketi hazırlar.
6. Kullanıcı metni, iddiaları, kaynakları, görselleri, SEO alanlarını, planlanan
   zamanı ve oluşacak dosya değişikliklerini birlikte inceler.
7. Onay, paketin canonical SHA-256 hash'ine bağlanır. Paketteki herhangi bir
   değişiklik onayı geçersiz kılar.
8. **Yayınla** niyeti, seçtiğiniz çalışma biçimine göre ya yayın deposundaki PR
   akışını, ya yerel geliştirme projesini, ya da doğrudan seçtiğiniz klasörü
   kullanır.

Bilgisayar veya Windows oturumu kapalıyken tarama, taslak üretimi ve yerel
zamanlayıcı çalışmaz. Uygulama yeniden açıldığında kalıcı kuyruk kaldığı yerden
devam eder. İnternet yokken yerel içerik görüntüleme ve düzenleme mümkündür;
kaynak tarama, Codex, GitHub ve yayın işlemleri kullanılamaz.

## Aktif mimari

```text
Windows 10/11 x64
└─ Blogbot.exe (Tauri 2 + React/Vite)
   ├─ Rust komut köprüsü
   ├─ Blogbot engine sidecar (Node SEA)
   │  ├─ PGlite yerel veri
   │  ├─ pg-boss kalıcı iş kuyruğu
   │  ├─ kaynak tarama ve editoryal iş akışları
   │  └─ Codex ve GitHub için ayrılmış bağlayıcı sınırları
   └─ Windows güvenli depo, tepsi ve bildirimler

Seçilen çalışma biçimi
├─ Yayında olan site: GitHub deposu + projenin kendi CI/hosting akışı
├─ Yerel geliştirme projesi: seçilen klasör + npm run dev
└─ Klasöre yaz: seçilen klasör + Blogbot üretim dosyaları
```

Tauri ile engine arasında localhost HTTP sunucusu açılmaz. Rust katmanı,
paketlenmiş sidecar'ı başlatır ve sürümlü, satır-sınırlı NDJSON mesajlarını
stdin/stdout üzerinden iletir. WebView'e genel ağ, dosya sistemi veya shell
komutu verilmez.

Eski uzak API, worker, PostgreSQL, VPN ve provider örnekleri aktif üründen
çıkarılmıştır; varsa yalnız geriye dönük uyumluluk ve dokümantasyon referansıdır.
Kararın geçmişi
yalnız [ADR 0004](docs/adr/0004-local-first-runtime.md) ve onun supersede ettiği
ADR kayıtlarında korunur.

## Kurulum davranışı

Son kullanıcı kurulumunda Node.js, npm, Rust, Git, Docker, PostgreSQL veya
Caddy kurmak zorunda değildir. Engine ve PGlite çalışma dosyaları masaüstü
paketiyle birlikte gelir. AI taslak özelliği için ayrı Codex çalışma zamanı ve
device login gerekir; Blogbot bunu sessizce indirip kurmaz, Kurulum Merkezi eksikliği
açıkça gösterir. WebView2 eksikse resmi
bootstrapper ayrı kullanıcı onayıyla çalıştırılır.

Blogbot kurulum tamamlanmamış olsa da açılır. Doctor ekranı her özelliği ayrı
değerlendirir; hazır olmayan ağ veya yayın özellikleri nedenleriyle pasif kalır.
Aktif önkoşullar ve mevcut uygulama sınırı
[Windows istemcisi önkoşulları](docs/operations/windows-client-prerequisites.md)
belgesindedir.

## Yerel geliştirme

Geliştirme bilgisayarında Node.js 24+, npm ve masaüstü native kontrolleri için
Rust/Cargo ile Windows C++ derleme araçları gerekir. Bağımlılık kurulumu dosya
sistemini ve `package-lock.json` durumunu etkiler; çalıştırmadan önce çalışma
alanı durumu kontrol edilmelidir.

```powershell
npm.cmd install
npm.cmd run test:all
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

Yerel engine sidecar'ını üretmek ve gerçek PGlite/pg-boss el sıkışmasını
doğrulamak için:

```powershell
npm.cmd run build:engine
npm.cmd run smoke:engine
```

`build:engine`, `apps/desktop/src-tauri/binaries` altındaki Windows sidecar'ını
ve `resources/pglite` çalışma dosyalarını yeniler. Bu bir kurulum paketi veya
release üretmez.

Native kontroller:

```powershell
npm.cmd run native:test
npm.cmd run native:lint
```

Toplu yerel kalite kapısı:

```powershell
npm.cmd run check:all
```

## Uygulama durumu

Repo şu yerel runtime temelini içerir:

- Tauri'nin `externalBin` olarak paketlediği Node SEA engine sidecar'ı;
- dosya sisteminde kalıcı PGlite repository ve PGlite üzerinde pg-boss kuyruğu;
- sürümlü stdio doctor/state/command protokolü;
- Rust tarafında sidecar keşfi, başlatma, yeniden başlatma ve 1 MiB mesaj sınırı;
- DPAPI ile sarılmış yerel veri anahtarı, AES-256-GCM şifreli PGlite JSON
  kayıtları, tek-instance, isteğe bağlı Windows autostart, tepsi ve bildirimler;
- gerçek `SOURCE.LIST`, SSRF-korumalı `SOURCE.TEST`, sürümlü/idempotent
  `SOURCE.SAVE` ve pg-boss üzerinde yeniden başlatılabilir `SOURCE.SCAN`
  engine kaynak operasyonları;
- recovery-key tabanlı AES-256-GCM taşınabilir yedek, doğrulama, salt okunur
  restore planı ve günlük/haftalık saklama domain'i;
- şifreli PGlite Codex iş kayıtları, sürüm/CAS geçişleri, kuyruk generation
  deduplication'ı ve `WAITING_CODEX` yeniden deneme çekirdeği;
- sıkı doğrulanan V2 revizyon paketleri için gerçek `REVISION.SAVE`,
  `REVISION.LIST`, `REVISION.GET` ve exact-hash bağlı normal
  `APPROVAL.GRANT` engine operasyonları; Windows inceleme kuyruğu ve salt
  okunur revizyon çalışma alanı bu kalıcı kayıtlardan beslenir;
- Markdown/claim/revision/publisher güvenlik sınırları ve bunların yerel testleri;
- genel Astro/site adaptörü ve isteğe bağlı, environment-gated yayın workflow
  sınırı. Hiçbir marka veya site ürünün zorunlu parçası değildir.

Bu liste ürünün canlı yayına alındığı anlamına gelmez. Normal editoryal onay
engine'e exact hash ve kalıcı onay kaydıyla bağlanmıştır. Yüksek risk ikinci
onayının ayrı Windows yeniden doğrulamasıyla bağlanması, Codex ve GitHub
bağlayıcılarının son kullanıcı akışına tam bağlanması, seçilen sitenin gerçek
dönüşümü, production GitHub App/environment yapılandırması, hosting ilk
kurulumu, staging tatbikatı ve temiz Windows VM kabulü tamamlanmış veya canlı
doğrulanmış değildir. Uzak durum, credential ve secret'lar bu repository
belgelerinden çıkarılamaz.

## Güvenlik ve onay sınırları

- Kaynak metni güvenilmeyen kanıttır; Codex için talimat değildir.
- Codex runner kullanıcı config/rules/MCP'lerini, site deposunu, Blogbot
  verisini, GitHub veya deploy credential'larını alamaz.
- GitHub yayını yalnız onaylı revision hash'i, beklenen base SHA ve izinli dosya
  manifestiyle çalışır.
- Ücretli OpenAI API fallback'i kullanıcı açıkça etkinleştirmeden çalışmaz.
- Install/upgrade, credential girişi, Git/GitHub mutasyonu, gerçek site
  dönüşümü, secret, DNS, commit, push, deploy, installer ve release ayrı açık
  onay kapılarıdır.

Ayrıntılı kapılar:
[docs/operations/approval-gates.md](docs/operations/approval-gates.md).

## Maliyet

Blogbot yeni zorunlu bir ücretli servis eklemez. Kullanıcının mevcut
ChatGPT/Codex aboneliği ve seçtiği hosting/domain maliyeti kendi tercihidir;
yerel klasöre yazma ve yerel geliştirme modu için hosting gerekmez.
GitHub Actions kotası veya başka bir ücretli API sınırı aşılırsa Blogbot
kendiliğinden ücretli aşımı etkinleştirmez.

## Belgeler

Belge haritası [docs/README.md](docs/README.md) içindedir. Mimari kararların
tarihsel kaydı [docs/adr](docs/adr) altında tutulur.
