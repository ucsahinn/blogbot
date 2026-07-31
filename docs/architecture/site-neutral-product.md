# Site bağımsız ürün sınırı

Blogbot genel amaçlı yerel bir içerik üretim ve yayın çalışma alanıdır. Kullanıcı
kurulum sihirbazında kendi sitesini seçer:

- bilgisayardaki site klasörü,
- herkese açık site adresi,
- GitHub sahibi ve depo adı,
- desteklenen site formatı/adaptörü,
- içerik bölümleri ve yayın kuralları.

Uygulamanın çekirdeği bu bilgileri kullanır; kullanıcı arayüzünde belirli bir
marka, alan adı veya proje adı varsayılan olarak gösterilmez. Kaynaklar, adaylar,
taslaklar, iddia denetimi, TR/EN üretimi, görsel kontrolü, onay, takvim,
yedekleme ve operasyon günlükleri tüm siteler için aynıdır.

## İlk adaptör ile ürün çekirdeği arasındaki fark

V1'de Astro tabanlı bir içerik sözleşmesini doğrulayan genel adaptör
paketlenmiştir. Geçmişteki siteye özel adaptörler yalnızca geriye dönük
uyumluluk ve fixture testleri içindir; Blogbot'un adı, ekranları veya veri modeli
herhangi bir siteye kilitlenmez. Başka bir kullanıcı farklı bir Astro site seçtiğinde, desteklenen
format ve bölüm sözleşmesi test edilir; uyuşmuyorsa yayın eylemi güvenle kilitli
kalır ve kullanıcıya hangi adaptörün gerektiği açıkça gösterilir.

Bu nedenle iki durum birbirine karıştırılmaz:

1. **Çekirdek ürün:** Her kullanıcının kendi sitesini bağladığı yerel Blogbot.
2. **Uyumluluk adaptörü:** Belirli bir projenin dosya, route, SEO ve içerik
   sözleşmesini bilen, yeni kullanıcılar için zorunlu olmayan paket.

Yeni site desteği, çekirdeği kopyalamadan yalnızca `@blogbot/site-adapter`
kaydındaki `detect`, `dryRun` ve `buildRevisionFiles` sözleşmesini uygulayan
yeni bir `SiteAdapterV2` paketi eklenerek sağlanır. Kullanıcıdan uzak Blogbot
paneli, özel API veya VPN bilgisi istenmez; hosting yalnız seçilen sitenin
statik çıktısı için isteğe bağlı yayın hedefidir.
