# Blogbot kurulum girdileri

Blogbot yerel bir Windows uygulamasıdır. Kullanıcıdan istenenler yalnızca günlük kullanım için gerekli seçimlerdir; teknik sunucu ayarları bu ekrana taşınmaz.

## Kullanıcı ne yapar?

1. Uygulamayı açar ve **Tümünü yeniden test et** düğmesine basar.
2. **Blogbot'un yerel çalışma bileşenini test et** ile uygulamanın kendi verisi ve kuyruğunu kontrol eder.
3. Kaynaklar ekranında URL, RSS/Atom, sitemap veya OPML ekler; **Test et** sonucu görmeden kaydetmez.
4. “Projede hangi bölüme gitsin?” seçiminden uygun bölümü seçer (ör. haber, analiz, dosya veya rehber).
5. İsterse yazı üretimi hesabını bağlar. Bağlantı yoksa tarama ve inceleme ekranı çalışmaya devam eder; yalnız taslak üretimi bekler.
6. Site klasörünü, GitHub deposunu ve yedek klasörünü bir kez seçer. Bu alanlar yayın gerektiğinde kullanılır.
7. Haftalık gün/saatleri seçer ve uygulamayı tepside çalışır bırakır.

## Uygulamanın kendisinin otomatik yaptığı kontroller

- Windows 10 22H2 veya Windows 11 x64
- Microsoft Edge WebView2
- Paketlenmiş Blogbot Engine, PGlite ve kalıcı yerel kuyruk
- Windows DPAPI/Credential Manager
- Disk alanı, yerel saat ve dosya yazma izinleri

Son kullanıcıdan Node.js, Rust, Visual Studio Build Tools, Docker veya ayrı PostgreSQL kurulumu istenmez.

## Kullanıcıdan istenebilecek bilgiler

- Bu bilgisayarı ayırt etmek için görünen cihaz adı
- Kaynak tarama aralığı (varsayılan 30 dakika)
- Otomasyon sınırı: yalnız tarama, taslak+inceleme veya onaylı yayın
- Yazı üretimi için mevcut Codex hesabının görünen etiketi
- Projenin bilgisayardaki klasörü; public adres yerel çalışma için isteğe bağlıdır ve yalnız yayın hedefinde gerekir
- Sitenin GitHub sahibi/kuruluşu ve depo adı
- Şifreli yedek klasörü

Bu alanlar biçim ve yol olarak test edilir. **Kaydet** işlemi yalnızca gizli olmayan ayarları yerel, şifreli engine durumuna yazar.

## Kullanıcıdan asla istenmeyenler

Blogbot hiçbir ekrana parola, token, cookie, Codex oturum dosyası, GitHub App private key, SSH anahtarı, PostgreSQL parolası veya SMTP parolası koymaz. Hesap yetkilendirmesi gerektiğinde işletim sisteminin ayrı giriş penceresi açılır; kullanıcı istemedikçe ücretli API çalıştırılmaz.

Uzak Blogbot API'si, VPN veya belirli bir hosting sağlayıcısı ayarı V1'de yoktur.
Yayın hedefi seçilirse sağlayıcı ve alan adı kullanıcının kendi projesinin workflow'u
olarak yapılandırılır; Blogbot belirli bir panele veya sunucuya bağlanmaz.

Proje henüz yayında değilse sorun değildir. Blogbot seçilen klasördeki proje
biçimini doğrular; `package.json` içinde `scripts.dev` varsa yerel geliştirme
sürecini isteğe bağlı olarak başlatabilir. Blogbot bu yerel sunucuya zorunlu bir
ağ bağlantısı açmaz. Public URL, canonical SEO ve yayın workflow'u yalnız yayın
hedefi seçildiğinde zorunlu olur.

## Bilgisayar kapalıyken

Yerel engine çalışmadığı için tarama, taslak, zamanlama ve yayın ilerlemez. Uygulama yeniden açıldığında kalıcı kuyruk kurtarılır; kaçırılan yayın geçmişe dönük otomatik çalıştırılmaz, kullanıcıdan yeni zaman/onay istenir.
### Site klasörü için üç seçenek

- **Yalnız bu bilgisayarda çalıştır:** Onaylı içerik paketi seçilen klasöre yazılır; public adres, GitHub veya hosting gerekmez.
- **Yerel geliştirme projesi:** `npm run dev` ile çalıştırdığınız klasöre yazılır; proje yayında olmasa da taslak ve yerel çıktı kullanılabilir.
- **Yayın hedefine bağla:** Public HTTPS adresi ve ayrı GitHub/workflow bağlantısı gerekir.

İlk iki seçenekte yayın alanları boş bırakılabilir. Blogbot yalnız seçtiğiniz klasörün içindeki, onaylı dosyalara yazar.
