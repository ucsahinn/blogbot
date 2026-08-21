import type { AutomationSettings } from "../../editorial/src/automation.ts";
import type {
  Approval,
  ApprovalV3,
  ArticleRevision,
  HighRiskApproval
} from "../../editorial/src/revision.ts";

export type BackendChangeKind =
  | "AUTOMATION_UPDATED"
  | "REVISION_SUBMITTED"
  | "REVISION_APPROVED"
  | "APPROVAL_REVOKED"
  | "JOB_UPDATED"
  | "EFFECT_UPDATED"
  | "LOCAL_STATE_UPDATED";

export interface BackendChange {
  cursor: number;
  kind: BackendChangeKind;
  entityId: string;
}

/** Immutable audit record proving which exact editorial approval was revoked. */
export interface ApprovalRevocation {
  revisionId: string;
  revisionHash: string;
  deviceId: string;
  reason: string;
  revokedAt: string;
}

export function assertValidApprovalRevocation(
  value: ApprovalRevocation
): asserts value is ApprovalRevocation {
  const exactIsoDate =
    Number.isFinite(Date.parse(value.revokedAt)) &&
    new Date(Date.parse(value.revokedAt)).toISOString() === value.revokedAt;
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.revisionId) ||
    !/^[a-f0-9]{64}$/u.test(value.revisionHash) ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.deviceId) ||
    value.reason.length === 0 ||
    value.reason.length > 512 ||
    value.reason !== value.reason.trim() ||
    !exactIsoDate
  ) {
    throw new BackendStoreError(
      "INVALID_APPROVAL_REVOCATION",
      "Approval revocation audit data is invalid"
    );
  }
}

export type OutboxEffectState =
  | "PENDING"
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN";

export interface OutboxEffect {
  id: string;
  type: "PUBLISH_REVISION";
  aggregateId: string;
  /** Exact revision hash captured when the publication intent was enqueued. */
  revisionHash: string;
  /** The reviewed preview that produced this exact publication intent. */
  previewHash: string;
  /** Immutable publication target captured from the approved revision. */
  targetRepository: string;
  baseBranch: string;
  targetBaseSha: string;
  /** Exact adapter identity, for example `astro-generic@2.0.0`. */
  adapterVersion: string;
  idempotencyKey: string;
  state: OutboxEffectState;
  attempts: number;
  /** Monotonic fencing token for a specific native publication claim. */
  claimAttempt?: number;
  /** Durable identity of the engine runtime that owns the current native claim. */
  nativeClaimOwnerId?: string;
  /** Lease deadline after which another runtime may fence and reclaim the effect. */
  nativeClaimLeaseUntil?: string;
  /** Durable retry deadline for a recoverable external publication effect. */
  nextAttemptAt?: string;
  resultRef?: string;
  lastError?: string;
  /** Set only after the external publisher reports a verified effect. */
  completedAt?: string;
}

export type JobKind = "INGEST" | "DRAFT" | "CODEX" | "PUBLISH";

export type JobState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_CODEX"
  | "RETRY_SCHEDULED"
  | "SUCCEEDED"
  | "FAILED"
  | "DEAD_LETTER";

export interface BackendJob {
  id: string;
  kind: JobKind;
  state: JobState;
  attempts: number;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

export interface BackendSnapshot {
  automation: AutomationSettings;
  revisions: ArticleRevision[];
  approvals: Array<Approval | ApprovalV3>;
  highRiskApprovals: HighRiskApproval[];
  outbox: OutboxEffect[];
  jobs: BackendJob[];
}

export interface SyncResult {
  serverCursor: number;
  snapshot: BackendSnapshot;
  changes: BackendChange[];
}

/**
 * Small projection consumed by the desktop shell on every refresh. It must
 * never require opening immutable article bodies or approval packages.
 */
export interface DashboardSyncResult {
  serverCursor: number;
  automation: AutomationSettings;
  outbox: OutboxEffect[];
  jobs: BackendJob[];
  changes: BackendChange[];
}

export interface DashboardReadOptions {
  changeLimit?: number;
  /** Latest operational entries only; historical detail is fetched on demand. */
  outboxLimit?: number;
  /** Latest operational entries only; historical detail is fetched on demand. */
  jobLimit?: number;
}

/** Bounded editorial-list read; excludes jobs, outbox, and audit history. */
export interface RevisionListSnapshot {
  revisions: ArticleRevision[];
  approvals: Array<Approval | ApprovalV3>;
  highRiskApprovals: HighRiskApproval[];
}

export interface RevisionListReadOptions {
  limit?: number;
}

export interface RevisionLineageIndexEntry {
  id: string;
  supersedesRevisionId?: string;
}

/** Lightweight immutable evidence references used by retention maintenance. */
export interface RevisionEvidenceReference {
  sources: Array<Pick<ArticleRevision["sources"][number], "id" | "evidenceVersionId">>;
}

export class BackendStoreError extends Error {
  constructor(
    readonly code:
      | "IMMUTABLE_REVISION"
      | "REVISION_NOT_FOUND"
      | "IDEMPOTENCY_KEY_REUSED"
      | "REVISION_ALREADY_APPROVED"
      | "APPROVAL_NOT_FOUND"
      | "APPROVAL_HASH_MISMATCH"
      | "APPROVAL_ALREADY_REVOKED"
      | "INVALID_APPROVAL_REVOCATION"
      | "INVALID_MAINTENANCE_KEY"
      | "WRITE_VERSION_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "BackendStoreError";
  }
}

export interface BackendRepositoryTransaction {
  getVersion(): Promise<number>;
  setAutomation(settings: AutomationSettings): Promise<void>;
  getAutomation(): Promise<AutomationSettings>;
  insertRevision(revision: ArticleRevision): Promise<ArticleRevision>;
  getRevision(revisionId: string): Promise<ArticleRevision>;
  getApproval(revisionId: string): Promise<Approval | ApprovalV3 | null>;
  getApprovalRevocation(revisionId: string): Promise<ApprovalRevocation | null>;
  getHighRiskApproval?(revisionId: string): Promise<HighRiskApproval | null>;
  saveApproval<T extends Approval | ApprovalV3>(approval: T): Promise<T>;
  revokeApproval(revocation: ApprovalRevocation): Promise<ApprovalRevocation>;
  saveHighRiskApproval(approval: HighRiskApproval): Promise<HighRiskApproval>;
  enqueuePublication(
    revisionId: string,
    revisionHash: string,
    binding: PublicationIntentBinding
  ): Promise<OutboxEffect>;
  listOutbox(): Promise<OutboxEffect[]>;
  /** Atomically reads an outbox value and its compare-and-set token. */
  getOutboxEffect(effectId: string): Promise<{ effect: OutboxEffect; version: number }>;
  /**
   * A durable job or outbox row is a whole-record overwrite, so two lanes that
   * each read the same row and write it back silently lose one of the two
   * writes. `expectedVersion` turns the write into a compare-and-set against
   * the token the reader observed; a mismatch raises
   * `WRITE_VERSION_CONFLICT` instead of overwriting the other lane.
   */
  updateOutbox(effect: OutboxEffect, expectedVersion: number): Promise<OutboxEffect>;
  createJob(job: BackendJob): Promise<BackendJob>;
  getJob(jobId: string): Promise<BackendJob>;
  /** Atomically reads a durable job and the CAS token for that exact value. */
  getJobRecord(jobId: string): Promise<{ job: BackendJob; version: number }>;
  saveJob(job: BackendJob, expectedVersion: number): Promise<BackendJob>;
  listJobs(): Promise<BackendJob[]>;
  /**
   * Reads the compare-and-set token of a durable row without decrypting it.
   * Optional while compatibility stores adopt the mechanism.
   */
  getJobVersion?(jobId: string): Promise<number>;
  getOutboxVersion?(effectId: string): Promise<number>;
  getLocalState(key: string): Promise<unknown | undefined>;
  setLocalState(key: string, value: unknown): Promise<void>;
  /**
   * Internal operational health ledger. It is intentionally outside the
   * editorial cursor so a background probe cannot invalidate a user edit.
   */
  setMaintenanceState(key: string, value: unknown): Promise<void>;
}

export interface BackendRepository extends BackendRepositoryTransaction {
  readonly persistence: "memory" | "pglite" | "postgresql";
  runIdempotent<T>(
    idempotencyKey: string,
    requestFingerprint: string,
    operation: (
      transaction: BackendRepositoryTransaction
    ) => Promise<T> | T
  ): Promise<T>;
  sync(afterCursor: number): Promise<SyncResult>;
  /** Optional while compatibility stores migrate to the lightweight read. */
  syncDashboard?(afterCursor: number, options?: DashboardReadOptions): Promise<DashboardSyncResult>;
  /** Optional while compatibility stores migrate away from full snapshots. */
  listRevisionSnapshot?(): Promise<RevisionListSnapshot>;
  listRevisionSummarySnapshot?(options?: RevisionListReadOptions): Promise<RevisionListSnapshot>;
  listDueRevisionIds?(nowUnixMs: number, limit?: number, offset?: number): Promise<string[]>;
  listRevisionLineage?(): Promise<RevisionLineageIndexEntry[]>;
  listRevisionEvidenceReferences?(): Promise<RevisionEvidenceReference[]>;
}

/**
 * Every durable publication effect must keep the complete user-reviewed
 * destination tuple. A revision hash alone cannot prove that a recovered
 * outbox row still represents the preview the operator approved.
 */
export interface PublicationIntentBinding {
  previewHash: string;
  targetRepository: string;
  baseBranch: string;
  targetBaseSha: string;
  adapterVersion: string;
}
