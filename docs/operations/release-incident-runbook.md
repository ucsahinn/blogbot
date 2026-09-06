# Yayın, olay ve geri alma runbook'u

Bu belge OPE masaüstü yayını, statik site dağıtımı, imzalama kimliği ve destek
paketleri için fail-closed operasyon sözleşmesidir. Bir işlemin burada
tanımlanması o işlemi yetkilendirmez veya yapıldığını kanıtlamaz. Dış sistem,
credential, rollback, release, publish ve deploy işlemleri
[`approval-gates.md`](./approval-gates.md) uyarınca hemen öncesinde ayrı ve açık
onay gerektirir.

Blogbot yerel bir Windows uygulamasıdır. PGlite, engine ve kalıcı kuyruk yerel
otorite olarak kalır; hosting yalnız onaylanmış statik siteyi sunar. Olay
müdahalesi hiçbir koşulda uzak Blogbot runtime'ı, uzak veritabanı veya masaüstü
uygulamasında hosting anahtarı oluşturmaz.

## Sahiplik kaydı

Aşağıdaki alanlar gerçek kişiler tarafından doldurulmadan yayın hazır değildir.
Birincil ve yedek kişi aynı olamaz. Bu dosyaya e-posta, telefon, token, anahtar,
sertifika veya başka bir secret yazılmaz; yalnız kurum içindeki kişi/ekip adı ve
onaylı iletişim kanalının etiketi yazılır.

| Rol | Birincil sahip | Yedek sahip | Onaylı iletişim kanalı | Son tatbikat tarihi |
| --- | --- | --- | --- | --- |
| Olay komutanı | Atanmadı | Atanmadı | Atanmadı | Yapılmadı |
| Nihai yayın onaylayıcısı | Atanmadı | Atanmadı | Atanmadı | Yapılmadı |
| Kod imzalama sertifikası sorumlusu | Atanmadı | Atanmadı | Atanmadı | Yapılmadı |
| GitHub App ve depo politikası sorumlusu | Atanmadı | Atanmadı | Atanmadı | Yapılmadı |
| Statik hosting/rollback operatörü | Atanmadı | Atanmadı | Atanmadı | Yapılmadı |
| Destek verisi sorumlusu | Atanmadı | Atanmadı | Atanmadı | Yapılmadı |

Rol ataması bir GitHub environment, secret, sertifika, uygulama kaydı, branch
protection veya hosting hedefi oluşturmaz. Bunların her biri canlı ve ayrı
kanıt ister.

## Ortak olay akışı

Her şüpheli durumda aşağıdaki sıra korunur:

1. **Durdur:** yeni release, update, site dispatch, otomatik merge ve publication
   başlatma. Çalışan dış bir işlem varsa onu değiştirmeden önce kapsam ve ayrı
   durdurma yetkisi doğrulanır.
2. **Koru:** yerel kullanıcı verisini, mevcut kurulu sürümü, imzalı artifact'i,
   tam commit SHA'yı, workflow run kimliğini, attestation kimliğini ve olay
   zamanlarını salt-okunur kaydet. Secret, token, PFX veya ham kullanıcı içeriği
   olay kaydına kopyalanmaz.
3. **Sınıflandır:** etkilenen sınırı `masaüstü yayın`, `güncelleme zinciri`,
   `GitHub App/depo`, `statik site`, `yerel veri` veya `destek verisi` olarak
   işaretle.
4. **Karar ver:** olay komutanı geri alma, credential iptali, sertifika iptali
   veya yeniden yayın seçeneklerinden hangisinin ayrı onaya sunulacağını yazar.
5. **Uygula:** yalnız onaylanan en dar playbook çalıştırılır. Bir önkoşul veya
   doğrulama eksikse işlem fail-closed durur.
6. **Doğrula:** beklenen sürüm/SHA, imza, public site sağlık sonucu ve yerel veri
   okunabilirliği bağımsız olarak kontrol edilir.
7. **Kapat:** olay kaydı kanıtlara bağlanır; geçici erişimler kaldırılır, destek
   kopyaları süre dolunca silinir ve takip işi atanır.

Asgari olay kaydı secret içermeyen şu alanları taşır:

- olay kimliği, UTC başlangıç/kapanış zamanı ve sınıfı;
- olayı açan sinyal ve kullanıcıya görünen güvenli hata kodu;
- etkilendiği doğrulanan sürüm, commit SHA, workflow run ve artifact SHA-256;
- alınan onayların kapsamı ve zamanı;
- uygulanan adımların sonucu, rollback hedefi ve doğrulama kanıtı;
- bilinen etki, çözülemeyen risk ve sonraki kontrol tarihi.

## Release öncesi durdurma koşulları

Aşağıdakilerden biri varsa release veya publish başlatılmaz:

- bu belgedeki gerekli rol sahiplerinden biri atanmamışsa;
- sürüm, release notu ve tam commit SHA ayrı ayrı onaylanmamışsa;
- çalışma ağacı veya oluşturulan payload beklenen kaynak SHA ile bağlanamıyorsa;
- `windows-signing` environment koruması, reviewer'ları veya gerekli isimler
  canlı olarak doğrulanmamışsa;
- sertifika sağlayıcısı ve anahtar saklama modeli ADR 0007'deki public-trust
  gereksinimiyle uyumlu değilse;
- yayıncı SHA-256 pini, certificate-store SHA-1 thumbprint'i veya RFC 3161
  timestamp URL'si eksik ya da uyuşmazsa;
- `secret-scan`, `build-signed` veya `attest` job'u başarısızsa;
- exact payload dosya seti, Authenticode zinciri, timestamp, publisher pin,
  SPDX SBOM veya attestation subject'leri yeniden doğrulanamıyorsa;
- temiz Windows 10/11, N-1 upgrade, hata/rollback ve veri okunabilirliği kabul
  kanıtı yoksa;
- açık bir P0/P1 olay veya çözülmemiş imzalama/depo/hosting ihlali varsa.

İlk aday koşusu `publish_release=false` ile sınırlandırılır. `publish` job'u için
ayrı bir nihai yayın onayı gerekir; önceki aday koşusu veya bu belge o onayın
yerine geçmez.

## Sertifika rotasyonu

Yayıncı pini bir trust-root değişikliğidir; olağan sürüm alanı gibi sessizce
değiştirilemez.

1. Sertifika sorumlusu yeni sağlayıcı/sertifika, saklama modeli, geçerlilik,
   revocation ve RFC 3161 uyumluluğunu belgelendirir. Secret değer kayda girmez.
2. Eski sertifika halen güvenilir ve kontrol altındaysa bir **geçiş sürümü** eski
   sertifikayla imzalanır; bu sürümün uygulaması yalnız yeni sertifikanın
   SHA-256 pinini içerecek şekilde ayrı incelenir.
3. Geçiş sürümü temiz makinede ve N-1 zincirinde doğrulanır. Eski kurulumdan
   geçiş sürümüne, ardından yeni sertifikayla imzalı sürüme yükseltme kanıtı
   alınmadan yeni sertifika normal kanala alınmaz.
4. Geçiş sürümü yeterli dağılıma ulaşmadan eski sertifika devre dışı bırakılmaz.
   Dağılım ölçütü ve bekleme süresi yayın onaylayıcısı tarafından olay/release
   kaydına yazılır.
5. Yeni pinli build ve yeni sertifikalı artifact aynı release gibi üretilemez;
   istemcinin kabul ettiği pin ile artifact imzalayan sertifika tam eşleşmelidir.

Eski sertifika kayıp, şüpheli veya iptal edilmişse bu overlap yolu kullanılmaz;
aşağıdaki compromise playbook'u çalışır.

## Sertifika şüphesi, compromise veya revocation

1. Yeni masaüstü release/update yayınını ve ilgili environment onaylarını
   durdur; mevcut kullanıcı kurulumlarını uzaktan çalıştırmaya veya silmeye
   çalışma.
2. Sertifika sorumlusu olayın thumbprint/fingerprint ve zaman aralığını secret
   içermeden kaydeder; private key materyalini inceleme paketine kopyalamaz.
3. CA veya signing provider üzerinden askıya alma/iptal işlemi ayrı credential
   ve hesap yetkisiyle yapılır. Sonuç ve zaman damgası kaydedilir.
4. GitHub `windows-signing` environment erişimi ve ilgili workflow yetkileri
   ayrı onayla dondurulur. Secret değerleri görüntülenmez veya dışa aktarılmaz.
5. Etkilenmiş olabilecek release'ler, artifact SHA-256'ları, attestation
   subject'leri ve imza zamanları belirlenir. Silme/yayından kaldırma veya
   güvenlik duyurusu ayrı yayın kararıdır.
6. Eski pinli istemci iptal edilmiş sertifikayla güvenli bir geçiş sürümünü
   kabul edemiyorsa otomatik updater için bypass eklenmez. Yeni trust root ile
   imzalı manuel kurtarma installer'ı, açık kullanıcı yönlendirmesi ve temiz
   makine kanıtı olan ayrı bir dağıtım yolu hazırlanır.
7. Yeni sertifika için tüm release kabul matrisi yeniden çalıştırılır; yalnız
   revocation işleminin tamamlanması yayın hazır olduğunu göstermez.

## GitHub App veya depo yetkisi olayı

Beklenmeyen repository erişimi, token refresh anomalisi, yanlış installation,
permission genişlemesi veya şüpheli publication görülürse:

1. Blogbot publication ve deploy akışını durdur; yerel taslak/inceleme verisini
   silme.
2. App sahibi installation'ı ve grant'i GitHub'da ayrı onayla revoke eder;
   secret/token değerini olay kaydına veya tanılama paketine koymaz.
3. Seçili depo, installation kimliği, tam izin seti, branch protection,
   required check adları ve etkilenmiş ref/run/release'ler salt-okunur yeniden
   envanterlenir.
4. Uygulamanın DPAPI-backed bundle'ı bir sonraki readiness kontrolünde
   fail-closed kalmalıdır. Yeniden bağlama, device flow ve token kalıcılığı yeni
   bir hesap/credential onayı gerektirir.
5. Beklenmeyen commit, ref, PR, merge, dispatch veya release bulunduysa bunları
   silmek/değiştirmek otomatik iyileştirme değildir; her hedef için ayrı dış
   yazma kararı alınır.

## Statik site geri alma

Statik site rollback'i masaüstü release rollback'inden ayrıdır. Hedef, daha önce
doğrulanmış versioned release'i atomik olarak tekrar etkinleştirmektir; Blogbot
runtime'ını hosting'e kurmak değildir.

1. Hosting operatörü mevcut public URL, etkin release kimliği, tam merge SHA ve
   sağlık/SEO sonucunu salt-okunur kaydeder.
2. Olay komutanı geri dönülecek daha önce doğrulanmış release kimliğini ve merge
   SHA'yı seçer. Hareketli branch adı veya yalnız tarih etiketi rollback hedefi
   olamaz.
3. Hedef release dizininin manifest/hash kanıtı yoksa rollback yapılmaz. Yeni
   build üretmek rollback olarak adlandırılmaz.
4. Ayrı rollback onayı alındıktan sonra hosting'in önceden incelenmiş helper'ı
   versioned release'i atomik olarak etkinleştirir. SSH anahtarı Blogbot'a veya
   olay kaydına verilmez.
5. Public HTTPS sağlık, beklenen canonical/locale rotaları, statik medya ve
   etkin merge SHA yeniden doğrulanır. Doğrulama başarısızsa trafik bilinmeyen
   bir sürüme ilerletilmez; olay açık kalır.
6. GitHub intent/dispatched ref'leri ve workflow run'ları olay kanıtı olarak
   korunur. Ref temizliği ayrı dış yazma yetkisi ister.

Hosting tarafındaki atomik helper ve versioned release düzeni canlı ortamda
henüz doğrulanmamıştır. Sağlayıcıya özgü kesin komut, dizin ve sağlık endpoint'i
ayrı staging tatbikatında kanıtlanıp bu belgeye secret içermeden eklenmelidir.

## Yerel veri kurtarma ve masaüstü rollback'i

- Kurulu sürüm hata verirse mevcut yerel çalışma alanı yerinde bırakılır;
  otomatik reset, temiz profil veya veri silme yapılmaz.
- Yedek önce doğrulanır ve **temiz, disposable bir Windows profiline** preview
  edilir. Satır/medya beklentisi ile şema ve sürüm uyumu kayda alınır.
- Mevcut kullanıcı verisinin üzerine restore, uygulama downgrade'i veya veri
  dizini değişimi hemen öncesinde ayrı açık onay ister.
- İmzalanmamış ya da publisher pini uyuşmayan eski installer rollback için
  çalıştırılmaz.
- Başarısız restore sonrasında orijinal workspace'in değişmediği salt-okunur
  karşılaştırmayla kanıtlanmadan olay kapanmaz.

## Destek paketi işleme

Uygulamadaki tanılama dışa aktarımı `%LOCALAPPDATA%\Blogbot\diagnostics` altında
benzersiz `blogbot-diagnostics-<zaman>-<pid>` klasörü oluşturur. Paket;
`manifest.json`, redakte edilmiş `diagnostics.json`, mevcutsa engine/bridge ve
startup loglarını içerir. Manifest, redaksiyonun uygulandığını, ham kaynak ve
makale metninin dışlanmasını bildirir; makale başlıkları kısa tek-yönlü özete
çevrilir.

Bu tasarım önemli bir savunmadır fakat paylaşım izni değildir. Her aktarımda:

1. Kullanıcı paketi uygulama içinden kendisi üretir; destek personeli ham
   `%LOCALAPPDATA%` dizinini toplamaz.
2. Destek verisi sorumlusu önce `manifest.json` dosyasını, sonra paketteki dosya
   adlarını ve metinleri manuel inceler. Token, cookie, authorization header,
   özel anahtar, bağlantı dizesi, mutlak kişisel yol, e-posta, ham kaynak veya
   makale metni görülürse paket paylaşılmaz ve olay güvenlik sınıfına yükseltilir.
3. Onaylanan paketin SHA-256'sı, dosya listesi, byte boyutları, olay kimliği ve
   alıcı kanalı kaydedilir; paketin içeriği olay kaydına kopyalanmaz.
4. Yalnız onaylanan paket ve yalnız tanımlı destek alıcısıyla, kullanıcı/destek
   sorumlusunun ayrı paylaşım onayından sonra aktarılır.
5. Yerel ve alıcı kopyaları olay kapandıktan sonra en geç 30 gün içinde silinir;
   daha uzun saklama hukuki/operasyonel gerekçe ve yeni onay ister. Silme kanıtı
   olay kaydına eklenir.

Tanılama export klasörleri için otomatik retention garantisi yoktur; bu nedenle
30 günlük sınır manuel sahiplik ve kapanış kontrolüdür. Bir support paketi
secret içeriyorsa redakte edip yeniden paylaşmak tek başına yeterli sayılmaz;
secret compromised kabul edilerek ilgili credential playbook'u uygulanır.

## Release sign-off kaydı

Nihai yayın onaylayıcısı aşağıdaki kanıtların her birini işaretlemeden
`publish_release=true` veya public dağıtım onayı vermez:

- [ ] Sürüm, release notu, tag ve tam commit SHA birbiriyle eşleşiyor.
- [ ] Repository secret taraması ve tüm yerel kalite kapıları geçti.
- [ ] `windows-signing` environment/reviewer ve public pinler canlı doğrulandı.
- [ ] İmzalama sağlayıcısı ve private-key custody modeli onaylandı.
- [ ] App, üç sidecar, paketlenmiş native Sharp modülleri, NSIS ve MSI için
      `Valid` Authenticode, RFC 3161 timestamp ve exact publisher kanıtı var.
- [ ] Beş dosyalık payload, SPDX SBOM ve provenance/SBOM attestation subject'leri
      exact SHA-256 değerleriyle eşleşiyor.
- [ ] Temiz Windows 10/11, N-1 upgrade, bozuk/yarıda kesilmiş update, rollback ve
      yerel veri okunabilirliği kabul matrisi geçti.
- [ ] GitHub App/depo installation'ı, branch protection ve required check'ler
      canlı doğrulandı.
- [ ] Açık P0/P1 olay yok; gerekli rol sahipleri ve yedekleri atanmış.
- [ ] Aday koşu `publish_release=false` tamamlandı ve public publish için yeni,
      kapsamı açık onay kaydedildi.

Sign-off kaydı onaylayıcı, UTC zaman, sürüm, commit SHA, workflow run, payload
SHA-256 listesi ve kanıt konumlarını içerir. Secret değer veya private key
materyali içermez.

## Tatbikat ve gözden geçirme

- Her public masaüstü release öncesi aday imzalama/attestation koşusu yapılır.
- Sertifika rotasyonu veya provider değişiminden önce geçiş tatbikatı yapılır.
- Statik site production açılmadan önce staging rollback tatbikatı yapılır.
- GitHub App ilk bağlandığında ve izinleri değiştiğinde expiry/revocation akışı
  disposable depoda sınanır.
- Bu runbook en az altı ayda bir ve her P0/P1 olaydan sonra gözden geçirilir.

Tatbikat sonucu tarih, sahip, kapsam, beklenen/gerçek sonuç, kanıt konumu ve açık
riskleri içerir. Tatbikat dış sisteme yazıyorsa hemen öncesinde ayrıca açık onay
alınır.

## İlgili karar ve sözleşmeler

- [Operasyon onay kapıları](./approval-gates.md)
- [Statik site GitHub Actions dağıtım sözleşmesi](./github-actions-deploy.md)
- [Site desteği ve adaptör seçimi](./site-support.md)
- [ADR 0007: Pinned Authenticode update chain](../adr/0007-pinned-authenticode-update-chain.md)
- [ADR 0008: Repository-bound GitHub App device flow](../adr/0008-repository-bound-github-app-device-flow.md)
- [OPE master completion checklist](../audits/OPE-MASTER-COMPLETION-CHECKLIST-20260903.md)
- [ADR 0009: Unsigned manual delivery](../adr/0009-unsigned-manual-delivery.md)
