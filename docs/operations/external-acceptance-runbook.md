# Dış kabul doğrulama runbook'u

Bu runbook, repository içinde doğrulanamayan 20 dış kabul kapısının nasıl
çalıştırılacağını ve hangi kanıtla kapatılacağını tanımlar. Prosedürün yazılmış
olması hiçbir kapının geçtiğini göstermez ve hiçbir dış işlem için yetki vermez.
Credential, hesap, GitHub ayarı, workflow çalıştırma, provider kullanımı, gerçek
kullanıcı verisi, DNS, hosting, Search Console, release, publish, deploy ve geri
alma işlemleri hemen öncesinde kendi kapsamını açıkça belirten ayrı onay ister.

Bu belge çalıştırılmaya hazır bir prosedürdür; mevcut durum **procedure prepared,
execution unverified** olarak kalır. Güncel geçiş durumu
[`OPE-MASTER-COMPLETION-CHECKLIST-20260903.md`](../audits/OPE-MASTER-COMPLETION-CHECKLIST-20260903.md)
dosyasındaki `UNVERIFIED_EXTERNAL` kayıtlarıdır.

## Ortak sözleşme

Her koşu başlamadan önce operatör aşağıdaki alanları doldurur. Kanıt paketi
repository, Git geçmişi veya sistem geçici klasörü içine konmaz; kurumun
onayladığı kalıcı, erişimi sınırlı bir konum seçilir.

| Alan | Zorunlu içerik |
| --- | --- |
| Vaka | Benzersiz kimlik, kapı kimliği ve UTC başlangıç zamanı |
| Yetki | Bu koşuya özgü onayın kaydı ve kapsadığı dış yazmalar |
| Sahiplik | Uygulayan, bağımsız doğrulayan ve nihai kabul eden kişi |
| Hedef | Disposable/production ayrımı, işletim sistemi ve dış sistem adı |
| Kaynak | Tam commit SHA, sürüm adayı, workflow ve adaptör sürümü |
| Beklenti | Ölçülebilir başarılı sonuç ve fail-closed durdurma koşulu |
| Sonuç | `PASS`, `FAIL`, `BLOCKED` veya `NOT_RUN`; UTC bitiş zamanı |
| Kanıt | Dosya adı, SHA-256, üretim aracı/sürümü ve güvenli konumu |
| Redaksiyon | Secret ve kişisel/üretim verisi taramasının sonucu |
| Takip | Sapma, kalan risk, sahibi ve son tarih |

Bir koşu ancak farklı bir kişi kanıtı yeniden doğruladığında `PASS` olabilir.
Ekran görüntüsü tek başına yeterli değildir: hedef kimliği, tam SHA, zaman ve
beklenen/gerçek sonuç metin veya makine-okunur bir kayıtta bulunmalıdır. Token,
cookie, authorization header, PFX, private key, recovery key, connection string,
ham kullanıcı içeriği ve provider prompt/yanıtı kanıt paketine alınmaz. Böyle bir
değer görünürse paylaşım durur, paket karantinaya alınır ve ilgili credential
olay akışı izlenir.

Ortak fail-closed koşulları şunlardır:

- koşuya özgü onay, sahip, disposable hedef veya geri dönüş noktası eksikse;
- hedef repository, Windows profili, site clone'u ya da artifact tam kimliğiyle
  yeniden doğrulanamıyorsa;
- beklenmeyen ücret, production yazması veya izin genişlemesi doğuyorsa;
- secret redaksiyonu, bütünlük hash'i veya bağımsız doğrulama üretilemiyorsa;
- koşu sırasında başka bir kapının sınırı aşılacaksa.

## Kabul matrisi

| Kimlik | Dış kapı | Başarılı kabul kanıtı |
| --- | --- | --- |
| `WIN-01` | Sertifika ve insan sahibi | Dağıtım modeli, sağlayıcı/custody uyumu, distinct owner/backup ve rotation/revocation kaydı |
| `WIN-02` | Korumalı signing environment | Environment/reviewer politikası ile gerekli secret **adları** ve public pin değişkenlerinin varlık/biçim kaydı; değerler yok |
| `WIN-03` | Aday imzalama koşusu | Exact payload'ın tüm PE/installer girdilerinde `Valid` Authenticode, SHA-256, RFC 3161 ve yayıncı pini eşleşmesi |
| `WIN-04` | SBOM ve attestations | SPDX belgesi ve provenance/SBOM subject'lerinin exact imzalı payload SHA-256 listesiyle bağımsız eşleşmesi |
| `WIN-05` | Temiz Windows matrisi | Windows 10/11 install, N-1 upgrade, bozuk/yarım update, installer hatası ve rollback sonrası veri okunabilirliği |
| `GH-01` | App kaydı/install doğrulama | Canlı App ayarlarının yerel exact permission ve one-repository politikasıyla eşleşmesi |
| `GH-02` | Owner, registration ve installation | Named owner/backup, device flow/token expiration ve yalnız seçilen repository installation'ı |
| `GH-03` | Repository korumaları | Branch protection/ruleset ve exact required-check adlarının canlı, yeniden üretilebilir envanteri |
| `GH-04` | Device expiry/revocation | Native DPAPI store ile authorize, refresh/expiry, revoke ve fail-closed yeniden yetkilendirme kanıtı |
| `GH-05` | Publication provası | Disposable depoda revision → PR → checks → merge → ref cleanup → dispatch; production publish yok |
| `PROV-01` | Gerçek rate/quota sinyali | Hesabı bilerek tüketmeden gerçek provider yanıtının doğru güvenli bekleme durumuna projeksiyonu |
| `PROV-02` | Editoryal kalite kalibrasyonu | Hakları temiz temsilî corpus, bağımsız insan puanları, iddia/parite/SEO bulguları ve eşikler |
| `PROV-03` | Gerçek ImageGen | Başarı, büyük/hatalı yanıt, provenance bağı ve doğru fallback; ücretli fallback varsayılan kapalı |
| `DATA-01` | Gerçek archive restore | Aynı Windows kullanıcı profilinde ayrı disposable veri dizinine create/verify/preview/restore, satır/medya karşılaştırması ve kaynak workspace'in değişmemesi |
| `DATA-02` | Legacy migration | Disposable kopyada başarılı upgrade ve kesintili migration sonrası güvenli yeniden başlatma/geri dönüş |
| `DATA-03` | 24 saat davranışı | Sürekli pencere, overdue catch-up, günlük yedek, retention, restart ve duplicate-effect yokluğu |
| `DATA-04` | Kurulu masaüstü yaşam döngüsü | Tray, notification, autostart, exit ve yalnız app-owned child cleanup sonuçları |
| `SITE-01` | Site adapter clone provası | Disposable clone'da route/media/locale/canonical/hreflang/schema çıktılarının manifest eşleşmesi |
| `SITE-02` | Public site kontrolleri | Ayrı onaylarla DNS, public URL, hosting health/deploy kontrolleri ve Search Console kanıtı |
| `OPS-01` | Sahiplik ve tatbikatlar | Altı primary/backup rolü, onaylı contact-path proof ve gerekli beş tatbikatın imzalı kayıtları |

## Windows imzalama ve dağıtım

### `WIN-01` — sertifika ve custody kararı

1. Public-trust veya private-enterprise dağıtım hedefini yazılı olarak seçin.
2. Sağlayıcının güncel anahtar saklama, export, timestamp, revocation ve audit
   politikasını yetkili dokümanla doğrulayın. Public-trust modelinde sağlayıcı
   exportable PFX'e izin vermiyorsa workflow'a key export etmeyin; ayrı incelenmiş
   HSM/cloud signing entegrasyonu olmadan durun.
3. Sertifika sahibi ile farklı bir yedek atayın; rotation, expiry ve compromise
   playbook bağlantılarını kaydedin.
4. Bağımsız doğrulayan, seçilen modelin ADR 0007 ve yürürlükteki sağlayıcı/CA
   koşullarıyla uyumunu imzalar.

Kabul edilmez: kararın yalnız repository'de PFX secret adı bulunmasına dayanması,
private key'in export edilmesi veya secret değerinin kanıta alınması.

### `WIN-02` — korumalı environment

1. Ayrı onayla `windows-signing` environment'ını ve zorunlu reviewer politikasını
   oluşturun; self-approval ve koruma atlama davranışını kaydedin.
2. `OPE_WINDOWS_CERTIFICATE_PFX_BASE64` ve
   `OPE_WINDOWS_CERTIFICATE_PASSWORD` secret **adlarının** environment kapsamında
   bulunduğunu yalnız var/yok olarak doğrulayın.
3. `OPE_WINDOWS_CERTIFICATE_THUMBPRINT`, `OPE_WINDOWS_TIMESTAMP_URL` ve
   `OPE_UPDATE_SIGNER_SHA256` public değişkenlerinin biçimini ve onaylı kaynakla
   eşleşmesini doğrulayın. Kanıtta değerlerin tamamı yerine yalnız onaylı public
   fingerprint/pin kullanılabilir; secret değerleri hiçbir zaman alınmaz.
4. Aday koşunun protected environment onayı olmadan build job'una ulaşamadığını
   ve publication job'unun certificate secret'larını alamadığını doğrulayın.

### `WIN-03` — non-production imzalama koşusu

1. Tam commit SHA ve yeni, ayrıca onaylanmış SemVer/release notlarıyla
   `publish_release=false` adayını başlatın. Başka ref veya mevcut tag kullanılırsa
   koşu başarısız sayılır.
2. Workflow logunda certificate import öncesi store baseline, geçici import,
   cleanup ve cleanup doğrulamasının çalıştığını; secret değerinin maskeli bile
   loga yazılmadığını kontrol edin.
3. Uygulama, engine/fetcher/secure-restore sidecar'ları, paketlenmiş Sharp
   DLL/`.node` modülleri, NSIS ve MSI için exact dosya listesi çıkarın.
4. Her PE/installer için dosya SHA-256, `Valid` Authenticode, SHA-256 imza
   algoritması, RFC 3161 time-stamper ve beklenen signer certificate SHA-256
   eşleşmesini makine-okunur olarak kaydedin.
5. Negatif adayda bir public pini kontrollü olarak yanlış verin; artifact upload,
   attestation ve publish başlamadan fail-closed durduğunu doğrulayın. Bu deneme
   production secret'ını veya sertifikayı değiştirmemelidir.

### `WIN-04` — SBOM ve attestation

1. `WIN-03` koşusunun exact beş dosyalık payload manifestini ve SHA-256 listesini
   bağımsız doğrulayan yeniden üretir.
2. SPDX 2.3 belgesini parse edin; belge namespace'i, package/file kimlikleri ve
   payload ilişkisinin koşuya ait olduğunu doğrulayın.
3. GitHub provenance ve SBOM attestation subject'lerini API/UI üzerinden salt
   okunur alın; her subject name/digest çiftini payload listesiyle birebir
   karşılaştırın.
4. Eksik, fazla veya farklı digest varsa publication kapısı kapalı kalır. Bir
   attestation'ın yalnız var olması kabul değildir.

### `WIN-05` — temiz makine matrisi

Her satır temiz snapshot'tan başlar ve ayrı sonuç üretir: Windows 10 22H2 x64
clean install, güncel Windows 11 x64 clean install, N-1 → aday upgrade, bir byte'ı
değiştirilmiş download, indirme/kurulum kesintisi, zorlanmış installer hatası ve
önceki imzalı sürüme rollback.

1. Koşudan önce OS build, profil durumu, installer SHA-256 ve beklenen publisher
   pinini kaydedin.
2. N-1 üzerinde ayırt edilebilir yerel draft, schedule, queue ve medya fixture'ı
   oluşturun; secret veya production veri kullanmayın.
3. Her senaryoda görünür kullanıcı sonucu, kurulu sürüm, engine/PGlite/queue
   readiness ve fixture satır/medya hashlerini karşılaştırın.
4. Tamper, kesinti ve hata senaryoları eski çalışan sürümü/veriyi korumalı;
   imzasız veya yanlış yayıncılı artifact çalıştırılmamalıdır.
5. Rollback sonrası veri okunabilirliği ve updater'ın aynı hatalı artifact'i
   sonsuz döngüyle yeniden denemediği doğrulanır.

## GitHub authorization ve publication

### `GH-01` ve `GH-02` — App kaydı, sahiplik ve installation

1. Primary/backup App sahibini ve disposable ile production repository'lerini
   birbirinden ayırın.
2. GitHub App'te device flow ve expiring user authorization token davranışını
   etkinleştirin.
3. İzinlerin yalnız Metadata read, Contents write, Pull requests write, Checks
   read, Actions write ve Administration read olduğunu kaydedin. Ek izin varsa
   installation yapılmaz.
4. Installation'ı yalnız önceden onaylanan tek repository ile sınırlandırın.
5. Canlı registration/installation envanterini ikinci kişi yerel enforced
   contract ile karşılaştırır. Client secret, token ve device-flow doğrulama
   verisi kanıta girmez.

### `GH-03` — repository policy

1. Default branch, ruleset/branch protection, force-push/deletion politikası,
   review gereksinimi ve exact required-check adlarını canlı envanterleyin.
2. Workflow job adlarının required-check dizeleriyle birebir eşleştiğini test
   commit'i oluşturmadan önce doğrulayın.
3. Korumaların authorized App/operatör tarafından atlanıp atlanamadığını açıkça
   kaydedin; beklenmeyen bypass varsa prova başlamaz.

### `GH-04` — device token yaşam döngüsü

Disposable repository ve disposable Windows profili kullanın.

1. Native uygulamayla device authorization tamamlayın; credential'ın yalnız
   DPAPI-backed store'a gittiğini ve diagnostics/export/loglarda olmadığını
   doğrulayın.
2. Normal refresh'i ve provider'ın gerçek expiry davranışını gözlemleyin. Sistem
   saatini bozarak yapay expiry üretmeyin.
3. Ayrı onayla grant/installation'ı GitHub'da revoke edin; uygulamanın publication
   readiness'i kapattığını ve güvenli yeniden yetkilendirme istediğini doğrulayın.
4. Reauthorization sonrasında seçili repository ve exact permission kontrolünün
   yeniden çalıştığını kanıtlayın.

### `GH-05` — disposable publication provası

1. Production verisi içermeyen küçük bir Astro fixture repository'si, protected
   branch, exact checks ve no-op/non-production deploy workflow'u hazırlayın.
2. Bir kaynak için bilingual immutable revision ve exact hash-bound insan onayı
   üretin; onaydan sonra içerik/medya değiştirilince approval'ın geçersiz olduğunu
   negatif olarak doğrulayın.
3. Preview manifest → branch → PR → required checks → merge sırasını çalıştırın.
4. `blogbot/deploy-intents/<intent_key>` ve dispatch sözleşmesinin exact merge SHA
   üzerinde olduğunu; retry'nin ikinci dış etki üretmediğini doğrulayın.
5. Ayrı yetkiyle disposable ref cleanup'ı çalıştırın. Production environment,
   gerçek domain veya `publish_release=true` kullanılmaz.

## Provider ve editoryal kalite

### `PROV-01` — gerçek rate/quota davranışı

1. Sağlayıcının test/sandbox veya doğal olarak oluşmuş gerçek 429/quota sinyalini
   kullanın; ücret doğurmak, kotayı bilerek tüketmek veya hesap ayarı değiştirmek
   için yük üretmeyin.
2. HTTP/provider sınıfı, güvenli hata kodu, retry zamanı ve UI durumunu kaydedin;
   ham prompt, yanıt ve authorization verisini kaydetmeyin.
3. `RATE_LIMIT`/`USAGE_LIMIT` için yalnız idempotent manuel retry görünmeli;
   `PAID_FALLBACK_DISABLED` otomatik ücretli yola geçmemelidir.

Doğal/sandbox gerçek sinyal elde edilemiyorsa kapı `BLOCKED` kalır; sentetik yerel
fixture bu dış kapıyı geçirmez.

### `PROV-02` — hakları temiz kalite corpus'u

1. Türkçe haber türlerini, uzunlukları, yüksek riskli iddiaları, çelişkileri,
   kaynak çeşitliliğini ve çeviri güçlüklerini temsil eden hakları temiz bir
   corpus seçin. Lisans/kullanım dayanağını vaka kaydına bağlayın.
2. Beklenen iddia defteri ve olgusal kısıtları, model çıktısını görmeyen editörler
   hazırlar. Kaynak metni publishable makaleye kopyalamayın.
3. Her örneği özgünlük, claim coverage, kaynak bağı, çelişki, Türkçe kalite, SEO,
   TR→EN olgu paritesi ve risk yönlendirmesi bakımından en az iki insan inceler.
4. Kabul eşikleri ve kritik hata tanımı değerlendirmeden önce dondurulur. Kritik
   olgu/atıf/parite hatası olan örnek genel ortalamayla gizlenemez.
5. Kanıt paketi corpus'un kendisini değil izin kaydını, anonim örnek kimliklerini,
   puanları, anlaşmazlık çözümünü ve düzeltme backlog'unu tutar.

### `PROV-03` — gerçek ImageGen

1. Ayrı provider/kullanım onayıyla güvenli Windows ortamında gerçek bir başarı
   koşusu çalıştırın; brief, çıktı SHA-256, byte size, medya kaydı ve exact revision
   bağı arasındaki eşleşmeyi doğrulayın.
2. Provider'ın onaylı sandbox/hata aracıyla veya doğal gerçek yanıtla aşırı büyük
   ve başarısız yanıt yollarını çalıştırın. Hesabı/kotayı bozmak için yük üretmeyin.
3. Büyük/hatalı cevapta kalıcı kısmi medya veya yanlış `READY` durumu olmamalı;
   kullanıcıya gerçek fallback durumu gösterilmelidir.
4. Paid fallback ayrı olarak etkinleştirilmediyse kapalı kalır. Provider prompt'u,
   auth materyali ve hakları belirsiz çıktı kanıt paketine konmaz.

## Veri dayanıklılığı ve uzun çalışma

### `DATA-01` — gerçek archive restore

1. Gerçek kullanıcı arşivi için ayrıca veri işleme onayı alın; source workspace'i
   salt-okunur baseline satır/medya sayıları ve hashleriyle kaydedin.
2. Create → verify → preview adımlarını çalıştırın. Recovery key yalnız kullanıcı
   kontrolündeki güvenli kanalda kalır; ekran görüntüsü/log/kanıta girmez.
3. Restore'u aynı Windows kullanıcı profili altında ayrı disposable uygulama/veri
   dizinine yapın; mevcut DPAPI-korumalı veri anahtarının kurtarma sınırını koruyun.
   Mevcut kullanıcı workspace'inin üzerine yazmayın. Yeni Windows profiline veya
   başka makineye kurtarma bu kabulün kapsamı değildir ve desteklenmiş sayılmaz;
   yürürlükteki sınır [ADR 0003](../adr/0003-local-recovery-and-unsigned-update-boundaries.md)
   tarafından belirlenir. Arşivin recovery key'i tek başına bu sınırı kaldırmaz.
4. Beklenen satır, revision, approval, queue/schedule ve medya hashlerini restore
   ile karşılaştırın; source workspace baseline'ını yeniden alıp değişmediğini
   kanıtlayın.

### `DATA-02` — legacy ve kesintili migration

1. Desteklenen en eski fixture/profile'ın disposable kopyasını ve hashli
   baseline'ını hazırlayın; orijinale karşı yazmayı işletim sistemi izinleriyle
   engelleyin.
2. Bir kopyada normal upgrade'i, diğerinde belgelenmiş güvenli kesinti noktasında
   process termination'ı çalıştırın.
3. Yeniden başlatmada migration'ın atomik devam/rollback davranışını, şema
   sürümünü, satır/medya bütünlüğünü ve duplicate side effect olmadığını ölçün.
4. Veri kaybı, yarım şema veya manuel belirsiz onarım gereksinimi varsa kapı
   başarısızdır; fixture'ı üretim profilinden yeniden almayın.

#### Hesap gerektirmeyen yerel kesinti kanıtı

`tests/integration/legacy-migration-crash.test.ts`, güncel şemada sentetik eski
plaintext verisiyle gerçek şifreleme migration'ını sınar. İlk sayfa commit'inden
sonra yalnız sahipli child sonlandırılır; ham veritabanında eksik sentinel ve
checkpoint görülür, ardından yeniden açılışta veri hash'leri ve tamamlanma
karşılaştırılır. Migration tamamlandıktan sonraki sonlandırma kontrolü yanlış
başarıyı reddeder. Bu yerel kanıtın sonucu ve sınırları
[inceleme raporundadır](../audits/independent-review-20260905.md#data-01-and-data-02-bounded-acceptance-follow-up).
Gerçek tarihsel şema/DDL, en eski desteklenen profil, medya veya tüm kesinti
noktaları bu fixture ile kabul edilmiş sayılmaz; yukarıdaki DATA-02 kapısı açıktır.

### `DATA-03` — 24 saat gözlem

1. Sahip, başlangıç/bitiş UTC zamanı, Windows güç/oturum koşulları ve beklenen
   schedule/backup olaylarını önceden kaydedin. PC ve kullanıcı oturumu gözlem
   boyunca açık kalır; uyku/çıkış ayrı bir kesinti senaryosu olarak işaretlenir.
2. Pencereye geçmiş-due ve gelecek işler, günlük yedek sınırı ve retention
   değişimi gözlenebilecek disposable veri yerleştirin.
3. En az bir kontrollü uygulama restart'ı yapın; restart öncesi/sonrası durable
   job kimlikleri, attempt sayıları, yayın intent'leri ve backup manifestlerini
   karşılaştırın.
4. 24 saat sonunda overdue catch-up'ın bir kez çalıştığını, planlı işlerin
   kaybolmadığını, günlük yedeğin oluştuğunu, retention'ın yalnız kapsamındaki
   kopyalara dokunduğunu ve duplicate external effect olmadığını doğrulayın.

#### Hesap gerektirmeyen yerel gözlem

`DATA-03` için hesap gerektirmeyen yerel ön kanıt düzeneği de vardır:
`tests/soak/local-engine-24h.test.ts`. Varsayılan kısa ön kontrol, gerçek 24 saat
kanıtı değildir. `BLOGBOT_SOAK_MODE=24h` ile doğal gecikmiş yedek, sahipli motor
kesintisi/yeniden başlatması ve en az 24 saatlik gerçek zaman gözlenir. Bu mod
üretim zamanlayıcılarını hızlandırmaz; sentetik DB/anahtar ve ağsız yerel etki
sayacı kullanır. Kalıcı sonuç `build/verification/local-engine-soak/` altında
yazılır. Süreç canlılığı veya `RUNNING` kaydı kabul değildir; nihai
`PASS_LOCAL_ENGINE_24H`, temiz kapanış/temizlik ve Node exit 0 gerekir.
Bu test tek başına gerçek GitHub etkisini, kurulu desktop yaşam döngüsünü veya
bağımsız operatör kabulünü kapatmaz. Ayrıntı, koşuların durumu ve kanıt konumu
[`independent-review-20260905.md`](../audits/independent-review-20260905.md)
raporundadır.

### `DATA-04` — kurulu masaüstü yaşam döngüsü

Temiz profilde imzalı installer kullanarak tray göster/gizle, pencere kapatma,
uygulamadan çıkış, notification izin ver/reddet, autostart enable/disable ve
Windows login başlangıcını ayrı satırlar olarak test edin. Her satırda görünür UI
sonucu ile process envanterini eşleştirin. Çıkıştan sonra yalnız Blogbot'un sahip
olduğu engine/fetcher/restore child'ları sonlanmalı; ilgisiz Node/Rust/Edge
process'lerine dokunulmamalıdır. Autostart kaydı kaldırıldığında sonraki login'de
uygulama başlamamalıdır.

## Statik site ve operasyon

### `SITE-01` — disposable site clone'u

1. Yetkilendirilmiş site kaynağından secret ve production verisi içermeyen
   disposable clone hazırlayın; tam source commit SHA ve çalışma ağacı durumunu
   kaydedin.
2. `detect` ve `dryRun` ile schema/config yollarını, izinli dosya manifestini ve
   write/network-disabled sonucunu doğrulayın.
3. Test revision'ı materialize edin; TR/EN route, article type, canonical,
   hreflang, JSON-LD, media hash/size, RSS, sitemap ve redirect çıktısını beklenen
   manifestle karşılaştırın.
4. Unsupported schema, junction/hard-link escape, eksik immutable medya ve locale
   capability uyuşmazlığı negatiflerinde clone dışına yazılmadığını doğrulayın.
5. Production PR, merge veya deploy başlatmayın.

### `SITE-02` — DNS, public URL, hosting ve Search Console

Bu kapı tek bir toplu onay değildir. DNS yazması, hosting değişikliği, deployment,
Search Console property/ownership veya sitemap submission kendi dış yazmasından
hemen önce ayrı onay ister.

1. Onaylı public origin'in HTTPS, canonical host, certificate, DNS record/TTL ve
   redirect zincirini salt-okunur kaydedin.
2. Exact deployed merge SHA/release manifestini hosting health ve rollback
   hedefiyle bağlayın; sağlık, route, asset, cache ve SEO probe'larını çalıştırın.
3. Search Console'da yalnız seçilen origin/property, doğrulanmış ownership,
   coverage ve sitemap durumunu kaydedin. Hesap kimliği, cookie veya token kanıta
   girmez.
4. DNS ile served artifact, canonical URL veya Search Console property farklı
   origin'lere işaret ediyorsa production-ready kabul etmeyin.

### `OPS-01` — sahiplik ve tatbikatlar

1. [`release-incident-runbook.md`](./release-incident-runbook.md) içindeki altı
   rol için farklı primary/backup atayın ve onaylı contact-path etiketlerini
   doldurun. Kişisel iletişim bilgisi veya secret repository'ye yazmayın.
2. Her contact path'i test mesajı/çağrısıyla doğrulayın; dış mesaj için ayrıca
   onay alın ve yalnız teslim zamanı/sonucu kaydedin.
3. Sertifika rotation/compromise, GitHub App expiry/revocation, statik site
   staging rollback, redakte support-package ve release sign-off tatbikatlarını
   ayrı vaka kimlikleriyle tamamlayın.
4. Her tatbikatta beklenen ve gerçek karar süresi, kullanılan playbook, kanıt
   konumu, sapmalar ve takip sahibi bulunmalıdır.

## Kapanış ve bağımsız kabul

Her kapı için bağımsız doğrulayan şunları yeniden kontrol eder:

- yetkinin hedef, zaman, hesap/repository ve yazma türünü gerçekten kapsaması;
- source commit, artifact ve dış hedef kimliklerinin kanıt boyunca aynı kalması;
- negatif senaryonun beklenen yerde ve dış etki oluşturmadan fail-closed durması;
- kanıt manifestindeki her dosyanın SHA-256'sının yeniden hesaplanabilmesi;
- redaksiyon ve secret taramasının temiz olması;
- açık sapmaların sahipli ve süreli takip işine dönüşmesi.

Sonuç yalnız bundan sonra master checklist'te güncellenir. `FAIL` veya `BLOCKED`
koşu silinmez ya da `PASS` gibi özetlenmez; yeni koşu yeni vaka kimliği alır.
Production publication ve release, bütün dış kabul kapıları geçse bile ayrıca
nihai ve kapsamı açık insan onayı gerektirir.

## İlgili belgeler

- [Operasyonel onay kapıları](./approval-gates.md)
- [Yayın, olay ve geri alma runbook'u](./release-incident-runbook.md)
- [Statik site GitHub Actions dağıtım sözleşmesi](./github-actions-deploy.md)
- [Windows istemcisi önkoşulları](./windows-client-prerequisites.md)
- [Site desteği ve adaptör seçimi](./site-support.md)
- [ADR 0007: Pinned Authenticode update chain](../adr/0007-pinned-authenticode-update-chain.md)
- [ADR 0008: Repository-bound GitHub App device flow](../adr/0008-repository-bound-github-app-device-flow.md)
