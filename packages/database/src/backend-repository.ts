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
  revisionHash?: string;
  idempotencyKey: string;
  state: OutboxEffectState;
  attempts: number;
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

export class BackendStoreError extends Error {
  constructor(
    readonly code:
      | "IMMUTABLE_REVISION"
      | "REVISION_NOT_FOUND"
      | "IDEMPOTENCY_KEY_REUSED"
      | "REVISION_ALREADY_APPROVED",
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
  saveApproval(approval: Approval): Promise<Approval>;
  saveHighRiskApproval(approval: HighRiskApproval): Promise<HighRiskApproval>;
  enqueuePublication(
    revisionId: string,
    revisionHash: string
  ): Promise<OutboxEffect>;
  listOutbox(): Promise<OutboxEffect[]>;
  updateOutbox(effect: OutboxEffect): Promise<OutboxEffect>;
  createJob(job: BackendJob): Promise<BackendJob>;
  getJob(jobId: string): Promise<BackendJob>;
  saveJob(job: BackendJob): Promise<BackendJob>;
  listJobs(): Promise<BackendJob[]>;
  getLocalState(key: string): Promise<unknown | undefined>;
  setLocalState(key: string, value: unknown): Promise<void>;
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
}
