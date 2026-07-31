# Site desteği ve adaptör seçimi

Blogbot belirli bir alan adına bağlı değildir. Kurulum merkezinde seçilen site
klasörü ve public adres, yayın hedefinin tek kaynağıdır.

V1'in doğrulanmış genel adaptörü Astro + strict content collection yapısıdır.
Kurulum dry-run şu dosyaları arar:

- `astro.config.mjs`, `astro.config.js` veya `astro.config.ts`
- `src/content.config.ts` / `src/content.config.js` veya `src/content/config.ts` / `config.js`
- `src/content` veya `src/pages`

İçerik şeması yoksa yayın güvenle kilitlenir; Blogbot mevcut site dosyalarını
şema bilinmeden ezmez. Önce siteyi desteklenen content collection sözleşmesine
dönüştürmek veya o site için yeni bir `SiteAdapterV2` eklemek gerekir.

Geçmiş projelere ait adaptörler yalnızca eski sözleşmeleri ve migration
fixture'larını koruyan uyumluluk paketleridir. Yeni kullanıcılar belirli bir
proje adı, hosting sağlayıcısı, VPN veya özel Blogbot sunucusu bilmeden kendi
projelerini seçebilir.

Yeni adaptör üç güvenli işlem uygular:

1. `detect`: seçilen klasörün formatını tanır.
2. `dryRun`: şema, route, dosya ve SEO sözleşmesini yazmadan doğrular.
3. `buildRevisionFiles`: yalnız onaylanmış değişmez revizyonun izinli dosyalarını üretir.

Adaptör dry-run başarısızsa taslak ve yerel inceleme kullanılabilir; yalnız PR,
merge ve deploy işlemleri kilitli kalır.
