import type { AutomationSettings } from "../../editorial/src/automation.ts";
import type {
  Approval,
  ArticleRevision,
  HighRiskApproval
} from "../../editorial/src/revision.ts";

export type BackendChangeKind =
  | "AUTOMATION_UPDATED"
  | "REVISION_SUBMITTED"
  | "REVISION_APPROVED"
  | "JOB_UPDATED"
  | "EFFECT_UPDATED"
  | "LOCAL_STATE_UPDATED";

export interface BackendChange {
  cursor: number;
  kind: BackendChangeKind;
  entityId: string;
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
  approvals: Approval[];
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
  approvals: Approval[];
  highRiskApprovals: HighRiskApproval[];
}

export interface RevisionListReadOptions {
  limit?: number;
}

export interface RevisionLineageIndexEntry {
  id: string;
  supersedesRevisionId?: string;
}

export class BackendStoreError extends Error {
  constructor(
    readonly code:
      | "IMMUTABLE_REVISION"
      | "REVISION_NOT_FOUND"
      | "IDEMPOTENCY_KEY_REUSED"
      | "REVISION_ALREADY_APPROVED"
      | "INVALID_MAINTENANCE_KEY",
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
  getApproval(revisionId: string): Promise<Approval | null>;
  getHighRiskApproval?(revisionId: string): Promise<HighRiskApproval | null>;
  saveApproval(approval: Approval): Promise<Approval>;
  saveHighRiskApproval(approval: HighRiskApproval): Promise<HighRiskApproval>;
  enqueuePublication(
    revisionId: string,
    revisionHash: string,
    binding: PublicationIntentBinding
  ): Promise<OutboxEffect>;
  listOutbox(): Promise<OutboxEffect[]>;
  updateOutbox(effect: OutboxEffect): Promise<OutboxEffect>;
  createJob(job: BackendJob): Promise<BackendJob>;
  getJob(jobId: string): Promise<BackendJob>;
  saveJob(job: BackendJob): Promise<BackendJob>;
  listJobs(): Promise<BackendJob[]>;
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
  listDueRevisionIds?(nowUnixMs: number, limit?: number): Promise<string[]>;
  listRevisionLineage?(): Promise<RevisionLineageIndexEntry[]>;
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
