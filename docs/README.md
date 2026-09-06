# Blogbot documentation

Current delivery scope: [unsigned manual delivery (ADR 0009)](adr/0009-unsigned-manual-delivery.md).
Certificate signing and external acceptance are deferred; source completion
does not claim an installer release or successful 24-hour soak.

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
- [Dış kabul doğrulama runbook'u](operations/external-acceptance-runbook.md):
  repository dışında kalan 20 kabul kapısının yetki, uygulama, fail-closed
  durdurma ve secret-safe kanıt sözleşmesi.
- [Yayın, olay ve geri alma runbook'u](operations/release-incident-runbook.md):
  sahiplik, olay müdahalesi, sertifika/depo ihlali, rollback ve release sign-off
  sözleşmesi.
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

- [İmzasız kaynak teslimatı (2026-09-06)](audits/unsigned-source-handoff-20260906.md):
  güncel yerel doğrulama, commit/push kapsamı ve sonraya bırakılan dış kontroller.
- [Master tamamlanma kontrol listesi (2026-09-03)](audits/OPE-MASTER-COMPLETION-CHECKLIST-20260903.md):
  OPE 0.1.54 çalışma ağacı için güncel ölçülen yerel kanıt, yerelde uygulanmış
  workflow sözleşmesi, tarihsel dış kabul defteri ve operatör kararları.
- [Güvenlik en iyi uygulamalar raporu (2026-09-03)](audits/security-best-practices-20260903.md):
  uygulanan yerel düzeltmeler ile onay/dış sistem gerektiren açık kapıların
  ayrımı.
- [Release SBOM and artifact attestation evidence review (2026-09-03)](audits/release-sbom-attestation-research-20260903.json):
  source-traceable official documentation, immutable action pins, permission
  boundary and remaining hosted-run uncertainty.
- [GitHub App authorization decision research (2026-09-03)](audits/github-app-auth-decision-research-20260903.json):
  official-source repository-selection, permission and expiring-token decision evidence.
- [Master completion index (2026-08-20)](audits/OPE-MASTER-COMPLETION-INDEX-20260820.md):
  OPE 0.1.38 tarihsel 108/108 yerel kapatma defteri, faz matrisi ve dış kabul
  sınırları; güncel 0.1.54 durumu için 2026-09-03 kontrol listesini kullanın.
- [Uçtan uca yerel doğrulama (2026-08-20)](audits/end-to-end-verification-20260820.md):
  OPE 0.1.38 için tarihsel komut kanıtı, final yeniden koşum durumu ve
  `UNVERIFIED_EXTERNAL` kabul defteri.
- [Master completion index (2026-08-19)](audits/OPE-MASTER-COMPLETION-INDEX-20260819.md):
  tarihsel baseline; 2026-08-20 indeksi tarafından supersede edildi.
- [Backend uçtan uca tamamlanma denetimi (2026-08-19)](audits/backend-completeness-audit-20260819.md):
  canonical bulguların tarihsel kaynak raporu; açık durum sayıları artık güncel
  değildir.
- [Master completion index (2026-08-18)](audits/OPE-MASTER-COMPLETION-INDEX-20260818.md)
- [Uçtan uca doğrulama ve düzeltme (2026-08-18)](audits/end-to-end-verification-20260818.md)
- [Dış doğrulama kapıları — tarihsel operatör handoff (2026-08-18)](audits/external-gates-handoff-20260818.md)
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
  DPAPI profil sınırı; imzasız updater riski ADR 0007 tarafından supersede
  edildi.
- [ADR 0004](adr/0004-local-first-runtime.md): aktif yerel Windows runtime
  kararı.
- [ADR 0005](adr/0005-durable-editorial-state.md): dayanıklı editoryal UI
  durumunun yerel engine'e ait olması kararı.
- [ADR 0006](adr/0006-backup-archive-cryptography-v2.md): yeni yedekler için
  sürümlü daha güçlü KDF ve v1 geri okuma kararı.
- [ADR 0007](adr/0007-pinned-authenticode-update-chain.md): fail-closed,
  yayıncı-pimli ve zaman damgalı Windows güncelleme güven zinciri.
- [ADR 0008](adr/0008-repository-bound-github-app-device-flow.md): one-repository
  GitHub App device flow, exact permissions, token rotation and reauthorization.
- [Tehdit modeli](architecture/threat-model.md): varlıklar, güven sınırları,
  saldırı yolları, kontroller ve dış doğrulama kapıları.

## Belge doğruluğu sınırı

Repository belgeleri yerel kod ve workflow sözleşmelerini açıklar. GitHub,
hosting, DNS, credential, production deploy, installer veya release durumu canlı
doğrulanmadıkça hazır/yayınlanmış kabul edilmez. Bir fazın yerel testlerinin
yeşil olması, o fazın gerçek kullanıcı yolunda çalıştığını kanıtlamaz; güncel
ayrım [2026-09-03 master tamamlanma kontrol listesinde](audits/OPE-MASTER-COMPLETION-CHECKLIST-20260903.md)
tutulur.
