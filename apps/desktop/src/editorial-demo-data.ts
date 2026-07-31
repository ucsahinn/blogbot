import type { EditorialWorkspaceSnapshot } from "./types.ts";

export function createEditorialWorkspaceDemo(): EditorialWorkspaceSnapshot {
  return {
    sync: {
      sequence: 1842,
      snapshotId: "demo-workspace-20260729-1400",
      generatedAt: "2026-07-29T14:00:00.000Z",
      stale: false
    },
    today: [
      {
        id: "today-review-identity",
        title: "Örnek analiz paketini incele",
        detail: "TR/EN metin, kaynak kanıtları ve görsel oranları hazır.",
        dueLabel: "Bugün 16:30",
        priority: "HIGH",
        state: "OPEN",
        target: "editorial"
      },
      {
        id: "today-route-supply-chain",
        title: "Yeni adayın bölümünü belirle",
        detail: "İki bölüm arasında düşük güvenli yönlendirme.",
        dueLabel: "Bugün",
        priority: "NORMAL",
        state: "OPEN",
        target: "candidates"
      },
      {
        id: "today-publish-cloud",
        title: "Örnek rehberi yayın öncesi kontrol",
        detail: "Onaylı paket yarın 10:00 slotunda.",
        dueLabel: "Yarın 10:00",
        priority: "NORMAL",
        state: "OPEN",
        target: "publishing"
      }
    ],
    candidates: [
      {
        id: "candidate-cisa-001",
        title: "Resmî kurum yeni bir duyuru yayımladı",
        summary:
          "Birincil duyuru ve iki bağımsız kaynak aynı olayı doğruluyor.",
        primarySource: "Resmî kaynak duyurusu",
        sourceCount: 3,
        section: "haberler",
        articleType: "news",
        confidence: 94,
        duplicateScore: 18,
        discoveredAt: "2026-07-29T13:42:00.000Z",
        state: "NEW"
      },
      {
        id: "candidate-supply-chain",
        title: "Bir alanda yeni doğrulama kuralları",
        summary:
          "Resmî değişiklik doğrulandı; etkilerin kapsamı için ikinci kaynak gerekiyor.",
        primarySource: "Birincil kaynak",
        sourceCount: 1,
        section: "analiz",
        articleType: "analysis",
        confidence: 68,
        duplicateScore: 31,
        discoveredAt: "2026-07-29T12:16:00.000Z",
        state: "NEEDS_SOURCE"
      },
      {
        id: "candidate-cloud-routing",
        title: "Bir hizmette yeni kısa ömürlü kimlik modeli",
        summary:
          "Konu haber, analiz veya uygulamalı rehber olarak ele alınabilir.",
        primarySource: "Bağımsız kaynak",
        sourceCount: 4,
        section: "rehberler",
        articleType: "guide",
        confidence: 57,
        duplicateScore: 12,
        discoveredAt: "2026-07-29T10:05:00.000Z",
        state: "ROUTING_REQUIRED"
      }
    ],
    drafts: [
      {
        id: "rev-identity",
        titleTr: "Yeni teknoloji geçişinde gözden kaçan üç risk",
        titleEn: "Three risks organizations overlook during a technology migration",
        section: "analiz",
        completion: 100,
        blockers: 0,
        updatedAt: "2026-07-29T12:36:00.000Z",
        scheduledAt: "2026-07-29T16:30:00.000Z",
        state: "REVIEW_REQUIRED"
      },
      {
        id: "draft-official-001",
        titleTr: "Yeni duyuru için kısa değerlendirme",
        titleEn: "A short assessment of a new public advisory",
        section: "haberler",
        completion: 72,
        blockers: 1,
        updatedAt: "2026-07-29T13:58:00.000Z",
        scheduledAt: null,
        state: "NEEDS_SOURCE"
      },
      {
        id: "draft-cloud-privilege",
        titleTr: "Bir hizmetin sınırlarını daraltmak için uygulamalı rehber",
        titleEn: "A practical guide to narrowing service boundaries",
        section: "rehberler",
        completion: 43,
        blockers: 0,
        updatedAt: "2026-07-29T11:20:00.000Z",
        scheduledAt: null,
        state: "DRAFTING"
      }
    ],
    weeklySlots: [
      {
        id: "slot-mon",
        dayLabel: "Pazartesi",
        time: "10:00",
        enabled: true,
        articleId: "draft-cloud-privilege",
        articleTitle: "Bir hizmetin sınırlarını daraltmak",
        state: "DRAFTING"
      },
      {
        id: "slot-tue",
        dayLabel: "Salı",
        time: "16:30",
        enabled: true,
        articleId: "rev-identity",
        articleTitle: "Yeni teknoloji geçişinde üç risk",
        state: "REVIEW_REQUIRED"
      },
      {
        id: "slot-wed",
        dayLabel: "Çarşamba",
        time: "10:00",
        enabled: true,
        articleId: null,
        articleTitle: null,
        state: "EMPTY"
      },
      {
        id: "slot-thu",
        dayLabel: "Perşembe",
        time: "16:30",
        enabled: true,
        articleId: "approved-incident",
        articleTitle: "Ekipler için uygulama kontrol listesi",
        state: "READY"
      },
      {
        id: "slot-fri",
        dayLabel: "Cuma",
        time: "10:00",
        enabled: true,
        articleId: null,
        articleTitle: null,
        state: "EMPTY"
      },
      {
        id: "slot-sat",
        dayLabel: "Cumartesi",
        time: "11:00",
        enabled: true,
        articleId: null,
        articleTitle: null,
        state: "EMPTY"
      },
      {
        id: "slot-sun",
        dayLabel: "Pazar",
        time: "11:00",
        enabled: true,
        articleId: null,
        articleTitle: null,
        state: "EMPTY"
      }
    ],
    scheduled: [
      {
        id: "scheduled-incident",
        title: "Ekipler için uygulama kontrol listesi",
        section: "rehberler",
        scheduledAt: "2026-07-30T07:00:00.000Z",
        revisionHash: "2c2e8a0a4fd8d21ef59f25d70d7485cf",
        targetPath: "/rehberler/ekipler-icin-uygulama-kontrol-listesi",
        ciState: "NOT_STARTED",
        state: "READY"
      },
      {
        id: "scheduled-identity",
        title: "Yeni teknoloji geçişinde gözden kaçan üç risk",
        section: "analiz",
        scheduledAt: "2026-07-30T13:30:00.000Z",
        revisionHash: "9f52c21326a63bd5e379863544485efd2",
        targetPath: "/analiz/yeni-teknoloji-gecisinde-uc-risk",
        ciState: "NOT_STARTED",
        state: "BLOCKED"
      }
    ],
    history: [
      {
        id: "history-event-response",
        title: "Bir olayın ilk 60 dakikası",
        section: "dosyalar",
        publishedAt: "2026-07-28T07:00:00.000Z",
        url: "https://site.example/dosyalar/bir-olayin-ilk-60-dakikasi",
        revisionHash: "71d2b8200aa78a41",
        verificationState: "PASSED"
      },
      {
        id: "history-sector-update",
        title: "Bir sektörü etkileyen yeni gelişme",
        section: "haberler",
        publishedAt: "2026-07-27T13:30:00.000Z",
        url: "https://site.example/haberler/bir-sektoru-etkileyen-yeni-gelisme",
        revisionHash: "410b83ad3c2fbb11",
        verificationState: "WARNING"
      }
    ],
    failures: [
      {
        id: "failure-source-timeout",
        title: "Bir kaynak taraması zaman aşımına uğradı",
        jobType: "FETCH_SOURCE",
        message: "Kaynak 20 saniyelik güvenli cevap sınırını aştı.",
        attempts: 2,
        lastAttemptAt: "2026-07-29T13:38:00.000Z",
        retryMode: "SAFE",
        state: "ACTION_REQUIRED"
      },
      {
        id: "failure-publish-unknown",
        title: "Yayın sonucu henüz doğrulanmadı",
        jobType: "RECONCILE_PUBLICATION",
        message:
          "Dış etkinin sonucu belirsiz. Yeni PR oluşturmadan önce uzlaştırma gerekir.",
        attempts: 1,
        lastAttemptAt: "2026-07-29T12:02:00.000Z",
        retryMode: "RECONCILE_FIRST",
        state: "ACTION_REQUIRED"
      }
    ],
    codexRoles: [
      {
        role: "FAST",
        label: "Hızlı sınıflandırma, metadata ve belirsiz tekrar analizi",
        state: "READY",
        queueDepth: 0,
        completedToday: 28,
        lastSuccessAt: "2026-07-29T13:58:00.000Z"
      },
      {
        role: "DEFAULT",
        label: "Araştırma, Türkçe taslak ve İngilizce yerelleştirme",
        state: "BUSY",
        queueDepth: 2,
        completedToday: 9,
        lastSuccessAt: "2026-07-29T13:52:00.000Z"
      },
      {
        role: "DEEP_REVIEW",
        label: "Yüksek risk, çelişki ve son kalite incelemesi",
        state: "LIMITED",
        queueDepth: 1,
        completedToday: 4,
        lastSuccessAt: "2026-07-29T12:31:00.000Z"
      }
    ],
    preferences: {
      author: "Blogbot Editorya",
      reviewer: "Ulaş Şahin",
      notifications: true,
      emailDigest: false,
      defaultSection: "haberler"
    },
    systemHealth: [
      {
        id: "engine",
        label: "Yerel Blogbot Engine",
        state: "HEALTHY",
        detail: "Paketlenmiş engine çalışıyor; stdio köprüsü yanıt veriyor.",
        checkedAt: "2026-07-29T14:00:00.000Z"
      },
      {
        id: "pglite",
        label: "PGlite ve yerel kuyruk",
        state: "HEALTHY",
        detail: "Veri dizini yazılabilir; en eski bekleyen iş 2 dakika.",
        checkedAt: "2026-07-29T14:00:00.000Z"
      },
      {
        id: "codex",
          label: "Yazı üretimi",
        state: "DEGRADED",
        detail: "Derin inceleme kotası nedeniyle bir iş bekliyor.",
        checkedAt: "2026-07-29T13:59:00.000Z"
      },
      {
        id: "github",
        label: "GitHub yayıncısı",
        state: "NOT_CONFIGURED",
        detail: "Canlı GitHub App bağlantısı sonraki aşamada kurulacak.",
        checkedAt: "2026-07-29T13:59:00.000Z"
      },
      {
        id: "site-adapter",
        label: "Site adaptörü",
        state: "HEALTHY",
        detail: "İçerik yolları ve şema sözleşmesi doğrulandı.",
        checkedAt: "2026-07-29T13:59:00.000Z"
      }
    ]
  };
}
