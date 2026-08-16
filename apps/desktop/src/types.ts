import type { ArticleType as ContractArticleType, SiteSection } from "../../../packages/contracts/src/index.ts";

export type Section = SiteSection;
export type ArticleType = ContractArticleType;
export type SourceKind = "RSS" | "ATOM" | "SITEMAP" | "SITE" | "ARTICLE";
export type SourceHealth = "HEALTHY" | "WARNING" | "TESTING" | "DISABLED";
export type RuntimeState = "ONLINE" | "DEGRADED" | "OFFLINE_READ_ONLY";
export type DraftState =
  | "DISCOVERED"
  | "RESEARCHING"
  | "NEEDS_SOURCE"
  | "DRAFTING"
  | "ROUTING_REQUIRED"
  | "REVIEW_REQUIRED"
  | "APPROVED"
  | "SCHEDULED"
  | "PUBLISHING"
  | "PUBLISHED";

export interface SourceRecord {
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
  health: SourceHealth;
  section: Section;
  articleType: ArticleType;
  lastCheckedAt: string | null;
  lastItemAt: string | null;
  discoveredFeeds: string[];
  enabled: boolean;
  version: number;
  language: "tr" | "en" | "other" | "unknown";
  trustStatus: "PENDING" | "APPROVED" | "REJECTED";
  rightsStatus: "PENDING" | "APPROVED" | "REJECTED";
  trustReview?: { reviewedAt: string; rationale: string };
  rightsReview?: { reviewedAt: string; rationale: string };
  canPublish: boolean;
  blockers: string[];
}

export interface SourceTestResult {
  url: string;
  kind: SourceKind;
  title: string;
  reachable: boolean;
  statusCode: number;
  discoveredFeeds: string[];
  recommendation: string;
}

export interface SourceScanResult {
  accepted: boolean;
  operationId: string;
  detail: string;
}

export interface SourceScanStatus {
  operationId: string;
  complete: boolean;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  rejected: number;
  detail: string;
}

export interface SourceInput {
  url: string;
  section: Section;
  articleType: ArticleType;
  kind?: SourceKind;
  language?: "tr" | "en" | "other" | "unknown";
  title?: string;
  version?: number;
}

export interface InstantCreateCommand {
  instruction: string;
  sourceIds: string[];
  urls: string[];
  targetSection: Section;
  articleType: ArticleType;
  urgency: "normal" | "urgent";
  tone: "neutral" | "technical" | "accessible";
  length: "standard" | "deep";
  visualPolicy: "GENERATE" | "LOCAL_RENDERER" | "NONE";
  scheduleIntent: "NEXT_SLOT" | "UNSCHEDULED";
  requestedPublishMode: "REVIEW";
}

export interface InstantDraftSubmission {
  id: string;
  state: "RESEARCHING" | "WAITING_CODEX";
  queueState: "QUEUED" | "RUNNING" | "WAITING_CODEX";
}

export interface QueueItem {
  id: string;
  title: string;
  section: Section;
  state: DraftState;
  sourceCount: number;
  updatedAt: string;
  dueLabel: string;
  blockers: number;
}

export interface PipelineStage {
  label: string;
  count: number;
  tone: "neutral" | "blue" | "amber" | "green";
}

export interface BootstrapSnapshot {
  onboardingComplete: boolean;
  runtime: RuntimeState;
  capabilities: string[];
  connection: {
    engineRunning: boolean;
    engineLabel: string;
    bridgeReady: boolean;
    latencyMs: number | null;
    storageLabel: string;
    lastSyncAt: string;
  };
  automation: {
    mode: "OFF" | "INGEST_ONLY" | "DRAFT_ONLY" | "PUBLISH_APPROVED";
    ingestionPaused: boolean;
    publishingPaused: boolean;
    scanIntervalMinutes: number;
    timezone: "Europe/Istanbul";
    nextScanAt: string;
  };
  codex: {
    state: "READY" | "BUSY" | "UNAVAILABLE";
    accountLabel: string;
    queueDepth: number;
    lastRunAt: string;
  };
  pipeline: PipelineStage[];
  queue: QueueItem[];
  sourceCount: number;
  scheduledCount: number;
}

export interface ClaimView {
  id: string;
  text: string;
  locale: "tr" | "en" | "both";
  status: "VERIFIED" | "NEEDS_SOURCE" | "DISPUTED";
  sourceIds: string[];
}

export interface SourceSnapshotView {
  id: string;
  title: string;
  url: string;
  fetchedAt: string;
  contentHash: string;
  primary: boolean;
}

export interface GateView {
  id: string;
  label: string;
  detail: string;
  state: "PASS" | "WARN" | "BLOCK" | "NOT_RUN";
  group: "editorial" | "seo" | "security" | "media";
  policyVersion: string;
  reasonCode?: string;
}

export interface MediaView {
  id: string;
  role: "hero" | "inline";
  filename: string;
  width: number;
  height: number;
  sha256: string;
  /** Immutable, engine-verified asset length. New revisions never inline raster bytes. */
  byteSize?: number;
  /** Present only while opening a legacy revision created before asset references. */
  contentBase64?: string;
  altTr: string;
  altEn: string;
}

export interface LocaleContent {
  title: string;
  description: string;
  slug: string;
  bodyMarkdown: string;
}

export interface ReviewRevision {
  id: string;
  revisionHash: string;
  articleId: string;
  state: "REVIEW_REQUIRED" | "APPROVED";
  riskLevel?: "STANDARD" | "HIGH";
  editorialApproved?: boolean;
  highRiskApproved?: boolean;
  section: Section;
  articleType: ArticleType;
  author: string;
  tags: string[];
  scheduledAt: string;
  adapterVersion: string;
  tr: LocaleContent;
  en: LocaleContent;
  previous: {
    tr: LocaleContent;
    en: LocaleContent;
  };
  claims: ClaimView[];
  sources: SourceSnapshotView[];
  gates: GateView[];
  media: MediaView[];
}

export interface OperationEvent {
  id: string;
  at: string;
  title: string;
  detail: string;
  state: "SUCCESS" | "RUNNING" | "WAITING" | "BLOCKED";
  level?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  correlationId: string;
}

export interface ScheduleItem {
  id: string;
  title: string;
  at: string;
  section: Section;
  state: "APPROVED" | "SCHEDULED" | "BLOCKED";
}

export interface OperationsSnapshot {
  events: OperationEvent[];
  schedule: ScheduleItem[];
  worker: {
    state: "HEALTHY" | "DEGRADED";
    queueDepth: number;
    oldestJobMinutes: number;
  };
  publisher: {
    state: "READY" | "PAUSED" | "BLOCKED";
    outboxPending: number;
    lastReconciledAt: string | null;
  };
}

export interface OnboardingSettings {
  deviceName: string;
  mode: "INGEST_ONLY" | "DRAFT_ONLY" | "PUBLISH_APPROVED";
  scanIntervalMinutes: number;
  acknowledgeApprovalBoundary: boolean;
  autostartEnabled: boolean;
}

export type PrerequisiteState = "READY" | "MISSING" | "BLOCKED" | "ATTENTION";
export type PrerequisiteScope = "APP" | "WRITE" | "PUBLISH";

export interface PrerequisiteCheck {
  id:
    | "windows"
    | "webview2"
    | "secure-store"
    | "local-engine"
    | "local-database"
    | "local-queue"
    | "codex"
    | "backup"
    | "github"
    | "deploy"
    | "clock"
    | "site-adapter";
  label: string;
  state: PrerequisiteState;
  scope: PrerequisiteScope;
  detail: string;
  userAction: string | null;
}

export type SetupRequirementKind =
  | "LOCAL_INSTALL"
  | "EXTERNAL_AUTHORIZATION"
  | "EXTERNAL_CONFIGURATION";

export interface SetupRequirement {
  id: string;
  label: string;
  kind: SetupRequirementKind;
  scope: PrerequisiteScope;
  state: PrerequisiteState;
  detail: string;
  /** Setup must never render or transport a secret/token/private key field. */
  secretField: false;
  userAction: string | null;
}

export type SetupConnectorId = "codex" | "github" | "site" | "deploy" | "backup";
export type SiteWorkMode = "LOCAL_ONLY" | "LOCAL_DEV" | "PUBLISH";
export interface SetupConnectorDraft {
  codex: { accountLabel: string };
  github: { owner: string; repository: string; clientId?: string };
  site: { repositoryPath: string; publicSiteUrl: string; mode: SiteWorkMode };
  deploy: { workflowName: string; requiredChecks: string[] };
  backup: { folder: string };
}
export interface SetupConnectorTestResult {
  connector: SetupConnectorId;
  ready: boolean;
  /** Form/configuration readiness; external authorization is reported separately. */
  state?: "ATTENTION" | "DRY_RUN_READY" | "SAVED";
  /** No auth probe is performed by the local-only setup check. */
  authorizationState?: "NOT_CHECKED";
  /** Read-only hint discovered from the selected site's local git config. */
  repositorySuggestion?: string | null;
  contentModel?: "ASTRO_CONTENT_COLLECTION" | "TYPESCRIPT_EDITORIAL_DATA" | "UNKNOWN" | "N/A";
  detail: string;
}

export type ConnectorReadiness =
  | "NOT_CONFIGURED"
  | "LOCAL_VALIDATED"
  | "LIVE_ACCEPTED";

export interface ConnectorStateSnapshot {
  sourceState: "AVAILABLE" | "ABSENT";
  mode: SiteWorkMode;
  configured: boolean;
  config: SetupConnectorDraft;
  site: {
    repositoryPath: string;
    publicSiteUrl: string;
    adapterId: string | null;
    adapterVersion: string | null;
  };
  checks: Partial<Record<SetupConnectorId, SetupConnectorTestResult>>;
  localReadiness: ConnectorReadiness;
  externalReadiness: ConnectorReadiness;
}

const SETUP_REQUIREMENT_CATALOG: ReadonlyArray<Omit<SetupRequirement, "state" | "userAction">> = [
  {
    id: "local-install",
    label: "Bilgisayarınızdaki uygulama",
    kind: "LOCAL_INSTALL",
    scope: "APP",
    detail: "OPE'nin kendi bileşenleri kurulumla birlikte otomatik kontrol edilir.",
    secretField: false
  },
  {
    id: "codex",
    label: "Yazı üretimi hesabı",
    kind: "EXTERNAL_AUTHORIZATION",
    scope: "WRITE",
    detail: "İsterseniz mevcut yazı üretimi hesabınızı bağlarsınız; parola veya token bu uygulamaya yazılmaz.",
    secretField: false
  },
  {
    id: "github",
    label: "Sitenin GitHub bağlantısı",
    kind: "EXTERNAL_AUTHORIZATION",
    scope: "PUBLISH",
    detail: "Onaylanan yazıların site projesine gönderileceği hesap ayrı bir giriş penceresinde bağlanır.",
    secretField: false
  },
  {
    id: "site",
    label: "Site klasörü ve adresi",
    kind: "EXTERNAL_AUTHORIZATION",
    scope: "PUBLISH",
    detail: "Bilgisayarınızdaki site klasörü ve ziyaretçilerin gördüğü adres seçilir; OPE desteklenen formatı otomatik kontrol eder.",
    secretField: false
  },
  {
    id: "backup",
    label: "İsteğe bağlı şifreli yedek",
    kind: "EXTERNAL_CONFIGURATION",
    scope: "APP",
    detail: "Yedek klasörü ve recovery key yerel doğrulama akışında seçilir; anahtar kalıcı olarak saklanmaz.",
    secretField: false
  }
];

export function buildSetupRequirements(
  checks: ReadonlyArray<Pick<PrerequisiteCheck, "id" | "state" | "detail" | "userAction">>
): SetupRequirement[] {
  const byId = new Map(checks.map((check) => [check.id, check]));
  return SETUP_REQUIREMENT_CATALOG.map((item) => {
    const checkId = item.id === "local-install"
      ? "local-engine"
      : item.id === "site"
        ? "site-adapter"
        : item.id as PrerequisiteCheck["id"];
    const check = byId.get(checkId);
    return {
      ...item,
      state: check?.state ?? "MISSING",
      detail: check?.detail || item.detail,
      userAction: check?.userAction ?? null
    };
  });
}

export interface PrerequisiteSnapshot {
  checkedAtUnixMs: number;
  checks: PrerequisiteCheck[];
}

export interface LocalEngineTestResult {
  ready: boolean;
  component: "local-engine";
  detail: string;
}

export interface TodayWorkItem {
  id: string;
  title: string;
  detail: string;
  dueLabel: string;
  priority: "HIGH" | "NORMAL";
  state: "OPEN" | "DONE";
  target: "candidates" | "editorial" | "publishing" | "operations";
}

export interface CandidateView {
  id: string;
  sourceId?: string | null;
  title: string;
  summary: string;
  primarySource: string;
  sourceCount: number;
  section: Section;
  articleType: ArticleType;
  confidence: number;
  duplicateScore: number;
  discoveredAt: string;
  state: "NEW" | "NEEDS_SOURCE" | "ROUTING_REQUIRED" | "DISMISSED" | "PROMOTED" | "RESEARCH_QUEUED" | "RESEARCH_FAILED";
}

export interface DraftView {
  id: string;
  titleTr: string;
  titleEn: string;
  section: Section;
  /** A percentage is shown only when the engine has measured it. */
  completion: number | null;
  blockers: number;
  updatedAt: string;
  scheduledAt: string | null;
  state: "DRAFTING" | "NEEDS_SOURCE" | "REVIEW_REQUIRED" | "APPROVED";
  reviewable: boolean;
  detail: string;
  /** Execution is distinct from editorial lifecycle: every visible job has one honest state. */
  executionState?: "QUEUED" | "RUNNING" | "WAITING" | "RETRY_SCHEDULED" | "FAILED" | "COMPLETED";
  /** The single safe next step, when human intervention is actually needed. */
  nextAction?: "NONE" | "CONNECT_CODEX" | "RETRY" | "OPEN_REVIEW";
  reasonCode?: string | null;
}

export interface WeeklySlotView {
  id: string;
  dayLabel: string;
  time: string;
  enabled: boolean;
  articleId: string | null;
  articleTitle: string | null;
  state: "EMPTY" | "DRAFTING" | "REVIEW_REQUIRED" | "READY";
}

export interface ScheduledPublicationView {
  id: string;
  title: string;
  section: Section;
  scheduledAt: string;
  revisionHash: string;
  targetPath: string;
  ciState: "NOT_STARTED" | "RUNNING" | "PASSED" | "FAILED";
  state: "READY" | "BLOCKED" | "PUBLISHING";
}

export interface PublicationHistoryView {
  id: string;
  title: string;
  section: Section;
  publishedAt: string;
  url: string | null;
  revisionHash: string;
  verificationState: "VERIFIED" | "UNVERIFIED" | "PASSED" | "WARNING" | "FAILED";
}

export interface FailureView {
  id: string;
  title: string;
  jobType: string;
  message: string;
  attempts: number;
  lastAttemptAt: string;
  retryMode: "SAFE" | "RECONCILE_FIRST" | "MANUAL";
  state: "ACTION_REQUIRED" | "RETRYING" | "RESOLVED";
}

export interface CodexRoleUsageView {
  role: "FAST" | "DEFAULT" | "DEEP_REVIEW";
  label: string;
  state: "READY" | "BUSY" | "LIMITED" | "UNAVAILABLE";
  queueDepth: number;
  completedToday: number | null;
  lastSuccessAt: string | null;
}

export interface DesktopPreferences {
  author: string;
  reviewer: string;
  notifications: boolean;
  emailDigest: boolean;
  defaultSection: Section;
  /** Show the exact local evidence links beside a review by default. */
  showSourceReferences: boolean;
}

export interface SystemHealthView {
  id: "engine" | "pglite" | "codex" | "github" | "site-adapter";
  label: string;
  state: "HEALTHY" | "DEGRADED" | "OFFLINE" | "NOT_CONFIGURED";
  detail: string;
  checkedAt: string;
}

export interface EditorialWorkspaceSnapshot {
  sync: {
    sequence: number;
    snapshotId: string;
    generatedAt: string;
    stale: boolean;
  };
  today: TodayWorkItem[];
  candidates: CandidateView[];
  drafts: DraftView[];
  weeklySlots: WeeklySlotView[];
  scheduled: ScheduledPublicationView[];
  history: PublicationHistoryView[];
  failures: FailureView[];
  codexRoles: CodexRoleUsageView[];
  preferences: DesktopPreferences;
  systemHealth: SystemHealthView[];
}
