# Blogbot documentation

Belgeler okuyucu niyetine göre ayrılır.

## Öğrenmek

- [İlk kullanım](getting-started.md): teknik terimlere girmeden Blogbot'u açma,
  kaynak ekleme, bölüm seçme ve onaylama akışı.
- [README](../README.md): ürün özeti, aktif yerel mimari ve geliştirme
  başlangıcı.
- [Ürün kaydı](../PRODUCT.md): kullanıcı, iş hedefleri ve değişmez ürün
  kuralları.
- [Tasarım sistemi](../DESIGN.md): masaüstü arayüz ilkeleri.

## Bir işi yapmak

- [Windows istemcisi önkoşulları](operations/windows-client-prerequisites.md):
  Doctor kontrolleri ve son kullanıcı gereksinimleri.
- [Kurulum girdileri](operations/setup-inputs.md): sihirbazın istediği ve
  kesinlikle istemediği bilgiler.
- [Operasyonel onay kapıları](operations/approval-gates.md): hangi yerel veya
  dış işlemin ayrıca izin istediği.
- [GitHub Actions dağıtımı](operations/github-actions-deploy.md): örnek,
  environment-gated statik yayın workflow sözleşmesi.

## Başvurmak

- [Sistem mimarisi](architecture/system.md): aktif runtime, güven sınırları,
  yerel state ve yayın akışı.

## Kararları anlamak

- [ADR 0001](adr/0001-local-desktop-private-backend.md): tarihsel private
  backend kararı; ADR 0004 tarafından superseded.
- [ADR 0002](adr/0002-immutable-revisions-and-effective-once-publishing.md):
  değişmez revizyon ve effectively-once yayın kararı.
- [ADR 0003](adr/0003-runtime-isolation.md): tarihsel uzak topoloji ve korunan
  least-privilege amacı.
- [ADR 0004](adr/0004-local-first-runtime.md): aktif yerel Windows runtime
  kararı.

## Belge doğruluğu sınırı

Repository belgeleri yerel kod ve workflow sözleşmelerini açıklar. GitHub,
hosting, DNS, credential, production deploy, installer veya release durumu canlı
doğrulanmadıkça hazır/yayınlanmış kabul edilmez.
