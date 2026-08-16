import { parseOpmlSources } from "./app-model.ts";
import { BridgeError, type InvokeTransport } from "./bridge.ts";
import { createEditorialWorkspaceDemo } from "./editorial-demo-data.ts";
import type {
  BootstrapSnapshot,
  ConnectorStateSnapshot,
  DesktopPreferences,
  EditorialWorkspaceSnapshot,
  OperationsSnapshot,
  PrerequisiteSnapshot,
  ReviewRevision,
  SourceRecord,
  SourceTestResult
} from "./types.ts";

const demoBobyGuidance = new Map<string, unknown>();
let demoBobyGuidanceSequence = 0;

function createDemoBobyGuidance(question: string): {
  reply: string;
  suggestedActions: Array<{ id: string; label: string }>;
} {
  const normalized = question.toLocaleLowerCase("tr-TR");
  if (/(kaynak|rss|url|haber)/u.test(normalized)) {
    return {
      reply: "Kaynağı İçerik Akışı'nda ekle; önce adresi test et, sonra güven ve kullanım kararını görünür biçimde ver. Tarama yalnız onayladığın kaynaktan aday çıkarır.",
      suggestedActions: [{ id: "OPEN_CONTENT", label: "İçerik Akışı'nı aç" }]
    };
  }
  if (/(post|taslak|makale|içerik hazırla)/u.test(normalized)) {
    return {
      reply: "Bu konu için Yeni Taslak'ta kısa editoryal talimatı ve kaynakları seç. Taslak önce kanıt, iki dil ve görsel kontrolünden geçer; yayın onayı en son sende kalır.",
      suggestedActions: [{ id: "OPEN_INSTANT", label: "Yeni Taslak'ı aç" }]
    };
  }
  if (/(seo|yayın|takvim|slot)/u.test(normalized)) {
    return {
      reply: "Önce incelemede değişmez sürümü doğrula. Ardından Takvim ve Yayın'da yalnız onaylı taslağı uygun bir slota yerleştir; SEO kontrolü yayın öncesi paketle birlikte görünür.",
      suggestedActions: [{ id: "OPEN_PUBLISHING", label: "Takvim ve Yayın'ı aç" }]
    };
  }
  return {
    reply: "Sorunu aldım. Bulunduğun ekrandaki tek sonraki güvenli adımı birlikte seçelim; kaynak, taslak veya inceleme aşamasından hangisinde kaldığını yazabilirsin.",
    suggestedActions: [{ id: "OPEN_DASHBOARD", label: "Genel Bakış'ı aç" }]
  };
}

const connectorState: ConnectorStateSnapshot = {
  sourceState: "AVAILABLE",
  mode: "LOCAL_ONLY",
  configured: false,
  config: {
    codex: { accountLabel: "" },
    github: { owner: "", repository: "" },
    site: { repositoryPath: "", publicSiteUrl: "", mode: "LOCAL_ONLY" },
    deploy: { workflowName: "", requiredChecks: [] },
    backup: { folder: "" }
  },
  site: {
    repositoryPath: "",
    publicSiteUrl: "",
    adapterId: "local-folder-v1",
    adapterVersion: "1",
  },
  checks: {},
  localReadiness: "LOCAL_VALIDATED",
  externalReadiness: "NOT_CONFIGURED"
};

const prerequisites: PrerequisiteSnapshot = {
  checkedAtUnixMs: Date.now(),
  checks: [
    {
      id: "windows",
      label: "Desteklenen Windows",
      state: "READY",
      scope: "APP",
      detail: "Windows masaüstü çalışma zamanı hazır.",
      userAction: null
    },
    {
      id: "webview2",
      label: "Microsoft Edge WebView2",
      state: "READY",
      scope: "APP",
      detail: "Yerel arayüz motoru çalışıyor.",
      userAction: null
    },
    {
      id: "secure-store",
      label: "Windows güvenli anahtar deposu",
      state: "READY",
      scope: "APP",
      detail: "DPAPI geçici anahtar testi başarılı.",
      userAction: null
    },
    {
      id: "local-engine",
      label: "Paketlenmiş OPE Engine",
      state: "READY",
      scope: "WRITE",
      detail: "Yerel engine bu Windows oturumunda çalışıyor.",
      userAction: null
    },
    {
      id: "local-database",
      label: "Yerel PGlite veritabanı",
      state: "READY",
      scope: "WRITE",
      detail: "Şifreli yerel veri dizini açıldı ve yazma testi geçti.",
      userAction: null
    },
    {
      id: "local-queue",
      label: "Yerel iş kuyruğu",
      state: "READY",
      scope: "WRITE",
      detail: "Zamanlayıcı, retry ve dead-letter testi geçti.",
      userAction: null
    },
    {
      id: "local-database",
      label: "Yerel PGlite veritabanı",
      state: "READY",
      scope: "WRITE",
      detail: "Şifreli yerel veri deposu açıldı ve yazma testi geçti.",
      userAction: null
    },
    {
      id: "local-queue",
      label: "Yerel iş kuyruğu",
      state: "READY",
      scope: "WRITE",
      detail: "Retry, zamanlama ve dead-letter kuyruğu hazır.",
      userAction: null
    },
    {
      id: "codex",
      label: "Codex çalışma zamanı",
      state: "BLOCKED",
      scope: "WRITE",
      detail: "Bu demo istemcide gerçek yazı üretimi hesabı bağlantısı etkin değil.",
      userAction: "Codex bağlantısı hazır olana kadar taslak üretimi güvenle kilitli kalır."
    },
    {
      id: "clock",
      label: "Yerel zamanlayıcı",
      state: "READY",
      scope: "PUBLISH",
      detail: "Planlama bu bilgisayarın yerel saatini kullanır.",
      userAction: null
    },
    {
      id: "github",
      label: "GitHub yayın bağlantısı",
      state: "BLOCKED",
      scope: "PUBLISH",
      detail: "GitHub bağlantısı bu demo istemcide yapılandırılmadı.",
      userAction: "Yayın açılmadan önce seçili site deposu bağlanmalı."
    },
    {
      id: "backup",
      label: "İsteğe bağlı şifreli yedek",
      state: "BLOCKED",
      scope: "APP",
      detail: "Yedekleme hazır; henüz bir yedek klasörü seçilmedi.",
      userAction: "Kurulum Merkezi'nden yedek klasörü seçip recovery key oluşturun."
    },
    {
      id: "site-adapter",
      label: "Site yayın adaptörü",
      state: "BLOCKED",
      scope: "PUBLISH",
      detail: "Adaptör doğrulama kodu hazır; gerçek site deposu bağlantısı yapılmadı.",
      userAction: "Yayın öncesi repo, şema ve route dry-run doğrulanmalı."
    }
  ]
};

// Keep demo prerequisite snapshots aligned with the production contract even if
// a fixture is edited with a repeated check id.
prerequisites.checks = Array.from(
  new Map(prerequisites.checks.map((check) => [check.id, check])).values()
);

const sources: SourceRecord[] = [
  {
    id: "src-official",
    name: "Resmî duyurular (örnek)",
    url: "https://example.org/feeds/official.xml",
    kind: "RSS",
    health: "HEALTHY",
    section: "haberler",
    articleType: "news",
    lastCheckedAt: "2026-07-29T12:42:00.000Z",
    lastItemAt: "2026-07-29T11:18:00.000Z",
    discoveredFeeds: [],
    enabled: true,
    version: 1,
    language: "en",
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED",
    canPublish: true,
    blockers: []
  },
  {
    id: "src-industry",
    name: "Sektör güncellemeleri (örnek)",
    url: "https://example.org/feeds/industry.xml",
    kind: "RSS",
    health: "HEALTHY",
    section: "analiz",
    articleType: "analysis",
    lastCheckedAt: "2026-07-29T12:41:00.000Z",
    lastItemAt: "2026-07-29T08:34:00.000Z",
    discoveredFeeds: [],
    enabled: true,
    version: 1,
    language: "en",
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED",
    canPublish: true,
    blockers: []
  },
  {
    id: "src-site",
    name: "Proje duyuruları (örnek)",
    url: "https://example.org/updates/",
    kind: "SITE",
    health: "WARNING",
    section: "haberler",
    articleType: "news",
    lastCheckedAt: "2026-07-29T12:38:00.000Z",
    lastItemAt: "2026-07-28T16:05:00.000Z",
    discoveredFeeds: ["https://example.org/updates/feed.xml"],
    enabled: true,
    version: 1,
    language: "en",
    trustStatus: "PENDING",
    rightsStatus: "PENDING",
    canPublish: false,
    blockers: ["TRUST_REVIEW_REQUIRED", "RIGHTS_REVIEW_REQUIRED"]
  },
  {
    id: "src-guide",
    name: "Rehber kaynakları (örnek)",
    url: "https://example.org/guides/",
    kind: "SITE",
    health: "HEALTHY",
    section: "rehberler",
    articleType: "guide",
    lastCheckedAt: "2026-07-29T12:35:00.000Z",
    lastItemAt: "2026-07-27T14:22:00.000Z",
    discoveredFeeds: [],
    enabled: true,
    version: 1,
    language: "en",
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED",
    canPublish: true,
    blockers: []
  }
];

const bootstrap: BootstrapSnapshot = {
  onboardingComplete: false,
  capabilities: [
    "AUTOMATION.SET",
    "SOURCE.LIST",
    "SOURCE.TEST",
    "SOURCE.SAVE",
    "SOURCE.SCAN",
    "MUTATIONS.CORE"
  ],
  runtime: "ONLINE",
  connection: {
    engineRunning: true,
    engineLabel: "OPE Engine · bu bilgisayar",
    bridgeReady: true,
    latencyMs: 8,
    storageLabel: "PGlite · yerel ve şifreli",
    lastSyncAt: "2026-07-29T12:44:12.000Z"
  },
  automation: {
    mode: "PUBLISH_APPROVED",
    ingestionPaused: false,
    publishingPaused: false,
    scanIntervalMinutes: 15,
    timezone: "Europe/Istanbul",
    nextScanAt: "2026-07-29T13:00:00.000Z"
  },
  codex: {
    state: "READY",
    accountLabel: "Yazı üretimi · izole",
    queueDepth: 1,
    lastRunAt: "2026-07-29T12:31:00.000Z"
  },
  pipeline: [
    { label: "Keşfedilen", count: 18, tone: "neutral" },
    { label: "Araştırılan", count: 4, tone: "blue" },
    { label: "İnceleme", count: 3, tone: "amber" },
    { label: "Onaylı", count: 2, tone: "green" }
  ],
  queue: [
    {
      id: "rev-identity",
      title: "Yeni teknoloji geçişinde gözden kaçan üç risk",
      section: "analiz",
      state: "REVIEW_REQUIRED",
      sourceCount: 5,
      updatedAt: "2026-07-29T12:36:00.000Z",
      dueLabel: "Bugün 16:30",
      blockers: 0
    },
    {
      id: "rev-followup",
      title: "Yeni gelişmenin ilk 24 saati",
      section: "haberler",
      state: "NEEDS_SOURCE",
      sourceCount: 2,
      updatedAt: "2026-07-29T12:12:00.000Z",
      dueLabel: "Kaynak bekliyor",
      blockers: 1
    },
    {
      id: "rev-zero-trust",
      title: "Yeni bir hizmete geçiş rehberi",
      section: "rehberler",
      state: "APPROVED",
      sourceCount: 8,
      updatedAt: "2026-07-29T11:48:00.000Z",
      dueLabel: "Yarın 09:30",
      blockers: 0
    }
  ],
  sourceCount: 34,
  scheduledCount: 6
};

const review: ReviewRevision = {
  id: "rev-identity",
  revisionHash: "9f52c21326a63bd5e379863544485efd248156093d5522745360e470e197a504",
  articleId: "article-identity",
  state: "REVIEW_REQUIRED",
  section: "analiz",
  articleType: "analysis",
  author: "OPE Editorya",
  tags: ["örnek", "geçiş", "uygulama"],
  scheduledAt: "2026-07-29T13:30:00.000Z",
  adapterVersion: "site-adapter@1.0.0",
  tr: {
    title: "Yeni teknoloji geçişinde gözden kaçan üç risk",
    description:
      "Yeni bir teknolojiye geçiş verimli olabilir, ancak hazırlık planındaki boşluklar beklenmeyen sorunlar oluşturabilir.",
    slug: "yeni-teknoloji-gecisinde-gozden-kacan-uc-risk",
    bodyMarkdown:
      "Yeni teknoloji daha iyi bir deneyim sağlayabilir. Ancak geçiş planı yalnızca arayüzü değiştirmekten ibaret değildir.\n\nİlk risk, geri dönüş planının hazırlanmamasıdır. İkinci risk, ekiplerin sorumluluklarının belirsiz kalmasıdır. Üçüncü risk ise destek süreçlerinin yeni kullanım senaryolarına hazırlıksız olmasıdır.\n\nSağlam bir geçiş, teknik uygulamadan önce geri dönüş ve destek senaryolarının sınanmasını gerektirir."
  },
  en: {
    title: "Three risks organizations overlook during a technology migration",
    description:
      "A new technology can improve the experience, but gaps in the transition plan can create unexpected problems.",
    slug: "three-risks-organizations-overlook-during-a-technology-migration",
    bodyMarkdown:
      "A new technology can improve the experience, yet a migration involves much more than changing the interface.\n\nThe first risk is an untested rollback plan. The second is unclear ownership across teams. The third is support staff who are not prepared for new usage scenarios.\n\nA resilient migration tests rollback and support paths before technical rollout."
  },
  previous: {
    tr: {
      title: "Yeni teknoloji geçişinin üç riski",
      description: "Yeni teknoloji geçişinde dikkat edilmesi gereken noktalar.",
      slug: "yeni-teknoloji-gecisinin-uc-riski",
      bodyMarkdown:
        "Yeni teknoloji daha iyi bir deneyim sunabilir. Ekiplerin geri dönüş akışlarını da değerlendirmesi gerekir."
    },
    en: {
      title: "Three risks of a technology migration",
      description: "What to consider during a technology migration.",
      slug: "three-risks-of-a-technology-migration",
      bodyMarkdown:
        "A new technology can improve the experience. Teams should also review rollback flows."
    }
  },
  claims: [
    {
      id: "claim-1",
      text: "Yeni uygulama, doğrulama adımları sayesinde beklenen kullanım akışını korur.",
      locale: "both",
      status: "VERIFIED",
      sourceIds: ["snap-fido", "snap-google"]
    },
    {
      id: "claim-2",
      text: "Geri dönüş akışı, yeni bir uygulamanın en zayıf halkasına dönüşebilir.",
      locale: "both",
      status: "VERIFIED",
      sourceIds: ["snap-standard"]
    },
    {
      id: "claim-3",
      text: "Destek süreçleri yeni kullanım senaryolarıyla sınanmalıdır.",
      locale: "tr",
      status: "VERIFIED",
      sourceIds: ["snap-independent", "snap-standard"]
    }
  ],
  sources: [
    {
      id: "snap-fido",
      title: "Birincil kaynak · Uygulama rehberi",
      url: "https://example.org/guides/primary",
      fetchedAt: "2026-07-29T09:14:00.000Z",
      contentHash: "sha256:b4d1fido",
      primary: true
    },
    {
      id: "snap-standard",
      title: "Birincil kaynak · Uygulama standardı",
      url: "https://example.org/standards/primary",
      fetchedAt: "2026-07-29T09:16:00.000Z",
      contentHash: "sha256:87b2standard",
      primary: true
    },
    {
      id: "snap-google",
      title: "İkincil kaynak · Alan güncellemesi",
      url: "https://example.org/updates/secondary",
      fetchedAt: "2026-07-29T09:18:00.000Z",
      contentHash: "sha256:19c3goog",
      primary: false
    },
    {
      id: "snap-independent",
      title: "İkincil kaynak · Bağımsız değerlendirme",
      url: "https://example.org/analysis/secondary",
      fetchedAt: "2026-07-29T09:21:00.000Z",
      contentHash: "sha256:4a77independent",
      primary: false
    }
  ],
  gates: [
    {
      id: "gate-claims",
      label: "İddia kaynak eşleşmesi",
      detail: "3/3 iddia doğrulanmış kaynak anlık görüntülerine bağlı.",
      state: "PASS",
      group: "editorial",
      policyVersion: "demo-v1"
    },
    {
      id: "gate-originality",
      label: "Özgünlük ve kaynak ayrımı",
      detail: "Kaynak cümleleri kopyalanmamış; sentez özgün.",
      state: "PASS",
      group: "editorial",
      policyVersion: "demo-v1"
    },
    {
      id: "gate-title",
      label: "Başlık ve arama niyeti",
      detail: "Başlık içeriği dürüstçe temsil ediyor.",
      state: "PASS",
      group: "seo",
      policyVersion: "demo-v1"
    },
    {
      id: "gate-links",
      label: "İç bağlantılar",
      detail: "Bir ilişkili site rehberi eklendi.",
      state: "PASS",
      group: "seo",
      policyVersion: "demo-v1"
    },
    {
      id: "gate-schema",
      label: "Article şeması",
      detail: "Yazar, tarih, görsel ve çeviri bağı tamam.",
      state: "PASS",
      group: "seo",
      policyVersion: "demo-v1"
    },
    {
      id: "gate-urls",
      label: "Kaynak URL güvenliği",
      detail: "Özel ağ ve yönlendirme kontrolleri geçti.",
      state: "PASS",
      group: "editorial",
      policyVersion: "demo-v1"
    },
    {
      id: "gate-media",
      label: "Medya bütünlüğü",
      detail: "Dosya hash'leri ve boyut oranları doğrulandı.",
      state: "PASS",
      group: "editorial",
      policyVersion: "demo-v1"
    }
  ],
  media: [
    {
      id: "media-hero",
      role: "hero",
      filename: "technology-transition-hero.webp",
      width: 1600,
      height: 900,
      sha256: "sha256:bd95media",
      altTr: "Dijital anahtar ve kimlik doğrulama katmanları",
      altEn: "Digital key and layered identity verification"
    },
    {
      id: "media-inline",
      role: "inline",
      filename: "transition-flow.webp",
      width: 1200,
      height: 675,
      sha256: "sha256:a517media",
      altTr: "Yeni teknoloji geçişinde geri dönüş akışı",
      altEn: "Rollback flow during a technology migration"
    }
  ]
};

const operations: OperationsSnapshot = {
  events: [
    {
      id: "op-1",
      at: "12:42",
      title: "Kaynak taraması tamamlandı",
      detail: "34 kaynak kontrol edildi, 18 yeni aday bulundu.",
      state: "SUCCESS",
      correlationId: "scan_01J44H9"
    },
    {
      id: "op-2",
      at: "12:31",
      title: "Codex araştırma görevi tamamlandı",
      detail: "Örnek analiz için 5 kaynak ve 3 iddia üretildi.",
      state: "SUCCESS",
      correlationId: "run_01J44F2"
    },
    {
      id: "op-3",
      at: "12:18",
      title: "Kanıt bekleyen iş durduruldu",
      detail: "Bir iddia için ikinci bağımsız kaynak gerekli.",
      state: "BLOCKED",
      correlationId: "draft_01J44C7"
    },
    {
      id: "op-4",
      at: "11:55",
      title: "Yayın mutabakatı",
      detail: "Dış etkiler ve outbox kayıtları eşleşiyor.",
      state: "SUCCESS",
      correlationId: "recon_01J449A"
    }
  ],
  schedule: [
    {
      id: "sch-1",
      title: "Yeni teknoloji geçişinde gözden kaçan üç risk",
      at: "2026-07-29T13:30:00.000Z",
      section: "analiz",
      state: "APPROVED"
    },
    {
      id: "sch-2",
      title: "Sıfır güven mimarisine geçiş rehberi",
      at: "2026-07-30T06:30:00.000Z",
      section: "rehberler",
      state: "SCHEDULED"
    },
    {
      id: "sch-3",
      title: "Yeni gelişmenin ilk 24 saati",
      at: "2026-07-30T11:00:00.000Z",
      section: "haberler",
      state: "BLOCKED"
    }
  ],
  worker: {
    state: "HEALTHY",
    queueDepth: 7,
    oldestJobMinutes: 3
  },
  publisher: {
    state: "READY",
    outboxPending: 0,
    lastReconciledAt: "2026-07-29T11:55:00.000Z"
  }
};

function sourceTest(url: string): SourceTestResult {
  const lower = url.toLowerCase();
  const kind = lower.includes("atom")
    ? "ATOM"
    : lower.includes("feed") || lower.endsWith(".xml")
      ? "RSS"
      : "SITE";
  return {
    url,
    kind,
    title: new URL(url).hostname.replace(/^www\./u, ""),
    reachable: true,
    statusCode: 200,
    discoveredFeeds:
      kind === "SITE" ? [`${new URL(url).origin}/feed/`] : [],
    recommendation:
      kind === "SITE"
        ? "Site içinde bir RSS akışı bulundu; daha kararlı izleme için akışı seçin."
        : "Kaynak doğrudan akış olarak kullanılabilir."
  };
}

export function createDemoTransport(): InvokeTransport {
  const demoPrerequisites = structuredClone(prerequisites);
  const demoSources = structuredClone(sources);
  const demoBootstrap = structuredClone(bootstrap);
  const demoReview = structuredClone(review);
  const demoOperations = structuredClone(operations);
  const editorialWorkspace = createEditorialWorkspaceDemo();
  const demoScanStatuses = new Map<string, {
    operationId: string;
    complete: boolean;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    rejected: number;
    detail: string;
  }>();

  const queueDemoScan = (sourceId?: string) => {
    const operationId = `demo-scan-${sourceId ?? "all"}-${Date.now()}`;
    const scannedSources = sourceId ? 1 : 2;
    if (!editorialWorkspace.candidates.some((candidate) => candidate.id === "candidate-demo-scan-1")) {
      editorialWorkspace.candidates.unshift({
        id: "candidate-demo-scan-1",
        sourceId: sourceId ?? "src-official",
        title: "Yerel tarama sonucu: yeni haber",
        summary: "Kaydedilmiş kaynakta yeni bir içerik bulundu; araştırma ve taslak akışına alınmaya hazır.",
        primarySource: "Yerel taranan kaynak",
        sourceCount: 1,
        section: "haberler",
        articleType: "news",
        confidence: 85,
        duplicateScore: 0,
        discoveredAt: new Date().toISOString(),
        state: "NEW"
      });
    }
    demoScanStatuses.set(operationId, {
      operationId,
      complete: true,
      queued: 0,
      running: 0,
      succeeded: scannedSources,
      failed: 0,
      rejected: 0,
      detail: `${scannedSources} kaynak tarandı; 1 yeni haber adayı bulundu.`
    });
    return {
      accepted: true,
      operationId,
      detail: `${scannedSources} kaynak yerel tarama kuyruğuna alındı.`
    };
  };

  return async (command, args) => {
    switch (command) {
      case "open_project_page":
        return { opened: true };
      case "get_bootstrap_snapshot":
        return structuredClone(demoBootstrap);
      case "get_connector_state":
        return structuredClone(connectorState);
      case "get_prerequisite_status":
        demoPrerequisites.checkedAtUnixMs = Date.now();
        return structuredClone(demoPrerequisites);
      case "test_local_engine":
        return {
          ready: true,
          component: "local-engine",
          detail: "Yerel engine, PGlite ve iş kuyruğu çalışıyor."
        };
      case "recover_local_workspace":
        return { ready: true, detail: "Yeni yerel çalışma alanı hazır." };
      case "pick_local_folder":
        return "C:\\OPE-Demo";
      case "local_dev_status":
        return { running: false, supported: true };
      case "start_local_dev":
        return { running: true, directory: String(args?.path ?? "C:\\OPE-Demo") };
      case "stop_local_dev":
        return { running: false };
      case "get_engine_diagnostics":
        return { path: "C:\\OPE-Demo\\logs\\engine.stderr.log", lines: [] };
      case "export_diagnostics":
        return { path: "C:\\OPE-Demo\\diagnostics\\blogbot-diagnostics-demo.json", directory: "C:\\OPE-Demo\\diagnostics\\blogbot-diagnostics-demo", bytes: 0, included: ["engine", "operations", "startup"], opened: true };
      case "test_codex_runtime":
        return { available: true, authenticated: true, runnerReady: true, version: "demo", detail: "Demo çalışma alanında Codex bağlantısı hazır görünüyor." };
      case "start_codex_login":
        return { started: true, detail: "Demo giriş akışı başlatıldı; gerçek uygulamada Codex giriş penceresi açılır." };
      case "test_setup_connector":
        return { ready: true, writes: false, network: false, detail: "Kurulum alanları demo çalışma alanında doğrulandı." };
      case "save_setup_connector": {
        const input = args as { connector?: unknown; config?: unknown } | undefined;
        const connector = input?.connector;
        const config = input?.config;
        if (connector === "site" && config && typeof config === "object") {
          const site = config as Partial<ConnectorStateSnapshot["config"]["site"]>;
          const repositoryPath = typeof site.repositoryPath === "string" ? site.repositoryPath : "";
          const publicSiteUrl = typeof site.publicSiteUrl === "string" ? site.publicSiteUrl : "";
          const mode = site.mode === "LOCAL_DEV" || site.mode === "PUBLISH" ? site.mode : "LOCAL_ONLY";
          connectorState.config.site = { repositoryPath, publicSiteUrl, mode };
          connectorState.mode = mode;
          connectorState.configured = Boolean(repositoryPath || publicSiteUrl);
          connectorState.site.repositoryPath = repositoryPath;
          connectorState.site.publicSiteUrl = publicSiteUrl;
        }
        if (connector === "deploy" && config && typeof config === "object") {
          const deploy = config as Partial<ConnectorStateSnapshot["config"]["deploy"]>;
          connectorState.config.deploy = {
            workflowName: typeof deploy.workflowName === "string" ? deploy.workflowName : "",
            requiredChecks: Array.isArray(deploy.requiredChecks)
              ? deploy.requiredChecks.filter((check): check is string => typeof check === "string")
              : []
          };
        }
        return { ready: true, writes: true, network: false, detail: "Kurulum alanları demo çalışma alanında doğrulandı." };
      }
      case "github_device_flow_start":
        return { started: true, writes: false, network: false, userCode: "DEMO-CODE", verificationUri: "https://github.com/login/device", detail: "Demo GitHub cihaz akışı hazır." };
      case "github_device_flow_status":
        return { status: "authorized", writes: false, network: false, scopes: ["repo"], detail: "Demo GitHub bağlantısı hazır." };
      case "backup_create":
        return { outputPath: String(args?.outputPath ?? "C:\\OPE-Demo\\blogbot.backup"), archiveSha256: "0".repeat(64), bytes: 0, entries: 0 };
      case "backup_verify":
        return { archivePath: String(args?.archivePath ?? ""), sha256: "0".repeat(64), verified: true, entries: [] };
      case "backup_restore_preview":
        return { archivePath: String(args?.archivePath ?? ""), targetDirectory: String(args?.targetDirectory ?? ""), entries: [] };
      case "backup_restore_apply":
        return { restored: true, targetDirectory: String(args?.targetDirectory ?? ""), entries: 0 };
      case "autostart_status":
        return { enabled: false };
      case "set_autostart":
        return { enabled: Boolean(args?.enabled) };
      case "send_test_notification":
        return { shown: true };
      case "list_sources":
        return { sources: structuredClone(demoSources) };
      case "review_source": {
        const sourceId = String(args?.sourceId ?? "");
        const source = demoSources.find((item) => item.id === sourceId);
        if (!source || source.version !== Number(args?.expectedVersion)) {
          throw new Error("Kaynak güncellendi. Envanteri yenileyip incelemeyi tekrar deneyin.");
        }
        const reviewedAt = new Date().toISOString();
        const rationale = String(args?.rationale ?? "").trim();
        if (rationale.length < 10) throw new Error("İnceleme gerekçesi en az 10 karakter olmalıdır.");
        source.trustStatus = args?.trustStatus === "REJECTED" ? "REJECTED" : "APPROVED";
        source.rightsStatus = args?.rightsStatus === "REJECTED" ? "REJECTED" : "APPROVED";
        source.trustReview = { reviewedAt, rationale };
        source.rightsReview = { reviewedAt, rationale };
        source.version += 1;
        source.canPublish = source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED";
        source.blockers = source.canPublish ? [] : ["TRUST_REJECTED", "RIGHTS_REJECTED"];
        return { source: structuredClone(source) };
      }
      case "test_source":
        return sourceTest(String(args?.url ?? ""));
      case "preview_opml": {
        const input = String(args?.input ?? "");
        if (/^https?:\/\//u.test(input.trim())) {
          return {
            urls: [
              "https://example.org/feeds/example.xml",
              "https://example.org/research/feed/"
            ]
          };
        }
        return { urls: parseOpmlSources(input).accepted };
      }
      case "save_sources": {
        const incoming = Array.isArray(args?.sources) ? args.sources : [];
        const added = incoming.map((item, index) => {
          const value = item as {
            url: string;
            section: SourceRecord["section"];
            articleType: SourceRecord["articleType"];
            kind?: SourceRecord["kind"];
            language?: SourceRecord["language"];
            title?: string;
          };
          return {
            id: `src-demo-${demoSources.length + index + 1}`,
            name: value.title?.trim() || new URL(value.url).hostname,
            url: value.url,
            kind: value.kind ?? sourceTest(value.url).kind,
            health: "HEALTHY" as const,
            section: value.section,
            articleType: value.articleType,
            lastCheckedAt: new Date().toISOString(),
            lastItemAt: null,
            discoveredFeeds: sourceTest(value.url).discoveredFeeds,
            enabled: true,
            version: 1,
            language: value.language ?? ("unknown" as const),
            trustStatus: "PENDING" as const,
            rightsStatus: "PENDING" as const,
            canPublish: false,
            blockers: ["TRUST_REVIEW_REQUIRED", "RIGHTS_REVIEW_REQUIRED"]
          };
        });
        demoSources.push(...added);
        demoBootstrap.sourceCount += added.length;
        return { sources: structuredClone(added) };
      }
      case "scan_source":
        return queueDemoScan(String(args?.sourceId ?? ""));
      case "scan_all_sources":
        return queueDemoScan();
      case "get_source_scan_status": {
        const operationId = String(args?.operationId ?? "");
        const status = demoScanStatuses.get(operationId);
        if (!status) throw new BridgeError("COMMAND_FAILED", "Tarama durumu bulunamadı.");
        return structuredClone(status);
      }
      case "create_instant_draft": {
        const request = args?.request as { instruction?: unknown; targetSection?: unknown } | undefined;
        const id = `draft-demo-${Date.now()}`;
        const instruction = typeof request?.instruction === "string" && request.instruction.trim()
          ? request.instruction.trim()
          : "Yeni içerik araştırması";
        const section = typeof request?.targetSection === "string" ? request.targetSection : "haberler";
        editorialWorkspace.drafts.unshift({
          id,
          titleTr: instruction,
          titleEn: "English localization will be prepared after research",
          section: section as EditorialWorkspaceSnapshot["drafts"][number]["section"],
          completion: 8,
          blockers: 0,
          updatedAt: new Date().toISOString(),
          scheduledAt: null,
          state: "DRAFTING",
          reviewable: false,
          detail: "Yazı üretimi hesabı veya izole runner bekleniyor."
        });
        return { id, state: "RESEARCHING", queueState: "QUEUED" };
      }
      case "request_boby_guidance": {
        const request = args?.request as { question?: unknown } | undefined;
        const id = `boby-demo-${Date.now()}-${++demoBobyGuidanceSequence}`;
        const question = typeof request?.question === "string" ? request.question.trim() : "";
        const guidance = createDemoBobyGuidance(question);
        demoBobyGuidance.set(id, {
          id,
          state: "SUCCEEDED",
          ...guidance
        });
        return { id, state: "QUEUED" };
      }
      case "get_boby_guidance": {
        const id = String(args?.guidanceId ?? "");
        const result = demoBobyGuidance.get(id);
        if (!result) throw new BridgeError("COMMAND_FAILED", "Boby rehberlik isteği bulunamadı.");
        return structuredClone(result);
      }
      case "get_review_revision":
        return structuredClone(demoReview);
      case "approve_revision": {
        const expectedHash = String(args?.expectedHash ?? "");
        if (expectedHash !== demoReview.revisionHash) {
          throw new BridgeError(
            "COMMAND_FAILED",
            "Revizyon değişti; onaylamadan önce güncel sürümü açın."
          );
        }
        demoReview.state = "APPROVED";
        return {
          approvedAt: new Date().toISOString(),
          revisionHash: demoReview.revisionHash,
          state: demoReview.state
        };
      }
      case "approve_high_risk_revision": {
        const request = args?.request as Record<string, unknown> | undefined;
        const expectedHash = String(request?.expectedHash ?? "");
        if (expectedHash !== demoReview.revisionHash || request?.confirmReauthenticated !== true) {
          throw new BridgeError("COMMAND_FAILED", "Yüksek risk onayı güncel revizyon ve yeniden kimlik doğrulaması gerektirir.");
        }
        demoReview.highRiskApproved = true;
        demoReview.state = "APPROVED";
        return { revisionHash: demoReview.revisionHash, state: demoReview.state };
      }
      case "preview_publication": {
        const revisionId = String(args?.revisionId ?? "");
        const revisionHash = String(args?.revisionHash ?? "");
        if (revisionId !== demoReview.id || revisionHash !== demoReview.revisionHash) {
          throw new BridgeError("COMMAND_FAILED", "Yayın önizlemesi güncel revizyona bağlı olmalıdır.");
        }
        return { previewHash: demoReview.revisionHash };
      }
      case "materialize_local_preview": {
        const revisionId = String(args?.revisionId ?? "");
        const revisionHash = String(args?.revisionHash ?? "");
        const previewHash = String(args?.previewHash ?? "");
        const targetDirectory = String(args?.targetDirectory ?? "").trim();
        if (
          demoReview.state !== "APPROVED" ||
          revisionId !== demoReview.id ||
          revisionHash !== demoReview.revisionHash ||
          previewHash !== demoReview.revisionHash ||
          !targetDirectory
        ) {
          throw new BridgeError("COMMAND_FAILED", "Yerel çıktı yalnız onaylı, değişmez yayın önizlemesinden hazırlanabilir.");
        }
        return { written: 0, backupDirectory: null };
      }
      case "enqueue_publication": {
        const revisionId = String(args?.revisionId ?? "");
        const revisionHash = String(args?.revisionHash ?? "");
        const previewHash = String(args?.previewHash ?? "");
        if (
          demoReview.state !== "APPROVED" ||
          revisionId !== demoReview.id ||
          revisionHash !== demoReview.revisionHash ||
          previewHash !== demoReview.revisionHash
        ) {
          throw new BridgeError("COMMAND_FAILED", "Yayın kuyruğu yalnız onaylı, değişmez önizlemeyi kabul eder.");
        }
        return { ok: true };
      }
      case "get_operations":
        return structuredClone(demoOperations);
      case "get_editorial_workspace":
        return structuredClone(editorialWorkspace);
      case "promote_candidate": {
        const candidateId = String(args?.candidateId ?? "");
        const candidate = editorialWorkspace.candidates.find(
          (item) => item.id === candidateId
        );
        if (!candidate) {
          throw new BridgeError("COMMAND_FAILED", "Haber adayı bulunamadı.");
        }
        const needsSource = candidate.state === "NEEDS_SOURCE";
        const wasDiscovered = candidate.state !== "DISMISSED" && candidate.state !== "PROMOTED" && candidate.state !== "RESEARCH_QUEUED";
        candidate.state = "RESEARCH_QUEUED";
        const draftId = `draft-candidate-${candidateId}`;
        const alreadyQueued = editorialWorkspace.drafts.some((item) => item.id === draftId);
        if (!alreadyQueued) {
          editorialWorkspace.drafts.unshift({
            id: draftId,
            titleTr: candidate.title,
            titleEn: "English localization will be prepared after research",
            section: candidate.section,
            completion: null,
            blockers: needsSource ? 1 : 0,
            updatedAt: new Date().toISOString(),
            scheduledAt: null,
            state: needsSource ? "NEEDS_SOURCE" : "DRAFTING",
            reviewable: false,
            detail: needsSource
              ? "Araştırma başlatılmadan önce ikinci bağımsız kaynak gerekli."
              : "Araştırma güvenli yerel kuyruğa alındı."
          });
        }
        if (wasDiscovered) {
          demoBootstrap.pipeline[0]!.count = Math.max(0, demoBootstrap.pipeline[0]!.count - 1);
        }
        if (!alreadyQueued) {
          demoBootstrap.pipeline[1]!.count += 1;
        }
        return { ok: true, state: "RESEARCH_QUEUED", job: { id: draftId } };
      }
      case "dismiss_candidate": {
        const candidateId = String(args?.candidateId ?? "");
        const candidate = editorialWorkspace.candidates.find(
          (item) => item.id === candidateId
        );
        if (!candidate) {
          throw new BridgeError("COMMAND_FAILED", "Haber adayı bulunamadı.");
        }
        const wasDiscovered = candidate.state !== "DISMISSED" && candidate.state !== "PROMOTED" && candidate.state !== "RESEARCH_QUEUED";
        candidate.state = "DISMISSED";
        if (wasDiscovered) {
          demoBootstrap.pipeline[0]!.count = Math.max(0, demoBootstrap.pipeline[0]!.count - 1);
        }
        return { ok: true };
      }
      case "retry_job": {
        const jobId = String(args?.jobId ?? "");
        const failure = editorialWorkspace.failures.find((item) => item.id === jobId);
        const draft = editorialWorkspace.drafts.find(
          (item) => item.id === jobId && !item.reviewable
        );
        if (!failure && !draft) {
          throw new BridgeError("COMMAND_FAILED", "Tekrar denenecek iş bulunamadı.");
        }
        if (failure) {
          failure.state = "RETRYING";
          failure.attempts += 1;
          failure.lastAttemptAt = new Date().toISOString();
        }
        if (draft) {
          draft.state = "DRAFTING";
          draft.executionState = "RETRY_SCHEDULED";
          draft.nextAction = "NONE";
          draft.reasonCode = null;
          draft.blockers = 0;
          draft.detail = "İş güvenli yerel kuyrukta yeniden deneniyor.";
          draft.updatedAt = new Date().toISOString();
        }
        return { ok: true };
      }
      case "request_revision_edit": {
        const revisionId = String(args?.revisionId ?? "");
        const instruction = String(args?.instruction ?? "").trim();
        const title = String(args?.title ?? "").trim() || "Düzenleme talebini işliyor";
        if (revisionId !== demoReview.id || instruction.length < 10) {
          throw new BridgeError(
            "COMMAND_FAILED",
            "Revizyon ve en az 10 karakterlik düzenleme talimatı gerekir."
          );
        }
        demoReview.state = "REVIEW_REQUIRED";
        const jobId = `draft-edit-${Date.now()}`;
        editorialWorkspace.drafts.unshift({
          id: jobId,
          titleTr: title,
          titleEn: "Preparing the requested revision",
          section: "analiz",
          completion: 15,
          blockers: 1,
          updatedAt: "Yerel kuyruk",
          scheduledAt: null,
          state: "DRAFTING",
          reviewable: false,
          detail: "Düzenleme talebi güvenli yerel kuyruğa alındı; Codex hesabı veya izole runner bekleniyor."
        });
        demoOperations.events.unshift({
          id: `edit-${Date.now()}`,
          at: new Intl.DateTimeFormat("tr-TR", {
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date()),
          title: "Düzenleme talebi kuyruğa alındı",
          detail: instruction,
          state: "WAITING",
          correlationId: `edit_${revisionId}`
        });
        return { ok: true, state: "RESEARCH_QUEUED", job: { id: jobId } };
      }
      case "update_schedule_slot": {
        const slotId = String(args?.slotId ?? "");
        const time = String(args?.time ?? "");
        const slot = editorialWorkspace.weeklySlots.find((item) => item.id === slotId);
        if (!slot || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) {
          throw new BridgeError("COMMAND_FAILED", "Takvim slotu veya saat geçersiz.");
        }
        const articleId = args?.articleId === null || args?.articleId === undefined
          ? null
          : String(args.articleId);
        const article = articleId
          ? editorialWorkspace.drafts.find((item) => item.id === articleId && item.state === "APPROVED")
          : null;
        if (articleId && !article) {
          throw new BridgeError("COMMAND_FAILED", "Yalnızca mevcut onaylı bir post seçilebilir.");
        }
        slot.enabled = Boolean(args?.enabled);
        slot.time = time;
        slot.articleId = article?.id ?? null;
        slot.articleTitle = article?.titleTr ?? null;
        slot.state = article ? "READY" : "EMPTY";
        return { ok: true };
      }
      case "save_desktop_preferences": {
        const preferences = args?.preferences as DesktopPreferences | undefined;
        if (!preferences?.author.trim() || !preferences.reviewer.trim()) {
          throw new BridgeError("COMMAND_FAILED", "Yazar ve inceleyen alanları zorunludur.");
        }
        editorialWorkspace.preferences = structuredClone(preferences);
        return { ok: true };
      }
      case "complete_onboarding":
        demoBootstrap.onboardingComplete = true;
        return { completed: true };
      case "set_runtime_pause": {
        const target = String(args?.target ?? "");
        const paused = Boolean(args?.paused);
        if (target === "ingestion") {
          demoBootstrap.automation.ingestionPaused = paused;
        } else if (target === "publishing") {
          demoBootstrap.automation.publishingPaused = paused;
        }
        return { paused };
      }
      default:
        throw new BridgeError(
          "COMMAND_FAILED",
          `Demo köprüsü bilinmeyen komutu reddetti: ${command}`
        );
    }
  };
}
