# Örnek statik site GitHub Actions dağıtım sözleşmesi

Bu belge örnek bir yayın workflow'u sözleşmesini açıklar. Yeni kullanıcılar bu
sözleşmeyi kendi proje deposu, workflow adı ve hosting hedefine göre yapılandırır.
Workflow'un repository'de bulunması GitHub environment, secret veya hosting
hedefinin hazır olduğunu kanıtlamaz.

Blogbot runtime'ı uzak hosting'e bağlanmaz. Hosting yalnız doğrulanmış statik
site artifact'ını barındırır; Blogbot API'si, veritabanı, kuyruğu veya işçisi
orada çalışmaz.

## Mevcut tetikleme modeli

Workflow yalnız `workflow_dispatch` ile çalışır ve `production` environment
kapısından geçer. Şu girdileri zorunlu tutar:

- `artifact_run_id`: site artifact'ını üreten başarılı Actions run kimliği;
- `artifact_name`: projenin artifact adı;
- `release_id`: 16–64 karakter küçük harf hexadecimal release kimliği;
- `sha256`: beklenen 64 karakter SHA-256.

Pull request, push veya yerel Blogbot işlemi bu workflow'u mevcut haliyle
kendiliğinden başlatmaz. Planlanan tek-tık yayın bağlantısı tamamlanana kadar
otomatik ürün davranışı olarak belgelenmemelidir.

## Production environment secret'ları

- `DEPLOY_HOST`: projenin hosting hostname veya sabit IP'si;
- `DEPLOY_USER`: yalnız release helper çalıştırabilen deploy kullanıcısı;
- `DEPLOY_ROOT`: hedef sistemdeki release dizini;
- `DEPLOY_SSH_PRIVATE_KEY`: yalnız GitHub production environment içinde tutulan
  SSH anahtarı;
- `DEPLOY_SSH_KNOWN_HOSTS`: fingerprint'i önceden sabitlenmiş `known_hosts`
  satırları.

Bu değerler Blogbot.exe'ye, yerel engine'e, PR build job'ına veya repository
dosyalarına verilmez.

## Workflow adımları

1. Belirtilen Actions run'ından tek bir `.tar.gz` artifact indirilir.
2. `release_id`, `sha256`, artifact sayısı ve gerçek SHA-256 doğrulanır.
3. SSH anahtarı ve `known_hosts` yalnız geçici runner dosyalarına, `umask 077`
   ile yazılır.
4. Artifact ile hedef hosting ortamının
   kullanıcısına aktarılır.
5. Uzak helper `--apply` ile versioned release'i doğrular ve atomik olarak
   etkinleştirir.
6. Geçici credential dosyaları `always()` adımında silinir.

Workflow `contents: read` ve `actions: read` izinleriyle, production deploy için
tek concurrency kilidiyle çalışır. Üçüncü taraf action tam commit SHA'sına
sabitlenmiştir.

## Eksik production kanıtları

Bu repository denetiminde aşağıdakiler canlı olarak doğrulanmamıştır:

- GitHub `production` environment ve reviewer ayarı;
- secret değerleri;
- artifact üreten gerçek proje workflow'u;
- hosting deploy kullanıcısı ve dizinleri;
- staging sağlık/SEO probe'u ve rollback tatbikatı;
- Blogbot publisher'ın bu workflow'u başlatan son kullanıcı akışı.

İlk kurulum, secret yazımı, workflow dispatch, staging, production ve rollback
ayrı açık onay gerektirir.

## Yerel doğrulama

YAML ve script davranışı repository testleri içinde kontrol edilir:

```powershell
npm.cmd run test:integration
```

Bu komut yerel sözleşmeyi test eder; uzak deploy yapmaz ve uzak sistem
hazırlığını kanıtlamaz.
