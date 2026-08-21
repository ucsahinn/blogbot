# Statik site GitHub Actions dağıtım sözleşmesi

Bu belge Blogbot masaüstü uygulamasının onaylanmış bir statik site revizyonunu
GitHub üzerinden dağıtma sözleşmesini açıklar. Workflow dosyasının depoda
bulunması GitHub environment, secret veya hosting hedefinin hazır olduğunu
kanıtlamaz.

Blogbot runtime'ı uzak hosting'e kurulmaz. Uzak sistem yalnız merge edilmiş
statik siteyi barındırır; Blogbot API'si, veritabanı, kuyruğu veya işçisi orada
çalışmaz.

## Uygulamanın tetikleme sözleşmesi

Dağıtım ancak aşağıdaki yerel zincir tamamlandıktan sonra denenir:

1. İnsan onayı değişmez revizyon hashine bağlıdır.
2. Yayın önizlemesi aynı revizyon ve dosya hashlerine bağlıdır.
3. Pull request head SHA ve yapılandırılmış required check'ler yeniden doğrulanır.
4. Pull request merge edilir ve kesin merge_sha alınır.
5. Blogbot, onaylı yayın kimliği, revizyon ve merge_sha üzerinden 64 karakterlik hexadecimal intent_key üretir.
6. blogbot/deploy-intents/<intent_key> ref'i kesin merge_sha üzerinde oluşturulur veya aynı SHA ile var olduğu doğrulanır.
7. Yapılandırılmış workflow, bu intent ref'i üzerinde workflow_dispatch ile başlatılır.
8. Kabul edilen dispatch blogbot/deploy-dispatched/<intent_key> ref'iyle işaretlenir.

Workflow'un zorunlu girdileri yalnız şunlardır:

- intent_key: 64 karakter küçük harf hexadecimal dağıtım kimliği;
- merge_sha: yayımlanacak kesin Git merge commit SHA'sı.

Dispatch body'sinin sözleşmesi:

~~~yaml
ref: blogbot/deploy-intents/<intent_key>
inputs:
  intent_key: <intent_key>
  merge_sha: <merge_sha>
~~~

Yerel ve native publisher aynı ref adlarını ve aynı iki input'u kullanır.
Tekrar denemede Blogbot önce intent/dispatched marker'larını ve aynı intent
branch + merge SHA için mevcut workflow run'ını kontrol eder. Bu nedenle yerel
kayıt kaybolsa veya işlem dispatch sonrasında kesilse bile ikinci bir uzak
etki oluşturulmaz. Bir marker farklı SHA gösteriyorsa işlem fail-closed durur.

Workflow içeriği doğrudan merge_sha ile belirtilen merge sonucundan build
etmelidir. Uygulamanın üretmediği artifact_run_id, artifact_name, release_id
veya önceden hesaplanmış artifact sha256 alanları bu runtime sözleşmesinin
parçası değildir. Artifact üreten ayrı bir workflow kullanılacaksa onun
artifact kimliği ve bütünlük zinciri, bu merge-SHA sözleşmesinin ardından
workflow'un kendi güvenlik sınırı içinde kurulmalıdır.

## Production environment secret'ları

- DEPLOY_HOST: hosting hostname veya sabit IP;
- DEPLOY_USER: yalnız release helper çalıştırabilen kullanıcı;
- DEPLOY_ROOT: hedef sistemdeki versioned release dizini;
- DEPLOY_SSH_PRIVATE_KEY: yalnız GitHub production environment içinde tutulan deploy anahtarı;
- DEPLOY_SSH_KNOWN_HOSTS: önceden sabitlenmiş host fingerprint satırları.

Bu değerler Blogbot.exe'ye, yerel engine'e, PR build job'ına veya repository
dosyalarına verilmez. Masaüstü uygulaması Hetzner deploy anahtarı saklamaz.

## Workflow güvenlik adımları

1. workflow_dispatch dışında tetikleyici kabul edilmez.
2. intent_key ve merge_sha biçimleri doğrulanır.
3. Checkout/build kesin merge_sha üzerinden yapılır; hareketli branch yeniden çözülmez.
4. Üretilen statik site doğrulanır ve deployment tek bir production environment onayından geçer.
5. SSH anahtarı ve known_hosts yalnız geçici runner dosyalarına en dar izinlerle yazılır.
6. Versioned release uzak helper tarafından doğrulanır ve atomik etkinleştirilir.
7. Geçici credential dosyaları always() adımında silinir.

Workflow asgari izinlerle ve production deploy için tek concurrency kilidiyle
çalışmalıdır. Üçüncü taraf action'lar tam commit SHA'sına sabitlenmelidir.

## Yerel ve canlı kanıt sınırı

Repository testleri yalnız yerel sözleşmeyi ve idempotency davranışını kanıtlar:

~~~powershell
node --test --experimental-transform-types tests/unit/github-effects.test.ts
npm.cmd run native:test
~~~

Bu kontroller uzak dispatch veya deploy yapmaz. Aşağıdakiler ayrıca ve açık
operatör onayıyla canlı doğrulanmalıdır:

- GitHub production environment ve reviewer ayarı;
- workflow dosyasının hedef depoda varlığı ve input uyumu;
- required check adları;
- environment secret'ları;
- hosting kullanıcı/dizin izinleri;
- staging sağlık/SEO probe'u ve rollback tatbikatı.

İlk kurulum, credential yazımı, workflow dispatch, staging, production ve
rollback ayrı açık onay gerektirir.
