import { createHash } from "node:crypto";
import type { ArticleType, SiteSection } from "../../contracts/src/index.ts";
import { isSafeGitHubWorkflowName } from "../../contracts/src/github-policy.ts";
import {
  evaluateEditorialQualityV3,
  type EditorialApprovalAttestationV3,
  type EditorialAssessmentV3,
  type EditorialSourceRoleV3
} from "./quality-gates.ts";

export type ArticleState =
  | "DISCOVERED"
  | "CLUSTERED"
  | "RESEARCHING"
  | "NEEDS_SOURCE"
  | "DRAFTING"
  | "ROUTING_REQUIRED"
  | "REVIEW_REQUIRED"
  | "APPROVED"
  | "PR_READY"
  | "SCHEDULED"
  | "PUBLISHING"
  | "PUBLISHED";

export interface LocalizedArticle {
  title: string;
  slug: string;
  description: string;
  bodyMarkdown: string;
  heroImageAlt: string;
}

export interface Claim {
  id: string;
  locale: "tr" | "en" | "both";
  text: string;
  sourceIds: string[];
  status: "VERIFIED" | "NEEDS_SOURCE" | "DISPUTED";
  /** Stable, language-independent identifier for the same claim in TR and EN. */
  claimKey?: string;
  /** Separate language renderings are required for enriched claim records. */
  trText?: string;
  enText?: string;
  /** Exact evidence anchors captured from immutable source snapshots. */
  evidenceAnchors?: EvidenceAnchor[];
}

export interface EvidenceAnchor {
  sourceId: string;
  quoteHash: string;
  start?: number;
  end?: number;
}

export interface SourceSnapshot {
  id: string;
  url: string;
  title: string;
  fetchedAt: string;
  contentHash: string;
  /**
   * Bounded, immutable evidence text that was available when this revision
   * was assembled. It is deliberately stored in the revision hash so a later
   * source scan, retention run, or restore cannot rewrite claim evidence.
   */
  evidenceExcerpt?: string;
  /** SHA-256 of evidenceExcerpt, retained for cheap independent verification. */
  evidenceExcerptHash?: string;
  /** Content-addressed source repository capture that produced this evidence. */
  evidenceVersionId?: string;
  /** Immutable excerpts captured when the local engine assembled this revision. */
  evidenceAnchors?: EvidenceAnchor[];
  /** Optional for legacy readability; absence is treated as PENDING at publish time. */
  trustStatus?: SourcePolicyStatus;
  /** Optional for legacy readability; absence is treated as PENDING at publish time. */
  rightsStatus?: SourcePolicyStatus;
}

export type SourcePolicyStatus = "PENDING" | "APPROVED" | "REJECTED";

export type SourcePolicyEligibility =
  | { eligible: true }
  | { eligible: false; reason: "SOURCE_TRUST_NOT_APPROVED" | "SOURCE_RIGHTS_NOT_APPROVED" };

export interface MediaArtifact {
  role: "hero" | "inline";
  /** Renderer provenance is approval-bound for newly materialized media. */
  source?: "IMAGEGEN" | "LOCAL_RENDERER";
  /** Engine-owned relative asset reference. */
  path: string;
  sha256: string;
  /** Verified size; absent only on legacy records pending migration. */
  byteSize?: number;
  width: number;
  height: number;
  /** Optional inline payload used by the local publication preview. */
  contentBase64?: string;
}

export type RevisionRiskLevel = "STANDARD" | "HIGH";
export type TranslationParityStatus = "PENDING" | "MATCHED" | "MISMATCHED";

export interface TranslationParityReport {
  status: TranslationParityStatus;
  /** Hash of the immutable parity report that justified the status. */
  reportHash: string;
}

export interface GeneratedFileManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export type EditorialGateState = "PASS" | "WARN" | "BLOCK" | "NOT_RUN";
export interface EditorialGateResult {
  id: string;
  group: "editorial" | "seo" | "security" | "media";
  state: EditorialGateState;
  detail: string;
  policyVersion: string;
  /** Typed, approval-bound explanation for a V2 warning or block. */
  reasonCode?: string;
}

/**
 * V1 gate ids whose WARN state a human may still accept. Only real gate ids
 * belong here: this set is compared against `gate.id`, so an editorial warning
 * *code* placed in it can never match anything and only reads as if a policy
 * were enforced.
 */
export const ACCEPTABLE_EDITORIAL_WARNING_IDS = new Set([
  "contradictions",
  "seo",
  "media"
]);

const V2_WARNING_REASONS: Readonly<Record<string, ReadonlySet<string>>> = {
  contradictions: new Set(["DISCLOSED_SOURCE_DISAGREEMENT"]),
  seo: new Set(["SEO_POLISH"])
};

export interface ArticleRevision {
  id: string;
  /** Immutable link to the revision replaced by this revision, when any. */
  supersedesRevisionId?: string;
  translationKey: string;
  state: ArticleState;
  tr: LocalizedArticle;
  en: LocalizedArticle;
  section: SiteSection;
  articleType: ArticleType;
  author: string;
  tags: string[];
  claims: Claim[];
  sources: SourceSnapshot[];
  media: MediaArtifact[];
  scheduledAt: string;
  adapterVersion: string;
  /** V2 approval-bound fields. Optional only while persisted V1 records migrate. */
  editorialDesk?: string;
  riskLevel?: RevisionRiskLevel;
  translationParity?: TranslationParityReport;
  editorialPolicyHash?: string;
  editorialReviewReportHash?: string;
  targetRepository?: string;
  targetBaseBranch?: string;
  targetBaseSha?: string;
  generatedFiles?: GeneratedFileManifestEntry[];
  qualityGates?: EditorialGateResult[];
  /** V3-only immutable instruction and disclosure context. */
  packageVersion?: 3;
  editorialContext?: EditorialContextV3;
  editorialAssessment?: EditorialAssessmentV3;
  publicationSources?: PublicationSourceV3[];
  deployWorkflow?: string;
  requiredChecks?: string[];
}

/** Complete immutable package required by the V2 approval workflow. */
export interface RevisionPackageV2 extends ArticleRevision {
  editorialDesk: string;
  riskLevel: RevisionRiskLevel;
  translationParity: TranslationParityReport;
  editorialPolicyHash: string;
  editorialReviewReportHash: string;
  targetRepository: string;
  targetBaseBranch: string;
  targetBaseSha: string;
  generatedFiles: GeneratedFileManifestEntry[];
  qualityGates: EditorialGateResult[];
}

export interface EditorialContextV3 {
  readonly instruction: string;
  readonly instructionHash: string;
  readonly contentOrigin: "CODEX_ASSISTED";
  readonly aiDisclosure: "GENERATED_WITH_AI";
}

/**
 * Public source metadata is intentionally narrower than SourceSnapshot:
 * evidence excerpts, hashes, capture ids and internal policy decisions must
 * never cross the publication boundary.
 */
export interface PublicationSourceV3 {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly role: EditorialSourceRoleV3;
}

/** Complete immutable package required by the V3 approval workflow. */
export interface RevisionPackageV3 extends RevisionPackageV2 {
  packageVersion: 3;
  editorialContext: EditorialContextV3;
  editorialAssessment: EditorialAssessmentV3;
  publicationSources: PublicationSourceV3[];
  deployWorkflow: string;
  requiredChecks: string[];
}

interface ApprovalRecord {
  revisionId: string;
  revisionHash: string;
  deviceId: string;
  approvedAt: string;
  warningSetHash?: string;
}

export interface Approval extends ApprovalRecord {
  approvalType?: "EDITORIAL";
}

/** Human attestations are approval records, not model-authored revision data. */
export interface ApprovalV3 extends ApprovalRecord {
  packageVersion: 3;
  approvalType: "EDITORIAL";
  attestation: EditorialApprovalAttestationV3;
  attestationHash: string;
}

export interface HighRiskApproval extends ApprovalRecord {
  approvalType: "HIGH_RISK";
  riskChecklistHash: string;
  windowsReauthenticatedAt: string;
}

export interface ApprovalBundle {
  editorial: Approval | ApprovalV3;
  highRisk: HighRiskApproval | null;
}

/** The complete, typed review set that every immutable V2 package must bind. */
const REQUIRED_V2_QUALITY_GATES = {
  claims: "editorial",
  contradictions: "editorial",
  "bilingual-parity": "editorial",
  "markdown-safety": "security",
  seo: "seo",
  media: "media"
} as const;

const REQUIRED_V3_QUALITY_GATES = {
  ...REQUIRED_V2_QUALITY_GATES,
  "editorial-policy": "editorial"
} as const;

export interface RevisionLineageEntry {
  id: string;
  supersedesRevisionId?: string;
}

/** A successor's immutable parent link is the sole supersession signal. */
export function isRevisionSuperseded(
  revision: RevisionLineageEntry,
  lineage: readonly RevisionLineageEntry[]
): boolean {
  return lineage.some(
    (candidate) =>
      candidate.id !== revision.id &&
      candidate.supersedesRevisionId === revision.id
  );
}

export type PublishBlockReason =
  | "NO_APPROVAL"
  | "REVISION_NOT_APPROVED"
  | "REVISION_SUPERSEDED"
  | "APPROVAL_REVISION_MISMATCH"
  | "APPROVAL_HASH_MISMATCH"
  | "NEEDS_SOURCE"
  | "SOURCE_TRUST_NOT_APPROVED"
  | "SOURCE_RIGHTS_NOT_APPROVED"
  | "PUBLISHING_PAUSED"
  | "NOT_DUE"
  | "SCHEDULE_EXPIRED"
  | "INVALID_CLAIM_EVIDENCE"
  | "REVISION_PACKAGE_INCOMPLETE"
  | "QUALITY_GATES_NOT_READY"
  | "WARNING_NOT_ALLOWLISTED"
  | "WARNING_ACCEPTANCE_MISMATCH"
  | "EDITORIAL_ATTESTATION_REQUIRED"
  | "EDITORIAL_ATTESTATION_HASH_MISMATCH"
  | "EDITORIAL_ATTESTATION_INVALID"
  | "EDITORIAL_QUALITY_NOT_READY"
  | "TRANSLATION_PARITY_MISMATCH"
  | "TRANSLATION_PARITY_PENDING"
  | "HIGH_RISK_APPROVAL_REQUIRED"
  | "HIGH_RISK_APPROVAL_REVISION_MISMATCH"
  | "HIGH_RISK_APPROVAL_HASH_MISMATCH"
  | "HIGH_RISK_APPROVAL_INVALID";

export type PublishEligibility =
  | { eligible: true }
  | { eligible: false; reason: PublishBlockReason };

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function toCanonicalValue(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return value.replace(/\r\n?/g, "\n");
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at ${path}`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => toCanonicalValue(item, `${path}[${index}]`));
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-JSON object at ${path}`);
    }
    // A plain `{}` accumulator inherits Object.prototype's `__proto__` setter,
    // so assigning an own `__proto__` key parsed from NDJSON would set the
    // prototype instead of adding a property: the key vanished from the emitted
    // JSON and two different objects hashed identically. Refuse those keys
    // outright so a collision is a hard error, never a silent drop.
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`Unsafe canonical JSON key at ${path}.${key}`);
      }
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new TypeError(`Undefined value at ${path}.${key}`);
      }
      result[key] = toCanonicalValue(item, `${path}.${key}`);
    }
    return result;
  }

  throw new TypeError(`Unsupported canonical JSON value at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value, "$"));
}

function approvedPackage(revision: ArticleRevision): Omit<ArticleRevision, "state"> {
  const { state: _state, ...packageValue } = revision;
  return packageValue;
}

export function computeRevisionHash(revision: ArticleRevision): string {
  return createHash("sha256")
    .update(canonicalJson(approvedPackage(revision)), "utf8")
    .digest("hex");
}

export function computeWarningSetHash(
  gates: readonly EditorialGateResult[]
): string {
  const warnings = gates
    .filter((gate) => gate.state === "WARN")
    .map(({ id, group, state, detail, policyVersion, reasonCode }) => ({
      id,
      group,
      state,
      detail,
      policyVersion,
      ...(reasonCode ? { reasonCode } : {})
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(canonicalJson(warnings), "utf8").digest("hex");
}

export function computeEditorialAttestationHash(
  attestation: EditorialApprovalAttestationV3
): string {
  return createHash("sha256")
    .update(canonicalJson(attestation), "utf8")
    .digest("hex");
}

export function validateApprovalGates(
  revision: ArticleRevision,
  warningSetHash: string | undefined
): "READY" | "QUALITY_GATES_NOT_READY" | "WARNING_NOT_ALLOWLISTED" | "WARNING_ACCEPTANCE_MISMATCH" {
  const gates = revision.qualityGates;
  if (!Array.isArray(gates) || gates.length === 0 || gates.some((gate) => gate.state === "BLOCK" || gate.state === "NOT_RUN")) {
    return "QUALITY_GATES_NOT_READY";
  }
  const warnings = gates.filter((gate) => gate.state === "WARN");
  if (warnings.some((gate) => {
    if (gate.policyVersion === "2") {
      return !V2_WARNING_REASONS[gate.id]?.has(gate.reasonCode ?? "");
    }
    return gate.policyVersion !== "1" || !ACCEPTABLE_EDITORIAL_WARNING_IDS.has(gate.id);
  })) {
    return "WARNING_NOT_ALLOWLISTED";
  }
  if (!warningSetHash || computeWarningSetHash(gates) !== warningSetHash) {
    return "WARNING_ACCEPTANCE_MISMATCH";
  }
  return "READY";
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeGitBranch(value: unknown): value is string {
  return (
    hasText(value) &&
    value === value.trim() &&
    !/[\s~^:?*[\]\\]/u.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

function isSafeManifestPath(value: unknown): value is string {
  if (
    !hasText(value) ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("\0")
  );
}

/** Runtime boundary for persisted V1 records entering the V2 approval flow. */
export function validateRevisionPackageV2(
  revision: ArticleRevision
): revision is RevisionPackageV2 {
  if (
    !hasText(revision.editorialDesk) ||
    (revision.riskLevel !== "STANDARD" && revision.riskLevel !== "HIGH") ||
    revision.translationParity === undefined ||
    !["PENDING", "MATCHED", "MISMATCHED"].includes(
      revision.translationParity.status
    ) ||
    !SHA256_PATTERN.test(revision.translationParity.reportHash) ||
    !hasText(revision.editorialPolicyHash) ||
    !SHA256_PATTERN.test(revision.editorialPolicyHash) ||
    !hasText(revision.editorialReviewReportHash) ||
    !SHA256_PATTERN.test(revision.editorialReviewReportHash) ||
    !hasText(revision.targetRepository) ||
    !REPOSITORY_PATTERN.test(revision.targetRepository) ||
    !isSafeGitBranch(revision.targetBaseBranch) ||
    !hasText(revision.targetBaseSha) ||
    !GIT_OBJECT_ID_PATTERN.test(revision.targetBaseSha) ||
    !Array.isArray(revision.generatedFiles) ||
    revision.generatedFiles.length === 0 ||
    !Array.isArray(revision.qualityGates) ||
    revision.qualityGates.length === 0
  ) {
    return false;
  }

  const paths = new Set<string>();
  for (const file of revision.generatedFiles) {
    if (
      !isSafeManifestPath(file.path) ||
      !SHA256_PATTERN.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      paths.has(file.path)
    ) {
      return false;
    }
    paths.add(file.path);
  }
  const gateIds = new Set<string>();
  for (const gate of revision.qualityGates) {
    if (
      !hasText(gate.id) ||
      !["editorial", "seo", "security", "media"].includes(gate.group) ||
      !["PASS", "WARN", "BLOCK", "NOT_RUN"].includes(gate.state) ||
      !hasText(gate.detail) ||
      !hasText(gate.policyVersion) ||
      gateIds.has(gate.id)
    ) return false;
    gateIds.add(gate.id);
  }
  // Only the required set is mandated, not the exact set. A package may carry
  // an additional gate such as `publication-target`, whose NOT_RUN state must
  // reach `validateApprovalGates` as a specific block instead of being hidden
  // behind a generic "package incomplete" verdict.
  for (const [id, group] of Object.entries(REQUIRED_V2_QUALITY_GATES)) {
    const gate = revision.qualityGates.find((candidate) => candidate.id === id);
    if (!gate || gate.group !== group) return false;
  }
  return true;
}

export function hasRevisionPackageV2Fields(revision: ArticleRevision): boolean {
  return [
    revision.editorialDesk,
    revision.riskLevel,
    revision.translationParity,
    revision.editorialPolicyHash,
    revision.editorialReviewReportHash,
    revision.targetRepository,
    revision.targetBaseBranch,
    revision.targetBaseSha,
    revision.generatedFiles,
    revision.qualityGates
  ].some((value) => value !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNullableTextShape(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isEditorialSourceRoleV3(value: unknown): value is EditorialSourceRoleV3 {
  return value === "primary" || value === "independent" || value === "supporting";
}

function validateEditorialAssessmentV3Shape(
  value: unknown
): value is EditorialAssessmentV3 {
  if (!isRecord(value)) return false;
  if (
    !["news", "analysis", "deep_dive", "guide"].includes(String(value.articleType)) ||
    typeof value.intentSatisfied !== "boolean" ||
    typeof value.titleIsHonest !== "boolean" ||
    typeof value.originalValuePresent !== "boolean" ||
    typeof value.allClaimsVerified !== "boolean" ||
    !Array.isArray(value.sources) ||
    !hasNullableTextShape(value.singleOfficialSourceRationale) ||
    typeof value.authorTransparent !== "boolean" ||
    typeof value.aiDisclosureMatchesUsage !== "boolean" ||
    typeof value.isYmyl !== "boolean" ||
    typeof value.leadHasFiveWOneH !== "boolean" ||
    typeof value.unverifiedClaimsClearlyLabeled !== "boolean" ||
    typeof value.newsSchemaComplete !== "boolean" ||
    typeof value.sensitiveTopic !== "boolean" ||
    !hasNullableTextShape(value.clusterKey) ||
    typeof value.aboveFoldAnswersIntent !== "boolean" ||
    typeof value.headingHierarchyValid !== "boolean" ||
    !Number.isSafeInteger(value.internalLinkCount) ||
    (value.internalLinkCount as number) < 0 ||
    !hasNullableTextShape(value.internalLinkOmissionRationale)
  ) {
    return false;
  }

  const ids = new Set<string>();
  for (const item of value.sources) {
    if (
      !isRecord(item) ||
      !hasText(item.sourceId) ||
      typeof item.cited !== "boolean" ||
      typeof item.official !== "boolean" ||
      !isEditorialSourceRoleV3(item.role) ||
      ids.has(item.sourceId)
    ) {
      return false;
    }
    ids.add(item.sourceId);
  }
  return true;
}

function normalizedRequiredChecks(
  checks: readonly string[]
): string[] {
  return [...new Set(checks.map((check) => check.trim()).filter(Boolean))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function hasNormalizedRequiredChecks(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some(
      (check) =>
        typeof check !== "string" ||
        check.length > 200 ||
        check !== check.trim() ||
        !hasText(check)
    )
  ) {
    return false;
  }
  const normalized = normalizedRequiredChecks(value);
  return (
    normalized.length === value.length &&
    normalized.every((check, index) => check === value[index])
  );
}

function publicationSourceProjectionMatches(
  revision: ArticleRevision,
  assessment: EditorialAssessmentV3,
  publicationSources: unknown
): publicationSources is PublicationSourceV3[] {
  if (!Array.isArray(publicationSources) || publicationSources.length === 0) {
    return false;
  }
  const sourceById = new Map<string, SourceSnapshot>();
  for (const source of revision.sources) {
    if (!hasText(source.id) || sourceById.has(source.id)) return false;
    sourceById.set(source.id, source);
  }

  for (const assessed of assessment.sources) {
    if (!sourceById.has(assessed.sourceId)) return false;
  }
  const citedRoleById = new Map(
    assessment.sources
      .filter((source) => source.cited)
      .map((source) => [source.sourceId, source.role] as const)
  );
  if (citedRoleById.size !== publicationSources.length) return false;

  const publishedIds = new Set<string>();
  for (const source of publicationSources) {
    if (
      !isRecord(source) ||
      !hasText(source.id) ||
      !hasText(source.title) ||
      !hasText(source.url) ||
      !isEditorialSourceRoleV3(source.role) ||
      publishedIds.has(source.id)
    ) {
      return false;
    }
    const snapshot = sourceById.get(source.id);
    if (
      snapshot === undefined ||
      source.title !== snapshot.title ||
      source.url !== snapshot.url ||
      source.role !== citedRoleById.get(source.id)
    ) {
      return false;
    }
    publishedIds.add(source.id);
  }
  return [...citedRoleById.keys()].every((id) => publishedIds.has(id));
}

/**
 * Runtime boundary for immutable V3 packages. V2 validation remains a
 * prerequisite, while every V3-only surface is independently fail-closed.
 */
export function validateRevisionPackageV3(
  revision: ArticleRevision
): revision is RevisionPackageV3 {
  if (
    revision.packageVersion !== 3 ||
    !validateRevisionPackageV2(revision) ||
    !isRecord(revision.editorialContext) ||
    !hasText(revision.editorialContext.instruction) ||
    !SHA256_PATTERN.test(String(revision.editorialContext.instructionHash)) ||
    revision.editorialContext.instructionHash !== createHash("sha256")
      .update(revision.editorialContext.instruction.replace(/\r\n?/gu, "\n"), "utf8")
      .digest("hex") ||
    revision.editorialContext.contentOrigin !== "CODEX_ASSISTED" ||
    revision.editorialContext.aiDisclosure !== "GENERATED_WITH_AI" ||
    !validateEditorialAssessmentV3Shape(revision.editorialAssessment) ||
    !publicationSourceProjectionMatches(
      revision,
      revision.editorialAssessment,
      revision.publicationSources
    ) ||
    !isSafeGitHubWorkflowName(revision.deployWorkflow) ||
    !hasNormalizedRequiredChecks(revision.requiredChecks)
  ) {
    return false;
  }

  const editorialPolicy = revision.qualityGates.find(
    (gate) => gate.id === "editorial-policy"
  );
  if (
    editorialPolicy?.group !== REQUIRED_V3_QUALITY_GATES["editorial-policy"] ||
    editorialPolicy.policyVersion !== "3"
  ) {
    return false;
  }
  for (const [id, group] of Object.entries(REQUIRED_V3_QUALITY_GATES)) {
    const gate = revision.qualityGates.find((candidate) => candidate.id === id);
    if (!gate || gate.group !== group) return false;
  }
  return true;
}

export function hasRevisionPackageV3Fields(revision: ArticleRevision): boolean {
  return [
    revision.packageVersion,
    revision.editorialContext,
    revision.editorialAssessment,
    revision.publicationSources,
    revision.deployWorkflow,
    revision.requiredChecks
  ].some((value) => value !== undefined);
}

/**
 * Produce the only source shape allowed into public artifacts. Legacy V2
 * records have no trusted role classification, so cited sources are projected
 * conservatively as supporting.
 */
export function publicationSourcesFor(
  revision: ArticleRevision
): PublicationSourceV3[] {
  if (revision.packageVersion === 3) {
    if (!validateRevisionPackageV3(revision)) return [];
    return revision.publicationSources.map(({ id, title, url, role }) => ({
      id,
      title,
      url,
      role
    }));
  }
  if (hasRevisionPackageV3Fields(revision)) return [];

  const citedIds = new Set(
    revision.claims.flatMap((claim) => claim.sourceIds)
  );
  return revision.sources
    .filter((source) => citedIds.has(source.id))
    .map(({ id, title, url }) => ({
      id,
      title,
      url,
      role: "supporting"
    }));
}

function attestationHasTypedShape(
  value: unknown
): value is EditorialApprovalAttestationV3 {
  if (!isRecord(value)) return false;
  const editorial = value.editorialReview;
  if (editorial !== null) {
    if (
      !isRecord(editorial) ||
      typeof editorial.reviewer !== "string" ||
      !Array.isArray(editorial.sourceRoles) ||
      editorial.sourceRoles.some(
        (source) =>
          !isRecord(source) ||
          typeof source.sourceId !== "string" ||
          !isEditorialSourceRoleV3(source.role)
      )
    ) {
      return false;
    }
  }
  const expert = value.expertReview;
  if (
    expert !== null &&
    (
      !isRecord(expert) ||
      typeof expert.reviewer !== "string" ||
      typeof expert.qualifications !== "string" ||
      typeof expert.reviewScope !== "string"
    )
  ) {
    return false;
  }
  const ethics = value.ethicsReview;
  if (
    ethics !== null &&
    (
      !isRecord(ethics) ||
      typeof ethics.reviewer !== "string" ||
      typeof ethics.reviewScope !== "string" ||
      typeof ethics.rationale !== "string"
    )
  ) {
    return false;
  }
  return (
    Object.hasOwn(value, "editorialReview") &&
    Object.hasOwn(value, "expertReview") &&
    Object.hasOwn(value, "ethicsReview")
  );
}

function isApprovalV3(value: Approval | ApprovalV3): value is ApprovalV3 {
  const candidate = value as Partial<ApprovalV3>;
  return (
    candidate.packageVersion === 3 &&
    candidate.approvalType === "EDITORIAL" &&
    SHA256_PATTERN.test(String(candidate.attestationHash)) &&
    attestationHasTypedShape(candidate.attestation)
  );
}

/** Every publishable claim must carry bilingual text and anchored evidence. */
export function validateClaimEvidence(
  revision: ArticleRevision
): boolean {
  const sourceById = new Map(revision.sources.map((source) => [source.id, source]));
  return revision.claims.every((claim) => {
    if (!claim.claimKey?.trim() || !claim.trText?.trim() || !claim.enText?.trim()) {
      return false;
    }
    if (!claim.evidenceAnchors || claim.evidenceAnchors.length === 0) {
      return false;
    }
    return claim.evidenceAnchors.every((anchor) => {
      const source = sourceById.get(anchor.sourceId);
      if (!source || !/^[a-f0-9]{64}$/i.test(anchor.quoteHash)) {
        return false;
      }
      const hasImmutableExcerpt = source.evidenceExcerpt !== undefined || source.evidenceExcerptHash !== undefined;
      if (hasImmutableExcerpt && (
        !source.evidenceExcerpt ||
        source.evidenceExcerpt.length > 12_000 ||
        !source.evidenceExcerptHash ||
        !SHA256_PATTERN.test(source.evidenceExcerptHash) ||
        createHash("sha256").update(source.evidenceExcerpt, "utf8").digest("hex") !== source.evidenceExcerptHash
      )) return false;
      // Newly materialized drafts retain the source snapshot's actual anchor.
      // A model-supplied hash must never be enough to make a claim publishable.
      if (!source.evidenceAnchors?.length || !source.evidenceAnchors.some((known) =>
        known.sourceId === anchor.sourceId && known.quoteHash === anchor.quoteHash
      )) return false;
      if (anchor.start === undefined || anchor.end === undefined || !Number.isInteger(anchor.start) || anchor.start < 0) {
        return false;
      }
      if (!Number.isInteger(anchor.end) || anchor.end < anchor.start) {
        return false;
      }
      if (!hasImmutableExcerpt) return true;
      if (anchor.end > source.evidenceExcerpt!.length) return false;
      return createHash("sha256")
        .update(source.evidenceExcerpt!.slice(anchor.start, anchor.end), "utf8")
        .digest("hex") === anchor.quoteHash;
    });
  });
}

/**
 * Source reviews are immutable revision evidence: both decisions must be
 * explicitly approved, while absent legacy fields remain readable but block.
 */
export function evaluateSourcePolicy(
  revision: ArticleRevision
): SourcePolicyEligibility {
  for (const source of revision.sources) {
    if (source.trustStatus !== "APPROVED") {
      return { eligible: false, reason: "SOURCE_TRUST_NOT_APPROVED" };
    }
    if (source.rightsStatus !== "APPROVED") {
      return { eligible: false, reason: "SOURCE_RIGHTS_NOT_APPROVED" };
    }
  }
  return { eligible: true };
}

export function evaluatePublishEligibility(
  revision: ArticleRevision,
  approval: Approval | ApprovalV3 | ApprovalBundle | null,
  context: {
    now: Date;
    publishingPaused: boolean;
    /** Immutable revision records known to the engine at this decision point. */
    revisionLineage?: readonly RevisionLineageEntry[];
  }
): PublishEligibility {
  if (approval === null) {
    return { eligible: false, reason: "NO_APPROVAL" };
  }
  let approvalBundle: ApprovalBundle | null;
  let editorialApproval: Approval | ApprovalV3;
  if ("editorial" in approval) {
    approvalBundle = approval;
    editorialApproval = approval.editorial;
  } else {
    approvalBundle = null;
    editorialApproval = approval;
  }
  if (revision.state !== "REVIEW_REQUIRED" && revision.state !== "APPROVED" && revision.state !== "PR_READY" && revision.state !== "SCHEDULED") {
    return { eligible: false, reason: "REVISION_NOT_APPROVED" };
  }
  if (isRevisionSuperseded(revision, context.revisionLineage ?? [])) {
    return { eligible: false, reason: "REVISION_SUPERSEDED" };
  }
  if (editorialApproval.revisionId !== revision.id) {
    return { eligible: false, reason: "APPROVAL_REVISION_MISMATCH" };
  }
  const revisionHash = computeRevisionHash(revision);
  if (editorialApproval.revisionHash !== revisionHash) {
    return { eligible: false, reason: "APPROVAL_HASH_MISMATCH" };
  }
  if (revision.packageVersion === 3) {
    if (!validateRevisionPackageV3(revision)) {
      return { eligible: false, reason: "REVISION_PACKAGE_INCOMPLETE" };
    }
    if (!isApprovalV3(editorialApproval)) {
      return { eligible: false, reason: "EDITORIAL_ATTESTATION_REQUIRED" };
    }
    if (
      editorialApproval.attestationHash !==
      computeEditorialAttestationHash(editorialApproval.attestation)
    ) {
      return {
        eligible: false,
        reason: "EDITORIAL_ATTESTATION_HASH_MISMATCH"
      };
    }
    const editorialQuality = evaluateEditorialQualityV3(
      revision.editorialAssessment,
      editorialApproval.attestation
    );
    if (editorialQuality.blockers.length > 0) {
      return { eligible: false, reason: "EDITORIAL_QUALITY_NOT_READY" };
    }
    if (!editorialQuality.passed) {
      return { eligible: false, reason: "EDITORIAL_ATTESTATION_INVALID" };
    }
  } else {
    if (
      hasRevisionPackageV3Fields(revision) ||
      !validateRevisionPackageV2(revision)
    ) {
      return { eligible: false, reason: "REVISION_PACKAGE_INCOMPLETE" };
    }
  }
  const gateStatus = validateApprovalGates(revision, editorialApproval.warningSetHash);
  if (gateStatus !== "READY") return { eligible: false, reason: gateStatus };
  if (revision.translationParity?.status === "MISMATCHED") {
    return { eligible: false, reason: "TRANSLATION_PARITY_MISMATCH" };
  }
  if (revision.translationParity?.status === "PENDING") {
    return { eligible: false, reason: "TRANSLATION_PARITY_PENDING" };
  }
  if (revision.riskLevel === "HIGH") {
    const highRiskApproval = approvalBundle?.highRisk ?? null;
    if (highRiskApproval === null) {
      return { eligible: false, reason: "HIGH_RISK_APPROVAL_REQUIRED" };
    }
    if (highRiskApproval.revisionId !== revision.id) {
      return { eligible: false, reason: "HIGH_RISK_APPROVAL_REVISION_MISMATCH" };
    }
    if (highRiskApproval.revisionHash !== revisionHash) {
      return { eligible: false, reason: "HIGH_RISK_APPROVAL_HASH_MISMATCH" };
    }
    if (
      highRiskApproval.approvalType !== "HIGH_RISK" ||
      !/^[a-f0-9]{64}$/i.test(highRiskApproval.riskChecklistHash) ||
      !Number.isFinite(Date.parse(highRiskApproval.windowsReauthenticatedAt))
    ) {
      return { eligible: false, reason: "HIGH_RISK_APPROVAL_INVALID" };
    }
  }
  const sourcePolicy = evaluateSourcePolicy(revision);
  if (!sourcePolicy.eligible) return sourcePolicy;
  // Every claim, evidence and verification check below is an `Array.every` over
  // this list, so a revision with no claims at all would satisfy all of them
  // vacuously and publish with zero facts bound to any evidence.
  if (revision.claims.length === 0) {
    return { eligible: false, reason: "NEEDS_SOURCE" };
  }
  if (!validateClaimEvidence(revision)) {
    return { eligible: false, reason: "INVALID_CLAIM_EVIDENCE" };
  }
  if (revision.claims.some((claim) => claim.status !== "VERIFIED")) {
    return { eligible: false, reason: "NEEDS_SOURCE" };
  }
  if (context.publishingPaused) {
    return { eligible: false, reason: "PUBLISHING_PAUSED" };
  }

  const scheduledAt = Date.parse(revision.scheduledAt);
  if (!Number.isFinite(scheduledAt)) {
    throw new TypeError("scheduledAt must be a valid ISO timestamp");
  }
  const now = context.now.getTime();
  if (now < scheduledAt) {
    return { eligible: false, reason: "NOT_DUE" };
  }
  if (now > scheduledAt + 6 * 60 * 60 * 1000) {
    return { eligible: false, reason: "SCHEDULE_EXPIRED" };
  }

  return { eligible: true };
}
