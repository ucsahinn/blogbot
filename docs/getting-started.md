# Blogbot'u ilk kez kullanma

Blogbot'u açtığınızda tek yapmanız gereken dört kısa seçimdir:

1. **Kaynak ekle:** Haber sitesinin adresini, RSS/Atom bağlantısını veya OPML dosyasını yapıştırın. Blogbot **Test et** düğmesiyle kaynağın okunup okunamadığını gösterir.
2. **Hedef bölümü seç:** Her kaynak için projenizdeki uygun bölümü seçin (ör. haber, analiz, dosya veya rehber). Emin değilseniz “Önerilen” seçeneğini kullanın; son karar her zaman sizdedir.
3. **Yazı iste:** Haber adayını seçin veya “Anlık oluştur” ekranında ne aradığınızı yazın. Blogbot kaynak kanıtlarını gösterir ve taslağı insan onayına bırakır.
4. **İncele ve yayınla:** Türkçe ve İngilizce metni, kaynak/iddia eşleşmesini, görselleri ve planlanan zamanı kontrol edin. Onay vermeden hiçbir içerik siteye gönderilmez.

## Kurulum ekranındaki terimler

- **Yazı üretimi hesabı:** Mevcut Codex hesabınızı ayırt eden görünen ad. Giriş ayrı pencerede yapılır; parolanızı Blogbot'a yazmazsınız.
- **Sitenin GitHub deposu:** Sitenizin kodlarının bulunduğu GitHub projesi. Blogbot yalnız onaylanan değişiklik için PR açar.
- **Site projesi:** Bu bilgisayardaki site klasörü ve sitenin herkese açık adresi. Blogbot önce formatı test eder; desteklenmeyen site formatını yayınlamaz.
- **Yedekleme:** Blogbot'un şifreli yerel yedeklerini koyacağı klasör.

Bu alanları hemen doldurmak zorunda değilsiniz. Kaynak tarama ve yerel inceleme çalışır; hesap veya site bağlantısı hazır değilse yalnız o bağlantıya bağlı düğmeler pasif kalır.

## Blogbot ve yayın hedefi ilişkisi

Blogbot paneli, API'si veya veritabanı uzak sunucuda çalışmaz. Blogbot bu
bilgisayarda çalışır. Kurulumda üç hedeften birini seçersiniz: doğrudan bir
klasöre yazmak, yerel geliştirme projesine yazmak veya projenizin kendi GitHub/
CI yayın akışına bağlanmak. İlk iki seçenek için hosting, VPN veya sunucu paneli
gerekmez.

## Bilgisayar kapanırsa

Uygulama kapalıyken yeni tarama, taslak ve yayın işlemi yapılmaz. Yeniden açıldığında Blogbot kaldığı kuyruğu güvenle görür; geçmiş zamana otomatik yayın yapmaz ve gerekiyorsa sizden yeni onay ister.
