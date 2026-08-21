# Blogbot documentation

Belgeler okuyucu niyetine göre ayrılır. Bu sayfa `docs/` altındaki her belgeyi
listeler; bir belge burada yoksa ya yeni eklenmiştir ya da kaldırılmalıdır.

## Öğrenmek

- [İlk kullanım](getting-started.md): teknik terimlere girmeden Blogbot'u açma,
  kaynak ekleme, bölüm seçme ve onaylama akışı.
- [Editör Boby kısa rehberi](boby-editor-guide.md): günlük kaynak → taslak →
  inceleme → yayın yolu ve bir şey takıldığında nereye bakılacağı.
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
- [Site desteği](operations/site-support.md): bir sitenin desteklenmesi için
  gereken adaptör sözleşmesi.
- [Site taşıma provası](operations/site-migration-dry-run.md): gerçek bir siteye
  bağlanmadan önce çalıştırılan salt okunur prova.
- [GitHub Actions dağıtımı](operations/github-actions-deploy.md): örnek,
  environment-gated statik yayın workflow sözleşmesi.

## Başvurmak

- [Sistem mimarisi](architecture/system.md): aktif runtime, güven sınırları,
  yerel state ve yayın akışı.
- [Site bağımsız ürün sınırı](architecture/site-neutral-product.md): çekirdek
  ürün ile uyumluluk adaptörü arasındaki ayrım.
- [Boby persona](boby/BOBY_PERSONA.md), [Boby prompt policy](boby/BOBY_PROMPT_POLICY.md),
  [Boby Codex routing](boby/BOBY_CODEX_ROUTING.md): asistanın kapsamı, istem
  politikası ve rol yönlendirmesi.

## Denetimler ve tamamlanma kanıtı

- [Master completion index (2026-08-20)](audits/OPE-MASTER-COMPLETION-INDEX-20260820.md):
  güncel 108/108 yerel kapatma defteri, faz matrisi ve dış kabul sınırları.
- [Uçtan uca yerel doğrulama (2026-08-20)](audits/end-to-end-verification-20260820.md):
  güncel komut kanıtı, final yeniden koşum durumu ve `UNVERIFIED_EXTERNAL`
  kabul defteri.
- [Master completion index (2026-08-19)](audits/OPE-MASTER-COMPLETION-INDEX-20260819.md):
  tarihsel baseline; 2026-08-20 indeksi tarafından supersede edildi.
- [Backend uçtan uca tamamlanma denetimi (2026-08-19)](audits/backend-completeness-audit-20260819.md):
  canonical bulguların tarihsel kaynak raporu; açık durum sayıları artık güncel
  değildir.
- [Master completion index (2026-08-18)](audits/OPE-MASTER-COMPLETION-INDEX-20260818.md)
- [Uçtan uca doğrulama ve düzeltme (2026-08-18)](audits/end-to-end-verification-20260818.md)
- [Dış doğrulama kapıları — operatör handoff](audits/external-gates-handoff-20260818.md)
- [Tamamlanma denetimi — final (2026-08-17)](audits/end-to-end-completion-audit-20260817-final.md)
- [Tamamlanma denetimi (2026-08-17)](audits/end-to-end-completion-audit-20260817.md)
- [Backend denetimi (2026-08-16)](audits/end-to-end-backend-audit-20260816.md)
- [Statik denetim düzeltme defteri (2026-08-11)](audits/static-audit-remediation-20260811.md)

## Kararları anlamak

- [ADR 0001](adr/0001-local-desktop-private-backend.md): tarihsel private
  backend kararı; ADR 0004 tarafından superseded.
- [ADR 0002](adr/0002-immutable-revisions-and-effective-once-publishing.md):
  değişmez revizyon ve effectively-once yayın kararı.
- [ADR 0003 — runtime isolation](adr/0003-runtime-isolation.md): tarihsel uzak
  topoloji ve korunan least-privilege amacı.
- [ADR 0003 — yerel kurtarma ve imzasız güncelleme](adr/0003-local-recovery-and-unsigned-update-boundaries.md):
  DPAPI profil sınırı ve imzasız updater'ın kabul edilen riski.
- [ADR 0004](adr/0004-local-first-runtime.md): aktif yerel Windows runtime
  kararı.
- [ADR 0005](adr/0005-durable-editorial-state.md): dayanıklı editoryal UI
  durumunun yerel engine'e ait olması kararı.

## Belge doğruluğu sınırı

Repository belgeleri yerel kod ve workflow sözleşmelerini açıklar. GitHub,
hosting, DNS, credential, production deploy, installer veya release durumu canlı
doğrulanmadıkça hazır/yayınlanmış kabul edilmez. Bir fazın yerel testlerinin
yeşil olması, o fazın gerçek kullanıcı yolunda çalıştığını kanıtlamaz; güncel
ayrım [2026-08-20 master indeksinde](audits/OPE-MASTER-COMPLETION-INDEX-20260820.md)
ve [yerel doğrulama kaydında](audits/end-to-end-verification-20260820.md) tutulur.
