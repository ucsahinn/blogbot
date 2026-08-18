# OPE dış doğrulama kapıları — operatör handoff

Bu dosya yerel kaynak ve test zinciri yeşil olduktan sonra kalan gerçek dış doğrulama adımlarını tanımlar. Hiçbir token, cookie, private key veya auth dosyası repository'ye yazılmamalıdır.

## 1. Codex / Luna Low / Boby canlı smoke

Gerekli operatör durumu: aynı Windows kullanıcı profilinde Codex kurulumu ve güvenli login.

Yerel hazırlık:

```powershell
npm.cmd run build:engine
npm.cmd run smoke:engine
Start-Process "apps/desktop/src-tauri/target/release/blogbot.exe"
```

OPE içinde: Kurulum Merkezi → Codex'i bağla ve test et → Boby paneli → `naber`, `Kaynak nasıl eklenir?`, `Taslak nasıl oluşturulur?`.

Kanıt: Boby durumu yeşil `hazır`, cevaplar aynı panelde farklı ve anlamlı, draft isteği durable queue'da görünür; tanı paketinde token veya prompt içeriği bulunmaz.

## 2. Gerçek ImageGen provider

Gerekli operatör durumu: ImageGen anahtarı yalnızca Windows güvenli çalışma ortamına açıkça yapılandırılmış olmalıdır.

Kanıt: seçilen haberin brief'ine uygun özgün medya üretimi, SHA-256 medya kaydı, revision media reference ve aynı revision hash'e bağlı review görünümü. Provider hazır değilse OPE üretim iddiasında bulunmamalı ve `WAITING/DEGRADED` göstermelidir.

## 3. GitHub ve yayın dry-run

Gerekli operatör durumu: GitHub device authorization, seçilen repository, required checks ve site adapter hedefi.

OPE akışı: Kurulum Merkezi → Yayın bağlantısı → GitHub device flow → repository doğrula → required checks gir → yayın preview oluştur.

Kanıt: preview manifest exact revision hash ve adapter ile eşleşir; insan onayı olmadan enqueue oluşmaz; check'ler tamamlanmadan merge/deploy yapılmaz; remote token tanı paketine girmez.

## 4. Temiz Windows install/upgrade/rollback

Gerekli operatör durumu: temiz Windows profili veya izole VM ve release installer.

Yerel release öncesi:

```powershell
npm.cmd run check:all
npm.cmd run test:browser
npm.cmd run desktop:preflight:json
```

Kanıt: kurulumda CMD penceresi görünmez; OPE pencere başlığı doğru; engine/PGlite/queue hazır; updater her aşamayı görünür gösterir; başarısız hash veya yarım kurulumda eski sürüm korunur; rollback sonrası yerel veri okunabilir.

## 5. Yerel kapanış kanıtı

Bu handoff oluşturulduğu sırada yerel zincir şu şekilde doğrulanmıştır:

- `npm.cmd run check:all`: PASS
- Node: 502 test, 0 fail
- Browser: 137/137
- Native: 131/131
- Engine smoke: READY / PGlite ready / queue ready
- Security, npm audit, gitleaks: temiz
- Clippy, typecheck, lint, build, preflight: PASS

Bu dosyadaki dış kapılar credential/temiz makine olmadan yerel kaynakta tamamlanmış gibi işaretlenmemelidir.
