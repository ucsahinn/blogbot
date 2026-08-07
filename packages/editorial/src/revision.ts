import { createHash } from "node:crypto";
import type { ArticleType, SiteSection } from "../../contracts/src/index.ts";

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
}

export interface MediaArtifact {
  role: "hero" | "inline";
  path: string;
  sha256: string;
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
}

export const ACCEPTABLE_EDITORIAL_WARNING_IDS = new Set([
  "SINGLE_OFFICIAL_SOURCE_EXCEPTION"
]);

export interface ArticleRevision {
  id: string;
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

export interface HighRiskApproval extends ApprovalRecord {
  approvalType: "HIGH_RISK";
  riskChecklistHash: string;
  windowsReauthenticatedAt: string;
}

export interface ApprovalBundle {
  editorial: Approval;
  highRisk: HighRiskApproval | null;
}

export type PublishBlockReason =
  | "NO_APPROVAL"
  | "REVISION_NOT_APPROVED"
  | "APPROVAL_REVISION_MISMATCH"
  | "APPROVAL_HASH_MISMATCH"
  | "NEEDS_SOURCE"
  | "PUBLISHING_PAUSED"
  | "NOT_DUE"
  | "SCHEDULE_EXPIRED"
  | "INVALID_CLAIM_EVIDENCE"
  | "REVISION_PACKAGE_INCOMPLETE"
  | "QUALITY_GATES_NOT_READY"
  | "WARNING_NOT_ALLOWLISTED"
  | "WARNING_ACCEPTANCE_MISMATCH"
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
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
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
    .map(({ id, group, state, detail, policyVersion }) => ({ id, group, state, detail, policyVersion }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(canonicalJson(warnings), "utf8").digest("hex");
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
  if (warnings.some((gate) => !ACCEPTABLE_EDITORIAL_WARNING_IDS.has(gate.id))) {
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

/** Every publishable claim must carry bilingual text and anchored evidence. */
export function validateClaimEvidence(
  revision: ArticleRevision
): boolean {
  const sourceIds = new Set(revision.sources.map((source) => source.id));
  return revision.claims.every((claim) => {
    if (!claim.claimKey?.trim() || !claim.trText?.trim() || !claim.enText?.trim()) {
      return false;
    }
    if (!claim.evidenceAnchors || claim.evidenceAnchors.length === 0) {
      return false;
    }
    return claim.evidenceAnchors.every((anchor) => {
      if (!sourceIds.has(anchor.sourceId) || !/^[a-f0-9]{64}$/i.test(anchor.quoteHash)) {
        return false;
      }
      if (anchor.start !== undefined && (!Number.isInteger(anchor.start) || anchor.start < 0)) {
        return false;
      }
      if (anchor.end !== undefined && (!Number.isInteger(anchor.end) || anchor.end < 0)) {
        return false;
      }
      return anchor.start === undefined || anchor.end === undefined || anchor.end >= anchor.start;
    });
  });
}

export function evaluatePublishEligibility(
  revision: ArticleRevision,
  approval: Approval | ApprovalBundle | null,
  context: {
    now: Date;
    publishingPaused: boolean;
  }
): PublishEligibility {
  if (approval === null) {
    return { eligible: false, reason: "NO_APPROVAL" };
  }
  let approvalBundle: ApprovalBundle | null;
  let editorialApproval: Approval;
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
  if (editorialApproval.revisionId !== revision.id) {
    return { eligible: false, reason: "APPROVAL_REVISION_MISMATCH" };
  }
  const revisionHash = computeRevisionHash(revision);
  if (editorialApproval.revisionHash !== revisionHash) {
    return { eligible: false, reason: "APPROVAL_HASH_MISMATCH" };
  }
  if (!validateRevisionPackageV2(revision)) {
    return { eligible: false, reason: "REVISION_PACKAGE_INCOMPLETE" };
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
