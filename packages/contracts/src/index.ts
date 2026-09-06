export type SiteSection =
  | "haberler"
  | "analiz"
  | "dosyalar"
  | "rehberler"
  | "teknoloji"
  | "ekonomi"
  | "kultur"
  | "yasam";
export type ArticleType = "news" | "analysis" | "deep_dive" | "guide";
export type SchemaType = "NewsArticle" | "Article" | "BlogPosting";

export interface SiteSectionContract {
  trPath: SiteSection;
  enPath: "news" | "analysis" | "deep-dives" | "guides" | "technology" | "business" | "culture" | "life";
  articleType: ArticleType;
  schemaType: SchemaType;
}

export const SITE_SECTIONS: Readonly<Record<SiteSection, SiteSectionContract>> = {
  haberler: {
    trPath: "haberler",
    enPath: "news",
    articleType: "news",
    schemaType: "NewsArticle"
  },
  analiz: {
    trPath: "analiz",
    enPath: "analysis",
    articleType: "analysis",
    schemaType: "Article"
  },
  dosyalar: {
    trPath: "dosyalar",
    enPath: "deep-dives",
    articleType: "deep_dive",
    schemaType: "Article"
  },
  rehberler: {
    trPath: "rehberler",
    enPath: "guides",
    articleType: "guide",
    schemaType: "BlogPosting"
  },
  teknoloji: {
    trPath: "teknoloji",
    enPath: "technology",
    articleType: "news",
    schemaType: "NewsArticle"
  },
  ekonomi: {
    trPath: "ekonomi",
    enPath: "business",
    articleType: "news",
    schemaType: "NewsArticle"
  },
  kultur: {
    trPath: "kultur",
    enPath: "culture",
    articleType: "analysis",
    schemaType: "Article"
  },
  yasam: {
    trPath: "yasam",
    enPath: "life",
    articleType: "guide",
    schemaType: "BlogPosting"
  }
};

export function isSiteSection(value: unknown): value is SiteSection {
  return typeof value === "string" && Object.hasOwn(SITE_SECTIONS, value);
}

export interface SourceBatchResult {
  urls: string[];
  invalid: string[];
}

function normalizeHttpUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeSourceBatchInput(input: string): SourceBatchResult {
  const candidates =
    input.match(/https?:\/\/[^\s<>"']+/gi)?.map((value) =>
      value.replace(/[),.;]+$/g, "")
    ) ?? [];
  const urls = new Set<string>();
  const invalid: string[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeHttpUrl(candidate);
    if (normalized === null) {
      invalid.push(candidate);
    } else {
      urls.add(normalized);
    }
  }

  return { urls: [...urls], invalid };
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

export function parseOpmlSourceUrls(opml: string): string[] {
  const urls = new Set<string>();
  for (const outline of opml.matchAll(/<outline\b[^>]*>/gi)) {
    for (const attributeName of ["xmlUrl", "htmlUrl"]) {
      const match = new RegExp(
        `\\b${attributeName}\\s*=\\s*["']([^"']+)["']`,
        "i"
      ).exec(outline[0]);
      if (!match?.[1]) {
        continue;
      }
      const normalized = normalizeHttpUrl(decodeXmlAttribute(match[1]));
      if (normalized) {
        urls.add(normalized);
      }
    }
  }
  return [...urls];
}

export interface SyncCursor {
  sequence: number;
  snapshotId: string;
  generatedAt: string;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  correlationId: string;
}

export interface DeviceRequestContext {
  deviceId: string;
  certificateFingerprint: string;
  idempotencyKey: string;
  requestedAt: string;
}

export type EngineAutomationModeV1 =
  | "OFF"
  | "INGEST_ONLY"
  | "DRAFT_ONLY"
  | "PUBLISH_APPROVED";

export interface EngineAutomationSettingsV1 {
  mode: EngineAutomationModeV1;
  onboardingComplete: boolean;
  ingestionPaused: boolean;
  publishingPaused: boolean;
  timezone: string;
  scanIntervalMinutes: number;
}

interface EngineCommandBaseV1<Kind extends string, Payload> {
  version: 1;
  requestId: string;
  idempotencyKey: string;
  expectedVersion: number;
  kind: Kind;
  payload: Payload;
}

export interface SourceSaveInputV1 {
  url: string;
  section: SiteSection;
  articleType: ArticleType;
  kind: "RSS" | "ATOM" | "SITEMAP" | "SITE" | "ARTICLE";
  language: "tr" | "en" | "other" | "unknown";
  title?: string;
}

export interface SourceScanTargetV1 {
  sourceId: string;
  expectedVersion: number;
}

export interface SourceReviewInputV1 {
  sourceId: string;
  trustStatus: "APPROVED" | "REJECTED";
  rightsStatus: "APPROVED" | "REJECTED";
  rationale: string;
}

export interface ApprovalGrantLegacyInputV1 {
  revisionId: string;
  revisionHash: string;
  deviceId: string;
  warningSetHash: string;
}

export interface ApprovalGrantV3InputV1 extends ApprovalGrantLegacyInputV1 {
  packageVersion: 3;
  attestation: EditorialApprovalAttestationV3;
}

export interface ApprovalRevokeInputV1 {
  revisionId: string;
  revisionHash: string;
  deviceId: string;
  reason: string;
}

export interface DraftCreateInputV1 {
  draftId: string;
  candidateId?: string;
  candidateTitle?: string;
  candidateUrl?: string | null;
  instruction?: string;
  sourceIds?: string[];
  urls?: string[];
  sources?: unknown[];
  section?: SiteSection;
  articleType?: ArticleType;
  urgency?: "normal" | "urgent";
  tone?: "neutral" | "technical";
  length?: "standard" | "deep";
  visualPolicy?: "GENERATE" | "LOCAL_RENDERER" | "NONE";
  scheduleIntent?: "NEXT_SLOT" | "UNSCHEDULED";
  scheduledAt?: string;
  revisionId?: string;
  baseRevision?: unknown;
  preferredAuthor?: string;
  preferredReviewer?: string;
}

export interface BobyGuideInputV1 {
  guidanceId: string;
  question: string;
  activePage: string;
  runtimeState: "ONLINE" | "DEGRADED" | "OFFLINE";
  sessionId?: string | null;
  safeWorkspaceSummary: {
    draftCount: number;
    reviewCount: number;
    sourceCount: number;
  };
}

export type EngineCommandV1 =
  | EngineCommandBaseV1<
      "AUTOMATION.SET",
      { settings: EngineAutomationSettingsV1 }
    >
  | EngineCommandBaseV1<"SOURCE.SAVE", { source: SourceSaveInputV1 }>
  | EngineCommandBaseV1<"SOURCE.REVIEW", SourceReviewInputV1>
  | EngineCommandBaseV1<
      "SOURCE.SCAN",
      { targets: SourceScanTargetV1[] }
    >
  | EngineCommandBaseV1<"REVISION.SAVE", { revision: RevisionPackageV2 | RevisionPackageV3 }>
  | EngineCommandBaseV1<"REVISION.LIST", { summaryOnly?: boolean }>
  | EngineCommandBaseV1<"REVISION.GET", { revisionId: string }>
  | EngineCommandBaseV1<"REVISION.REPAIR_MEDIA", { revisionId: string }>
  | EngineCommandBaseV1<
      "APPROVAL.GRANT",
      ApprovalGrantLegacyInputV1 | ApprovalGrantV3InputV1
    >
  | EngineCommandBaseV1<"APPROVAL.REVOKE", ApprovalRevokeInputV1>
  | EngineCommandBaseV1<"DRAFT.CREATE", DraftCreateInputV1>
  | EngineCommandBaseV1<"BOBY.GUIDE", BobyGuideInputV1>
  | EngineCommandBaseV1<"JOB.RETRY", { jobId: string }>
  | EngineCommandBaseV1<"LOCAL_STATE.SET", { key: string; value: unknown }>
  | EngineCommandBaseV1<
      "APPROVAL.GRANT_HIGH_RISK",
      {
        revisionId: string;
        revisionHash: string;
        deviceId: string;
        riskChecklistHash: string;
        warningSetHash: string;
        windowsReauthenticatedAt: string;
      }
    >;

export type EngineCommandErrorCodeV1 =
  | "INVALID_COMMAND"
  | "IDEMPOTENCY_KEY_REUSED"
  | "VERSION_CONFLICT"
  | "APPROVAL_HASH_MISMATCH"
  | "REVISION_NOT_REVIEWABLE"
  | "TRANSLATION_PARITY_NOT_READY"
  | "CLAIM_EVIDENCE_NOT_READY"
  | "QUALITY_GATES_NOT_READY"
  | "WARNING_NOT_ALLOWLISTED"
  | "WARNING_ACCEPTANCE_MISMATCH"
  | "EDITORIAL_APPROVAL_REQUIRED"
  | "REVISION_REVIEW_UPGRADE_REQUIRED"
  | "EDITORIAL_ATTESTATION_REQUIRED"
  | "EDITORIAL_ATTESTATION_INVALID"
  | "EDITORIAL_QUALITY_NOT_READY"
  | "APPROVAL_REVOKED"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_ALREADY_REVOKED"
  | "INVALID_APPROVAL_REVOCATION"
  | "ENGINE_OPERATION_FAILED";

export interface EngineCommandErrorV1 {
  code: EngineCommandErrorCodeV1;
  message: string;
  retryable: boolean;
}

export interface EngineCommandSuccessV1<Value> {
  ok: true;
  version: 1;
  requestId: string;
  idempotencyKey: string;
  kind: EngineCommandV1["kind"];
  sequence: number;
  value: Value;
}

export interface EngineCommandFailureV1 {
  ok: false;
  version: 1;
  error: EngineCommandErrorV1;
}

export type EngineCommandResultV1<Value> =
  | EngineCommandSuccessV1<Value>
  | EngineCommandFailureV1;

export type EngineCommandValidationV1 =
  | { valid: true; command: EngineCommandV1 }
  | { valid: false; error: EngineCommandErrorV1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isOptionalBoundedText(value: unknown, maximumLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maximumLength);
}

function isIdentifierList(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= 1_000 &&
    value.every((item) => isIdentifier(item, 128));
}

function isBoundedTextList(value: unknown, maximumItemLength: number): value is string[] {
  return Array.isArray(value) &&
    value.length <= 1_000 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= maximumItemLength);
}

function isSafeWorkspaceSummaryV1(value: unknown): value is BobyGuideInputV1["safeWorkspaceSummary"] {
  if (!isRecord(value) || !hasExactKeys(value, ["draftCount", "reviewCount", "sourceCount"])) return false;
  return [value.draftCount, value.reviewCount, value.sourceCount].every((count) =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 100_000
  );
}

function isDraftCreateInputV1(value: unknown): value is DraftCreateInputV1 {
  if (!isRecord(value) || !hasAllowedKeys(value, ["draftId"], [
    "candidateId", "candidateTitle", "candidateUrl", "instruction", "sourceIds", "urls", "sources",
    "section", "articleType", "urgency", "tone", "length", "visualPolicy", "scheduleIntent",
    "scheduledAt", "revisionId", "baseRevision", "preferredAuthor", "preferredReviewer"
  ])) return false;
  if (!isIdentifier(value.draftId, 128)) return false;
  if (value.candidateId !== undefined && !isIdentifier(value.candidateId, 128)) return false;
  if (!isOptionalBoundedText(value.candidateTitle, 400) || !isOptionalBoundedText(value.instruction, 20_000)) return false;
  if (value.candidateUrl !== null && !isOptionalBoundedText(value.candidateUrl, 8_192)) return false;
  if (value.sourceIds !== undefined && !isIdentifierList(value.sourceIds)) return false;
  if (value.urls !== undefined && !isBoundedTextList(value.urls, 8_192)) return false;
  if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.length > 1_000 || !isBoundedJson(value.sources, 1_000_000))) return false;
  const hasSource = (Array.isArray(value.sourceIds) && value.sourceIds.length > 0) ||
    (Array.isArray(value.urls) && value.urls.length > 0);
  if (!hasSource) return false;
  if (value.section !== undefined && !SITE_SECTIONS[value.section as SiteSection]) return false;
  if (value.articleType !== undefined && !["news", "analysis", "deep_dive", "guide"].includes(value.articleType as string)) return false;
  if (value.urgency !== undefined && value.urgency !== "normal" && value.urgency !== "urgent") return false;
  if (value.tone !== undefined && value.tone !== "neutral" && value.tone !== "technical") return false;
  if (value.length !== undefined && value.length !== "standard" && value.length !== "deep") return false;
  if (value.visualPolicy !== undefined && !["GENERATE", "LOCAL_RENDERER", "NONE"].includes(value.visualPolicy as string)) return false;
  if (value.scheduleIntent !== undefined && value.scheduleIntent !== "NEXT_SLOT" && value.scheduleIntent !== "UNSCHEDULED") return false;
  if (value.scheduledAt !== undefined && !isExactIsoDate(value.scheduledAt)) return false;
  if (value.revisionId !== undefined && !isIdentifier(value.revisionId, 128)) return false;
  if (value.baseRevision !== undefined && !isBoundedJson(value.baseRevision, 1_000_000)) return false;
  if (!isOptionalBoundedText(value.preferredAuthor, 256) || !isOptionalBoundedText(value.preferredReviewer, 256)) return false;
  return isBoundedJson(value, 1_000_000);
}

function isBobyGuideInputV1(value: unknown): value is BobyGuideInputV1 {
  if (!isRecord(value) || !hasAllowedKeys(value,
    ["guidanceId", "question", "activePage", "runtimeState", "safeWorkspaceSummary"],
    ["sessionId"]
  )) return false;
  return isIdentifier(value.guidanceId, 128) &&
    isBoundedHumanText(value.question, 600) &&
    isBoundedHumanText(value.activePage, 64) &&
    (value.runtimeState === "ONLINE" || value.runtimeState === "DEGRADED" || value.runtimeState === "OFFLINE") &&
    (value.sessionId === undefined || value.sessionId === null || isIdentifier(value.sessionId, 128)) &&
    isSafeWorkspaceSummaryV1(value.safeWorkspaceSummary);
}

function isExactIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isBoundedHumanText(value: unknown, maximumLength = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function isEditorialSourceRoleAttestationV3(value: unknown): value is EditorialSourceRoleAttestationV3 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sourceId", "role"]) &&
    isIdentifier(value.sourceId, 128) &&
    (value.role === "primary" || value.role === "independent" || value.role === "supporting")
  );
}

function isEditorialApprovalAttestationV3(value: unknown): value is EditorialApprovalAttestationV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["editorialReview", "expertReview", "ethicsReview"]) ||
    !isRecord(value.editorialReview) ||
    !hasExactKeys(value.editorialReview, ["reviewer", "sourceRoles"]) ||
    !isBoundedHumanText(value.editorialReview.reviewer, 256) ||
    !Array.isArray(value.editorialReview.sourceRoles) ||
    value.editorialReview.sourceRoles.length === 0 ||
    value.editorialReview.sourceRoles.length > 1_000 ||
    !value.editorialReview.sourceRoles.every(isEditorialSourceRoleAttestationV3)
  ) {
    return false;
  }
  const sourceIds = value.editorialReview.sourceRoles.map((source) => source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) return false;

  const expertReview = value.expertReview;
  if (
    expertReview !== null &&
    (
      !isRecord(expertReview) ||
      !hasExactKeys(expertReview, ["reviewer", "qualifications", "reviewScope"]) ||
      !isBoundedHumanText(expertReview.reviewer, 256) ||
      !isBoundedHumanText(expertReview.qualifications, 1_000) ||
      !isBoundedHumanText(expertReview.reviewScope, 2_000)
    )
  ) {
    return false;
  }

  const ethicsReview = value.ethicsReview;
  return ethicsReview === null || (
    isRecord(ethicsReview) &&
    hasExactKeys(ethicsReview, ["reviewer", "reviewScope", "rationale"]) &&
    isBoundedHumanText(ethicsReview.reviewer, 256) &&
    isBoundedHumanText(ethicsReview.reviewScope, 2_000) &&
    isBoundedHumanText(ethicsReview.rationale, 4_000)
  );
}

function isAutomationSettingsV1(
  value: unknown
): value is EngineAutomationSettingsV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "mode",
      "onboardingComplete",
      "ingestionPaused",
      "publishingPaused",
      "timezone",
      "scanIntervalMinutes"
    ])
  ) {
    return false;
  }
  return (
    (value.mode === "OFF" ||
      value.mode === "INGEST_ONLY" ||
      value.mode === "DRAFT_ONLY" ||
      value.mode === "PUBLISH_APPROVED") &&
    typeof value.onboardingComplete === "boolean" &&
    typeof value.ingestionPaused === "boolean" &&
    typeof value.publishingPaused === "boolean" &&
    typeof value.timezone === "string" &&
    value.timezone.length > 0 &&
    typeof value.scanIntervalMinutes === "number" &&
    Number.isInteger(value.scanIntervalMinutes)
  );
}

function isSourceSaveInputV1(value: unknown): value is SourceSaveInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      value.title === undefined
        ? ["url", "section", "articleType", "kind", "language"]
        : ["url", "section", "articleType", "kind", "language", "title"]
    )
  ) {
    return false;
  }
  return (
    typeof value.url === "string" &&
    value.url.length > 0 &&
    value.url.length <= 4_096 &&
    isSiteSection(value.section) &&
    SITE_SECTIONS[value.section].articleType ===
      value.articleType &&
    (value.kind === "RSS" ||
      value.kind === "ATOM" ||
      value.kind === "SITEMAP" ||
      value.kind === "SITE" ||
      value.kind === "ARTICLE") &&
    (value.language === "tr" ||
      value.language === "en" ||
      value.language === "other" ||
      value.language === "unknown") &&
    (value.title === undefined ||
      (typeof value.title === "string" && value.title.length <= 300))
  );
}

function isSourceScanTargetsV1(
  value: unknown
): value is SourceScanTargetV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    return false;
  }
  const sourceIds = new Set<string>();
  for (const target of value) {
    if (
      !isRecord(target) ||
      !hasExactKeys(target, ["sourceId", "expectedVersion"]) ||
      !isIdentifier(target.sourceId, 128) ||
      typeof target.expectedVersion !== "number" ||
      !Number.isSafeInteger(target.expectedVersion) ||
      target.expectedVersion < 0 ||
      sourceIds.has(target.sourceId)
    ) {
      return false;
    }
    sourceIds.add(target.sourceId);
  }
  return true;
}

function isSourceReviewInputV1(value: unknown): value is SourceReviewInputV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sourceId", "trustStatus", "rightsStatus", "rationale"]) &&
    isIdentifier(value.sourceId, 128) &&
    (value.trustStatus === "APPROVED" || value.trustStatus === "REJECTED") &&
    (value.rightsStatus === "APPROVED" || value.rightsStatus === "REJECTED") &&
    typeof value.rationale === "string" &&
    value.rationale.trim().length >= 10 &&
    value.rationale.length <= 1_000
  );
}

function isLocalizedArticle(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "title",
      "slug",
      "description",
      "bodyMarkdown",
      "heroImageAlt"
    ]) &&
    ["title", "slug", "description", "bodyMarkdown", "heroImageAlt"].every(
      (key) =>
        typeof value[key] === "string" &&
        (value[key] as string).length > 0 &&
        (value[key] as string).length <=
          (key === "bodyMarkdown" ? 500_000 : 4_096)
    )
  );
}

const MAX_REVISION_MEDIA_BYTES = 32 * 1024 * 1024;

function isRevisionMediaV2(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, [
    "role",
    "path",
    "sha256",
    "width",
    "height",
    ...(value.byteSize === undefined ? [] : ["byteSize"]),
    ...(value.contentBase64 === undefined ? [] : ["contentBase64"]),
    ...(value.source === undefined ? [] : ["source"])
  ])) return false;
  return (
    (value.role === "hero" || value.role === "inline") &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    value.path.length <= 4_096 &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/iu.test(value.sha256) &&
    Number.isSafeInteger(value.width) &&
    Number(value.width) > 0 &&
    Number.isSafeInteger(value.height) &&
    Number(value.height) > 0 &&
    (value.byteSize === undefined || (
      Number.isSafeInteger(value.byteSize) &&
      Number(value.byteSize) > 0 &&
      Number(value.byteSize) <= MAX_REVISION_MEDIA_BYTES
    )) &&
    (value.contentBase64 === undefined || typeof value.contentBase64 === "string") &&
    (value.source === undefined || value.source === "IMAGEGEN" || value.source === "LOCAL_RENDERER")
  );
}

function isRevisionPackageV2(value: unknown): value is RevisionPackageV2 {
  if (
    !isRecord(value) ||
    !isBoundedJson(value, 1_000_000) ||
    !hasExactKeys(value, [
      "id",
      ...(value.supersedesRevisionId === undefined ? [] : ["supersedesRevisionId"]),
      "translationKey",
      "state",
      "tr",
      "en",
      "section",
      "articleType",
      "author",
      "tags",
      "claims",
      "sources",
      "media",
      "scheduledAt",
      "adapterVersion",
      "editorialDesk",
      "riskLevel",
      "translationParity",
      "editorialPolicyHash",
      "editorialReviewReportHash",
      "targetRepository",
      "targetBaseBranch",
      "targetBaseSha",
      "generatedFiles",
      "qualityGates"
    ]) ||
    !isIdentifier(value.id, 128) ||
    (value.supersedesRevisionId !== undefined &&
      !isIdentifier(value.supersedesRevisionId, 128)) ||
    !isIdentifier(value.translationKey, 128) ||
    ![
      "DISCOVERED",
      "CLUSTERED",
      "RESEARCHING",
      "NEEDS_SOURCE",
      "DRAFTING",
      "ROUTING_REQUIRED",
      "REVIEW_REQUIRED",
      "APPROVED",
      "PR_READY",
      "SCHEDULED",
      "PUBLISHING",
      "PUBLISHED"
    ].includes(value.state as string) ||
    !isLocalizedArticle(value.tr) ||
    !isLocalizedArticle(value.en) ||
    !isSiteSection(value.section) ||
    SITE_SECTIONS[value.section].articleType !== value.articleType ||
    typeof value.author !== "string" ||
    value.author.trim().length === 0 ||
    value.author.length > 300 ||
    !Array.isArray(value.tags) ||
    value.tags.length > 100 ||
    !value.tags.every(
      (tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 100
    ) ||
    !Array.isArray(value.claims) ||
    value.claims.length > 1_000 ||
    !Array.isArray(value.sources) ||
    value.sources.length > 1_000 ||
    !Array.isArray(value.media) ||
    value.media.length > 1_000 ||
    typeof value.scheduledAt !== "string" ||
    !Number.isFinite(Date.parse(value.scheduledAt)) ||
    typeof value.adapterVersion !== "string" ||
    value.adapterVersion.trim().length === 0
  ) {
    return false;
  }

  const revision = value as unknown as RevisionPackageV2;
  return (
    revision.claims.every(
      (claim) =>
        isRecord(claim) &&
        hasExactKeys(claim, [
          "id",
          "locale",
          "text",
          "sourceIds",
          "status",
          "claimKey",
          "trText",
          "enText",
          "evidenceAnchors"
        ]) &&
        isIdentifier(claim.id, 128) &&
        (claim.locale === "tr" ||
          claim.locale === "en" ||
          claim.locale === "both") &&
        typeof claim.text === "string" &&
        claim.text.length > 0 &&
        claim.text.length <= 20_000 &&
        Array.isArray(claim.sourceIds) &&
        claim.sourceIds.length > 0 &&
        claim.sourceIds.length <= 100 &&
        claim.sourceIds.every((sourceId) => isIdentifier(sourceId, 128)) &&
        (claim.status === "VERIFIED" ||
          claim.status === "NEEDS_SOURCE" ||
          claim.status === "DISPUTED") &&
        typeof claim.claimKey === "string" &&
        claim.claimKey.length > 0 &&
        claim.claimKey.length <= 256 &&
        typeof claim.trText === "string" &&
        claim.trText.length > 0 &&
        claim.trText.length <= 20_000 &&
        typeof claim.enText === "string" &&
        claim.enText.length > 0 &&
        claim.enText.length <= 20_000 &&
        Array.isArray(claim.evidenceAnchors) &&
        claim.evidenceAnchors.length > 0 &&
        claim.evidenceAnchors.length <= 100 &&
        claim.evidenceAnchors.every(
          (anchor) =>
            isRecord(anchor) &&
            hasExactKeys(
              anchor,
              [
                "sourceId",
                "quoteHash",
                ...(anchor.start === undefined ? [] : ["start"]),
                ...(anchor.end === undefined ? [] : ["end"])
              ]
            ) &&
            isIdentifier(anchor.sourceId, 128) &&
            typeof anchor.quoteHash === "string" &&
            /^[a-f0-9]{64}$/iu.test(anchor.quoteHash) &&
            (anchor.start === undefined ||
              (Number.isSafeInteger(anchor.start) && anchor.start >= 0)) &&
            (anchor.end === undefined ||
              (Number.isSafeInteger(anchor.end) && anchor.end >= 0))
        )
    ) &&
    revision.sources.every(
      (source) =>
        isRecord(source) &&
        hasExactKeys(source, [
          "id",
          "url",
          "title",
          "fetchedAt",
          "contentHash",
          "evidenceAnchors",
          ...(source.evidenceExcerpt === undefined ? [] : ["evidenceExcerpt"]),
          ...(source.evidenceExcerptHash === undefined ? [] : ["evidenceExcerptHash"]),
          ...(source.evidenceVersionId === undefined ? [] : ["evidenceVersionId"]),
          ...(source.trustStatus === undefined ? [] : ["trustStatus"]),
          ...(source.rightsStatus === undefined ? [] : ["rightsStatus"])
        ]) &&
        isIdentifier(source.id, 128) &&
        typeof source.url === "string" &&
        source.url.length <= 4_096 &&
        typeof source.title === "string" &&
        source.title.length <= 1_000 &&
        typeof source.fetchedAt === "string" &&
        Number.isFinite(Date.parse(source.fetchedAt)) &&
        typeof source.contentHash === "string" &&
        /^[a-f0-9]{64}$/iu.test(source.contentHash) &&
        (source.evidenceExcerpt === undefined ||
          (typeof source.evidenceExcerpt === "string" && source.evidenceExcerpt.length > 0 && source.evidenceExcerpt.length <= 12_000)) &&
        (source.evidenceExcerptHash === undefined ||
          (typeof source.evidenceExcerptHash === "string" && /^[a-f0-9]{64}$/iu.test(source.evidenceExcerptHash))) &&
        (source.evidenceVersionId === undefined ||
          (typeof source.evidenceVersionId === "string" && /^entry-[a-f0-9]{64}$/iu.test(source.evidenceVersionId))) &&
        Array.isArray(source.evidenceAnchors) &&
        source.evidenceAnchors.length > 0 &&
        source.evidenceAnchors.length <= 100 &&
        source.evidenceAnchors.every(
          (anchor) =>
            isRecord(anchor) &&
            hasExactKeys(anchor, [
              "sourceId",
              "quoteHash",
              ...(anchor.start === undefined ? [] : ["start"]),
              ...(anchor.end === undefined ? [] : ["end"])
            ]) &&
            anchor.sourceId === source.id &&
            typeof anchor.quoteHash === "string" &&
            /^[a-f0-9]{64}$/iu.test(anchor.quoteHash) &&
            (anchor.start === undefined || (Number.isSafeInteger(anchor.start) && anchor.start >= 0)) &&
            (anchor.end === undefined || (Number.isSafeInteger(anchor.end) && anchor.end >= 0)) &&
            (anchor.start === undefined || anchor.end === undefined || anchor.end >= anchor.start)
        ) &&
        (source.trustStatus === undefined ||
          source.trustStatus === "PENDING" ||
          source.trustStatus === "APPROVED" ||
          source.trustStatus === "REJECTED") &&
        (source.rightsStatus === undefined ||
          source.rightsStatus === "PENDING" ||
          source.rightsStatus === "APPROVED" ||
          source.rightsStatus === "REJECTED")
    ) &&
    revision.media.some((media) => isRecord(media) && media.role === "hero") &&
    revision.media.every(isRevisionMediaV2) &&
    validateRevisionPackageV2(revision) &&
    validateClaimEvidence(revision)
  );
}

function isRevisionPackageV3(value: unknown): value is RevisionPackageV3 {
  if (!isRecord(value) || !isBoundedJson(value, 1_000_000)) return false;
  const keys = [
    "id",
    ...(value.supersedesRevisionId === undefined ? [] : ["supersedesRevisionId"]),
    "translationKey", "state", "tr", "en", "section", "articleType", "author",
    "tags", "claims", "sources", "media", "scheduledAt", "adapterVersion",
    "editorialDesk", "riskLevel", "translationParity", "editorialPolicyHash",
    "editorialReviewReportHash", "targetRepository", "targetBaseBranch",
    "targetBaseSha", "generatedFiles", "qualityGates", "packageVersion",
    "editorialContext", "editorialAssessment", "publicationSources",
    "deployWorkflow", "requiredChecks"
  ];
  return hasExactKeys(value, keys) &&
    validateRevisionPackageV3(value as unknown as ArticleRevision) &&
    validateClaimEvidence(value as unknown as ArticleRevision);
}

function isBoundedJson(value: unknown, maximumBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return (
      typeof serialized === "string" &&
      new TextEncoder().encode(serialized).byteLength <= maximumBytes
    );
  } catch {
    return false;
  }
}

export function validateEngineCommandV1(
  value: unknown
): EngineCommandValidationV1 {
  const invalid = (message: string): EngineCommandValidationV1 => ({
    valid: false,
    error: { code: "INVALID_COMMAND", message, retryable: false }
  });
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "requestId",
      "idempotencyKey",
      "expectedVersion",
      "kind",
      "payload"
    ])
  ) {
    return invalid("Command shape is invalid");
  }
  if (value.version !== 1) {
    return invalid("Only EngineCommandV1 is supported");
  }
  if (!isIdentifier(value.requestId, 128)) {
    return invalid("requestId is invalid");
  }
  if (!isIdentifier(value.idempotencyKey, 200)) {
    return invalid("idempotencyKey is invalid");
  }
  if (
    typeof value.expectedVersion !== "number" ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0
  ) {
    return invalid("expectedVersion is invalid");
  }
  if (value.kind === "AUTOMATION.SET") {
    if (!isRecord(value.payload) || !hasExactKeys(value.payload, ["settings"])) {
      return invalid("AUTOMATION.SET payload is invalid");
    }
    if (!isAutomationSettingsV1(value.payload.settings)) {
      return invalid("Automation settings are invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "AUTOMATION.SET",
        payload: { settings: { ...value.payload.settings } }
      }
    };
  }
  if (value.kind === "SOURCE.SAVE") {
    if (!isRecord(value.payload) || !hasExactKeys(value.payload, ["source"])) {
      return invalid("SOURCE.SAVE payload is invalid");
    }
    if (!isSourceSaveInputV1(value.payload.source)) {
      return invalid("Source input is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "SOURCE.SAVE",
        payload: { source: { ...value.payload.source } }
      }
    };
  }
  if (value.kind === "SOURCE.REVIEW") {
    if (!isSourceReviewInputV1(value.payload)) {
      return invalid("SOURCE.REVIEW payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "SOURCE.REVIEW",
        payload: { ...value.payload, rationale: value.payload.rationale.trim() }
      }
    };
  }
  if (value.kind === "SOURCE.SCAN") {
    if (
      value.expectedVersion !== 0 ||
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, ["targets"]) ||
      !isSourceScanTargetsV1(value.payload.targets)
    ) {
      return invalid("SOURCE.SCAN payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: 0,
        kind: "SOURCE.SCAN",
        payload: {
          targets: value.payload.targets.map((target) => ({ ...target }))
        }
      }
    };
  }
  if (value.kind === "DRAFT.CREATE") {
    if (!isDraftCreateInputV1(value.payload)) return invalid("DRAFT.CREATE payload is invalid");
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "DRAFT.CREATE",
        payload: structuredClone(value.payload)
      }
    };
  }
  if (value.kind === "BOBY.GUIDE") {
    if (!isBobyGuideInputV1(value.payload)) return invalid("BOBY.GUIDE payload is invalid");
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "BOBY.GUIDE",
        payload: structuredClone(value.payload)
      }
    };
  }
  if (value.kind === "JOB.RETRY") {
    if (!isRecord(value.payload) || !hasExactKeys(value.payload, ["jobId"]) || !isIdentifier(value.payload.jobId, 128)) {
      return invalid("JOB.RETRY payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "JOB.RETRY",
        payload: { jobId: value.payload.jobId }
      }
    };
  }
  if (value.kind === "LOCAL_STATE.SET") {
    if (
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, ["key", "value"]) ||
      !isIdentifier(value.payload.key, 128) ||
      !isBoundedJson(value.payload.value, 256_000)
    ) {
      return invalid("LOCAL_STATE.SET payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "LOCAL_STATE.SET",
        payload: { key: value.payload.key, value: structuredClone(value.payload.value) }
      }
    };
  }
  if (value.kind === "REVISION.SAVE") {
    if (
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, ["revision"]) ||
      !isRevisionPackageV2(value.payload.revision) &&
      !isRevisionPackageV3(value.payload.revision)
    ) {
      return invalid("REVISION.SAVE payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "REVISION.SAVE",
        payload: { revision: structuredClone(value.payload.revision) }
      }
    };
  }
  if (value.kind === "REVISION.LIST") {
    if (
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, Object.keys(value.payload).filter((key) => key === "summaryOnly")) ||
      ("summaryOnly" in value.payload && typeof value.payload.summaryOnly !== "boolean")
    ) {
      return invalid("REVISION.LIST payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "REVISION.LIST",
        payload: "summaryOnly" in value.payload
          ? { summaryOnly: value.payload.summaryOnly as boolean }
          : {}
      }
    };
  }
  if (value.kind === "REVISION.GET") {
    if (
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, ["revisionId"]) ||
      !isIdentifier(value.payload.revisionId, 128)
    ) {
      return invalid("REVISION.GET payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "REVISION.GET",
        payload: { revisionId: value.payload.revisionId }
      }
    };
  }
  if (value.kind === "REVISION.REPAIR_MEDIA") {
    if (
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, ["revisionId"]) ||
      !isIdentifier(value.payload.revisionId, 128)
    ) {
      return invalid("REVISION.REPAIR_MEDIA payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "REVISION.REPAIR_MEDIA",
        payload: { revisionId: value.payload.revisionId }
      }
    };
  }
  if (value.kind === "APPROVAL.GRANT") {
    const legacyKeys = ["revisionId", "revisionHash", "deviceId", "warningSetHash"] as const;
    const v3Keys = [...legacyKeys, "packageVersion", "attestation"] as const;
    if (
      !isRecord(value.payload) ||
      (!hasExactKeys(value.payload, legacyKeys) && !hasExactKeys(value.payload, v3Keys)) ||
      !isIdentifier(value.payload.revisionId, 128) ||
      typeof value.payload.revisionHash !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(value.payload.revisionHash) ||
      !isIdentifier(value.payload.deviceId, 128) ||
      typeof value.payload.warningSetHash !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(value.payload.warningSetHash) ||
      (
        hasExactKeys(value.payload, v3Keys) &&
        (
          value.payload.packageVersion !== 3 ||
          !isEditorialApprovalAttestationV3(value.payload.attestation)
        )
      )
    ) {
      return invalid("APPROVAL.GRANT payload is invalid");
    }
    const common = {
      revisionId: value.payload.revisionId,
      revisionHash: value.payload.revisionHash.toLowerCase(),
      deviceId: value.payload.deviceId,
      warningSetHash: value.payload.warningSetHash.toLowerCase()
    };
    if (hasExactKeys(value.payload, v3Keys)) {
      return {
        valid: true,
        command: {
          version: 1,
          requestId: value.requestId,
          idempotencyKey: value.idempotencyKey,
          expectedVersion: value.expectedVersion,
          kind: "APPROVAL.GRANT",
          payload: {
            ...common,
            packageVersion: 3,
            attestation: structuredClone(value.payload.attestation as EditorialApprovalAttestationV3)
          }
        }
      };
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "APPROVAL.GRANT",
        payload: common
      }
    };
  }
  if (value.kind === "APPROVAL.REVOKE") {
    if (
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, ["revisionId", "revisionHash", "deviceId", "reason"]) ||
      !isIdentifier(value.payload.revisionId, 128) ||
      typeof value.payload.revisionHash !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(value.payload.revisionHash) ||
      !isIdentifier(value.payload.deviceId, 128) ||
      !isBoundedHumanText(value.payload.reason)
    ) {
      return invalid("APPROVAL.REVOKE payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "APPROVAL.REVOKE",
        payload: {
          revisionId: value.payload.revisionId,
          revisionHash: value.payload.revisionHash.toLowerCase(),
          deviceId: value.payload.deviceId,
          reason: value.payload.reason.trim()
        }
      }
    };
  }
  if (value.kind === "APPROVAL.GRANT_HIGH_RISK") {
    if (
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, [
        "revisionId",
        "revisionHash",
        "deviceId",
        "riskChecklistHash",
        "warningSetHash",
        "windowsReauthenticatedAt"
      ]) ||
      !isIdentifier(value.payload.revisionId, 128) ||
      typeof value.payload.revisionHash !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(value.payload.revisionHash) ||
      !isIdentifier(value.payload.deviceId, 128) ||
      typeof value.payload.riskChecklistHash !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(value.payload.riskChecklistHash) ||
      typeof value.payload.warningSetHash !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(value.payload.warningSetHash) ||
      !isExactIsoDate(value.payload.windowsReauthenticatedAt)
    ) {
      return invalid("APPROVAL.GRANT_HIGH_RISK payload is invalid");
    }
    return {
      valid: true,
      command: {
        version: 1,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        kind: "APPROVAL.GRANT_HIGH_RISK",
        payload: {
          revisionId: value.payload.revisionId,
          revisionHash: value.payload.revisionHash.toLowerCase(),
          deviceId: value.payload.deviceId,
          riskChecklistHash: value.payload.riskChecklistHash.toLowerCase(),
          warningSetHash: value.payload.warningSetHash.toLowerCase(),
          windowsReauthenticatedAt: value.payload.windowsReauthenticatedAt
        }
      }
    };
  }
  return invalid("Command kind is not supported");
}

import {
  validateClaimEvidence,
  validateRevisionPackageV2,
  validateRevisionPackageV3,
  type ArticleRevision,
  type RevisionPackageV2,
  type RevisionPackageV3
} from "../../editorial/src/revision.ts";
import type {
  EditorialApprovalAttestationV3,
  EditorialSourceRoleAttestationV3
} from "../../editorial/src/quality-gates.ts";
