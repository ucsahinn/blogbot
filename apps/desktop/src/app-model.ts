import type {
  ArticleType,
  CandidateView,
  DraftView,
  FailureView,
  InstantCreateCommand,
  InstantDraftSubmission,
  PrerequisiteCheck,
  ScheduledPublicationView,
  ConnectorStateSnapshot,
  SetupConnectorDraft,
  TodayWorkItem,
  Section,
  SetupConnectorId,
  WeeklySlotView
} from "./types.ts";

/**
 * Setup is local-first: publishing and backup are optional until the editor
 * explicitly chooses a publishing target. Do not turn those blocked optional
 * checks into the next action for ordinary drafting work.
 */
export function nextSetupPrerequisite(
  checks: readonly PrerequisiteCheck[],
  siteMode: "LOCAL_ONLY" | "LOCAL_DEV" | "PUBLISH"
): PrerequisiteCheck | undefined {
  const requiredIds = siteMode === "PUBLISH"
    ? ["local-engine", "local-database", "local-queue", "codex", "github", "site-adapter", "deploy"] as const
    : ["local-engine", "local-database", "local-queue", "codex"] as const;

  for (const id of requiredIds) {
    const check = checks.find((candidate) => candidate.id === id);
    if (!check) {
      const scope = ["github", "site-adapter", "deploy"].includes(id)
        ? "PUBLISH"
        : "WRITE";
      return {
        id,
        state: "MISSING",
        scope,
        label: id,
        detail: "Zorunlu kurulum denetimi raporlanmadı; hazır sayılmadı.",
        userAction: "Kurulum durumunu yenileyin ve eksik bileşeni yeniden doğrulayın."
      };
    }
    if (check.state !== "READY") return check;
  }
  return undefined;
}

export function describeInstantDraftSubmission(submission: InstantDraftSubmission): {
  waitingForCodex: boolean;
  kicker: string;
  title: string;
  detail: string;
} {
  if (submission.state === "WAITING_CODEX" || submission.queueState === "WAITING_CODEX") {
    return {
      waitingForCodex: true,
      kicker: "YAZI ÜRETİMİ BEKLİYOR",
      title: "İş kaydedildi; Codex bağlantısı bekleniyor.",
      detail: "Kaynak seçiminiz kaybolmadı. Yazı üretimi hesabını Kurulum Merkezi'nden doğruladıktan sonra bu işi yeniden deneyin."
    };
  }
  return {
    waitingForCodex: false,
    kicker: "ARAŞTIRMA KUYRUKTA",
    title: "İş güvenli kuyruğa alındı.",
    detail: "OPE araştırmayı yerel ve dayanıklı kuyruğunda sürdürecek."
  };
}

/** Connector ids are internal; setup copy must remain site-neutral. */
export function setupConnectorLabel(connector: SetupConnectorId): string {
  switch (connector) {
    case "codex":
      return "Yazı üretimi";
    case "github":
      return "GitHub";
    case "site":
      return "Site";
    case "deploy":
      return "Yayın iş akışı";
    case "backup":
      return "Yedekleme";
  }
}

export function generateRecoveryKey(
  fillRandomBytes: (bytes: Uint8Array) => void = (bytes) => crypto.getRandomValues(bytes)
): string {
  const bytes = new Uint8Array(24);
  fillRandomBytes(bytes);
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

export function isRecoveryKeyUsable(value: string): boolean {
  return value.trim().length >= 16;
}

export interface SourceParseResult {
  accepted: string[];
  rejected: string[];
}

export function hasRuntimeCapability(
  capabilities: readonly string[],
  capability: string
): boolean {
  return capabilities.includes(capability);
}

export function canMutateLocally(input: {
  engineRunning: boolean;
  bridgeReady: boolean;
}): boolean {
  return input.engineRunning && input.bridgeReady;
}

export function codexRuntimeLabel(state: string): string {
  if (state === "READY") return "Hazır";
  if (state === "BUSY") return "İşleniyor";
  if (state === "UNAVAILABLE") return "Kullanılamıyor";
  return "Bağlantı bekliyor";
}

const sectionLabels: Record<Section, string> = {
  haberler: "Haberler",
  analiz: "Analiz",
  dosyalar: "Dosyalar",
  rehberler: "Rehberler",
  teknoloji: "Teknoloji",
  ekonomi: "Ekonomi ve iş",
  kultur: "Kültür",
  yasam: "Yaşam"
};

const articleTypeLabels: Record<ArticleType, string> = {
  news: "Haber",
  analysis: "Analiz",
  deep_dive: "Derin dosya",
  guide: "Rehber"
};

const sectionArticleTypes: Record<Section, ArticleType> = {
  haberler: "news",
  analiz: "analysis",
  dosyalar: "deep_dive",
  rehberler: "guide",
  teknoloji: "news",
  ekonomi: "news",
  kultur: "analysis",
  yasam: "guide"
};

const candidateStateLabels: Record<CandidateView["state"], string> = {
  NEW: "Yeni",
  NEEDS_SOURCE: "Kaynak gerekiyor",
  ROUTING_REQUIRED: "Rota seçimi bekliyor",
  DISMISSED: "Kapatıldı",
  PROMOTED: "Taslağa alındı",
  RESEARCH_QUEUED: "Araştırma kuyruğunda",
  RESEARCH_FAILED: "Araştırma başarısız"
};

const draftStateLabels: Record<DraftView["state"], string> = {
  DRAFTING: "Hazırlanıyor",
  NEEDS_SOURCE: "Kaynak gerekiyor",
  REVIEW_REQUIRED: "İnceleme bekliyor",
  APPROVED: "Onaylandı"
};

const slotStateLabels: Record<WeeklySlotView["state"], string> = {
  EMPTY: "Boş",
  DRAFTING: "Taslak hazırlanıyor",
  REVIEW_REQUIRED: "İnceleme bekliyor",
  READY: "Hazır"
};

const failureStateLabels: Record<FailureView["state"], string> = {
  ACTION_REQUIRED: "Müdahale gerekli",
  RETRYING: "Yeniden deneniyor",
  RESOLVED: "Çözüldü"
};

const retryModeLabels: Record<FailureView["retryMode"], string> = {
  SAFE: "Güvenli tekrar",
  RECONCILE_FIRST: "Önce uzlaştır",
  MANUAL: "Elle inceleme"
};

export const sectionLabel = (value: Section): string => sectionLabels[value];
export const sectionArticleType = (value: Section): ArticleType => sectionArticleTypes[value];
export const articleTypeLabel = (value: ArticleType): string => articleTypeLabels[value];
export const contentCategoryLabel = (section: Section, articleType: ArticleType): string => {
  const sectionText = sectionLabel(section);
  const articleTypeText = articleTypeLabel(articleType);
  return sectionText === articleTypeText ? sectionText : `${sectionText} · ${articleTypeText}`;
};
export const candidateStateLabel = (value: CandidateView["state"]): string => candidateStateLabels[value];
export const draftStateLabel = (value: DraftView["state"]): string => draftStateLabels[value];
export const slotStateLabel = (value: WeeklySlotView["state"]): string => slotStateLabels[value];
export const failureStateLabel = (value: FailureView["state"]): string => failureStateLabels[value];
export const retryModeLabel = (value: FailureView["retryMode"]): string => retryModeLabels[value];

export function jobTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    SOURCE_SCAN: "Kaynak taraması",
    DRAFT: "Taslak üretimi",
    CODEX: "Yazı üretimi",
    PUBLISH: "Yayın işlemi",
    INGEST: "Kaynak alımı"
  };
  return labels[value] ?? "Yerel iş";
}

export function connectorDraftFromState(
  state: ConnectorStateSnapshot
): SetupConnectorDraft {
  return {
    codex: { ...state.config.codex },
    github: { ...state.config.github },
    site: { ...state.config.site },
    deploy: { ...state.config.deploy },
    backup: { ...state.config.backup }
  };
}

const forbiddenHostnames = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "host.docker.internal",
  "gateway.docker.internal"
]);

function isObviouslyPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function normalizeSourceUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    forbiddenHostnames.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    isObviouslyPrivateIpv4(hostname) ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:")
  ) {
    return null;
  }

  parsed.hash = "";
  return parsed.toString();
}

function parseCandidates(values: string[]): SourceParseResult {
  const accepted = new Set<string>();
  const rejected = new Set<string>();

  for (const rawValue of values) {
    const value = rawValue.trim();
    if (value.length === 0) {
      continue;
    }
    const normalized = normalizeSourceUrl(value);
    if (normalized === null) {
      rejected.add(value);
    } else {
      accepted.add(normalized);
    }
  }

  return {
    accepted: [...accepted],
    rejected: [...rejected]
  };
}

export function parseUrlSources(input: string): SourceParseResult {
  return parseCandidates(input.split(/[\s,;]+/u));
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

export function parseOpmlSources(input: string): SourceParseResult {
  const candidates: string[] = [];
  const outlinePattern = /<outline\b[^>]*>/giu;
  for (const match of input.matchAll(outlinePattern)) {
    const outline = match[0];
    const url =
      /\bxmlUrl\s*=\s*["']([^"']+)["']/iu.exec(outline)?.[1] ??
      /\bhtmlUrl\s*=\s*["']([^"']+)["']/iu.exec(outline)?.[1];
    if (url) {
      candidates.push(decodeXmlAttribute(url));
    }
  }
  return parseCandidates(candidates);
}

export interface InstantCreateFormValue {
  instruction: string;
  sourceIds: string[];
  urls: string[];
  section: Section | "";
  articleType: ArticleType;
  urgency: "normal" | "urgent";
  tone: InstantCreateCommand["tone"];
  length: InstantCreateCommand["length"];
  visualPolicy: InstantCreateCommand["visualPolicy"];
  scheduleIntent: InstantCreateCommand["scheduleIntent"];
}

type InstantCreateError =
  | "INSTRUCTION_TOO_SHORT"
  | "SOURCE_EVIDENCE_REQUIRED"
  | "TARGET_SECTION_REQUIRED";

export type InstantCreateResult =
  | { valid: true; request: InstantCreateCommand }
  | {
      valid: false;
      errors: InstantCreateError[];
    };

export function buildInstantCreateRequest(
  form: InstantCreateFormValue
): InstantCreateResult {
  const errors: InstantCreateError[] = [];
  const instruction = form.instruction.trim();
  if (instruction.length < 10) {
    errors.push("INSTRUCTION_TOO_SHORT");
  }
  if (form.sourceIds.length === 0 && form.urls.length === 0) {
    errors.push("SOURCE_EVIDENCE_REQUIRED");
  }
  if (form.section.length === 0) {
    errors.push("TARGET_SECTION_REQUIRED");
  }
  if (errors.length > 0 || form.section === "") {
    return { valid: false, errors };
  }

  return {
    valid: true,
    request: {
      instruction,
      sourceIds: [...new Set(form.sourceIds)],
      urls: [...new Set(form.urls)],
      targetSection: form.section,
      articleType: form.articleType,
      urgency: form.urgency,
      tone: form.tone,
      length: form.length,
      visualPolicy: form.visualPolicy,
      scheduleIntent: form.scheduleIntent,
      requestedPublishMode: "REVIEW"
    }
  };
}

export function summarizePrerequisites(
  checks: ReadonlyArray<
    Pick<PrerequisiteCheck, "id" | "state" | "scope">
  >
): {
  appUsable: boolean;
  writeReady: boolean;
  publishReady: boolean;
  ready: number;
  total: number;
} {
  // An empty list means the Doctor request has not completed (or failed), not
  // that every scope is ready. Array.every([]) is true by definition, which
  // would otherwise briefly unlock setup actions during the initial render.
  if (checks.length === 0) {
    return {
      appUsable: false,
      writeReady: false,
      publishReady: false,
      ready: 0,
      total: 0
    };
  }
  const isReady = (scope: PrerequisiteCheck["scope"]) =>
    (() => {
      const scopedChecks = checks.filter(
        (check) => check.scope === scope && check.id !== "backup"
      );
      return scopedChecks.length > 0 && scopedChecks.every((check) => check.state === "READY");
    })();
  const appUsable = isReady("APP");
  const writeReady = appUsable && isReady("WRITE");
  return {
    appUsable,
    writeReady,
    publishReady: writeReady && isReady("PUBLISH"),
    ready: checks.filter((check) => check.state === "READY").length,
    total: checks.length
  };
}

export function canEnableAutomationMode(
  mode: "INGEST_ONLY" | "DRAFT_ONLY" | "PUBLISH_APPROVED",
  summary: Pick<ReturnType<typeof summarizePrerequisites>, "appUsable" | "writeReady" | "publishReady">
): boolean {
  if (!summary.appUsable) return false;
  if (mode === "INGEST_ONLY") return true;
  if (mode === "DRAFT_ONLY") return summary.writeReady;
  return summary.publishReady;
}

export function summarizeWorkspace(
  workspace: {
    today: ReadonlyArray<Pick<TodayWorkItem, "state" | "priority">>;
    candidates: ReadonlyArray<Pick<CandidateView, "state">>;
    drafts: ReadonlyArray<Pick<DraftView, "state">>;
    scheduled: ReadonlyArray<Pick<ScheduledPublicationView, "state">>;
    failures: ReadonlyArray<Pick<FailureView, "state">>;
  }
): {
  openToday: number;
  activeCandidates: number;
  reviewRequired: number;
  scheduledReady: number;
  actionRequired: number;
} {
  return {
    openToday: workspace.today.filter((item) => item.state === "OPEN").length,
    activeCandidates: workspace.candidates.filter(
      (candidate) =>
        candidate.state !== "DISMISSED" && candidate.state !== "PROMOTED"
    ).length,
    reviewRequired: workspace.drafts.filter(
      (draft) => draft.state === "REVIEW_REQUIRED"
    ).length,
    scheduledReady: workspace.scheduled.filter(
      (publication) => publication.state === "READY"
    ).length,
    actionRequired: workspace.failures.filter(
      (failure) => failure.state === "ACTION_REQUIRED"
    ).length
  };
}
