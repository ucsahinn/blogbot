import type { AutomationSettings } from "../../editorial/src/automation.ts";
import {
  canonicalJson,
  type Approval,
  type ApprovalV3,
  type ArticleRevision,
  type HighRiskApproval
} from "../../editorial/src/revision.ts";
import {
  assertValidApprovalRevocation,
  BackendStoreError,
  type ApprovalRevocation,
  type BackendChange,
  type BackendChangeKind,
  type BackendJob,
  type DashboardReadOptions,
  type DashboardSyncResult,
  type RevisionListSnapshot,
  type RevisionLineageIndexEntry,
  type RevisionEvidenceReference,
  type BackendRepository,
  type BackendRepositoryTransaction,
  type OutboxEffect,
  type PublicationIntentBinding,
  type SyncResult
} from "./backend-repository.ts";

export * from "./backend-repository.ts";

interface StoreState {
  cursor: number;
  automation: AutomationSettings;
  revisions: Map<string, ArticleRevision>;
  approvals: Map<string, Approval | ApprovalV3>;
  approvalRevocations: Map<string, ApprovalRevocation>;
  highRiskApprovals: Map<string, HighRiskApproval>;
  outbox: Map<string, OutboxEffect>;
  jobs: Map<string, BackendJob>;
  /** Compare-and-set tokens, kept beside the records the way a column would. */
  outboxVersions: Map<string, number>;
  jobVersions: Map<string, number>;
  localState: Map<string, unknown>;
  changes: BackendChange[];
  idempotentResults: Map<
    string,
    { requestFingerprint: string; result: unknown }
  >;
}

function initialState(): StoreState {
  return {
    cursor: 0,
    automation: {
      mode: "INGEST_ONLY",
      onboardingComplete: false,
      ingestionPaused: false,
      publishingPaused: true,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30
    },
    revisions: new Map(),
    approvals: new Map(),
    approvalRevocations: new Map(),
    highRiskApprovals: new Map(),
    outbox: new Map(),
    jobs: new Map(),
    outboxVersions: new Map(),
    jobVersions: new Map(),
    localState: new Map(),
    changes: [],
    idempotentResults: new Map()
  };
}

function cloneState(state: StoreState): StoreState {
  return {
    cursor: state.cursor,
    automation: structuredClone(state.automation),
    revisions: new Map(
      [...state.revisions].map(([key, value]) => [key, structuredClone(value)])
    ),
    approvals: new Map(
      [...state.approvals].map(([key, value]) => [key, structuredClone(value)])
    ),
    approvalRevocations: new Map(
      [...state.approvalRevocations].map(([key, value]) => [key, structuredClone(value)])
    ),
    highRiskApprovals: new Map(
      [...state.highRiskApprovals].map(([key, value]) => [
        key,
        structuredClone(value)
      ])
    ),
    outbox: new Map(
      [...state.outbox].map(([key, value]) => [key, structuredClone(value)])
    ),
    jobs: new Map(
      [...state.jobs].map(([key, value]) => [key, structuredClone(value)])
    ),
    outboxVersions: new Map(state.outboxVersions),
    jobVersions: new Map(state.jobVersions),
    localState: new Map(
      [...state.localState].map(([key, value]) => [key, structuredClone(value)])
    ),
    changes: structuredClone(state.changes),
    idempotentResults: new Map(
      [...state.idempotentResults].map(([key, value]) => [
        key,
        structuredClone(value)
      ])
    )
  };
}

export class InMemoryBackendStore implements BackendRepository {
  readonly persistence = "memory" as const;
  private state = initialState();

  async runIdempotent<T>(
    idempotencyKey: string,
    requestFingerprint: string,
    operation: (
      transaction: BackendRepositoryTransaction
    ) => Promise<T> | T
  ): Promise<T> {
    const existing = this.state.idempotentResults.get(idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new BackendStoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key was already used with a different request"
        );
      }
      return structuredClone(existing.result) as T;
    }

    const before = cloneState(this.state);
    try {
      const result = await operation(this);
      this.state.idempotentResults.set(idempotencyKey, {
        requestFingerprint,
        result: structuredClone(result)
      });
      return structuredClone(result);
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async sync(afterCursor: number): Promise<SyncResult> {
    return {
      serverCursor: this.state.cursor,
      snapshot: {
        automation: structuredClone(this.state.automation),
        revisions: [...this.state.revisions.values()].map((value) =>
          structuredClone(value)
        ),
        approvals: [...this.state.approvals.values()].map((value) =>
          structuredClone(value)
        ),
        highRiskApprovals: [...this.state.highRiskApprovals.values()].map(
          (value) => structuredClone(value)
        ),
        outbox: await this.listOutbox(),
        jobs: await this.listJobs()
      },
      changes: this.state.changes
        .filter((change) => change.cursor > afterCursor)
        .map((change) => structuredClone(change))
    };
  }

  async syncDashboard(afterCursor: number, options: DashboardReadOptions = {}): Promise<DashboardSyncResult> {
    const changes = this.state.changes
      .filter((change) => change.cursor > afterCursor)
      .slice(0, options.changeLimit === undefined ? undefined : options.changeLimit)
      .map((change) => structuredClone(change));
    const outbox = await this.listOutbox();
    const jobs = await this.listJobs();
    return {
      // A bounded incremental page may not advance the consumer past events
      // it has not received. The next poll resumes at the final delivered
      // cursor rather than the global head.
      serverCursor: changes.at(-1)?.cursor ?? afterCursor,
      automation: structuredClone(this.state.automation),
      outbox: outbox.slice(Math.max(0, outbox.length - (options.outboxLimit ?? Number.MAX_SAFE_INTEGER))),
      jobs: jobs.slice(Math.max(0, jobs.length - (options.jobLimit ?? Number.MAX_SAFE_INTEGER))),
      changes
    };
  }

  async listRevisionSnapshot(): Promise<RevisionListSnapshot> {
    return {
      revisions: structuredClone([...this.state.revisions.values()]),
      approvals: structuredClone([...this.state.approvals.values()]),
      highRiskApprovals: structuredClone([...this.state.highRiskApprovals.values()])
    };
  }

  async listDueRevisionIds(nowUnixMs: number, limit = 100, offset = 0): Promise<string[]> {
    return [...this.state.revisions.values()]
      .filter((revision) => Date.parse(revision.scheduledAt) <= nowUnixMs)
      .sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt) || left.id.localeCompare(right.id))
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.min(Math.max(1, limit), 200))
      .map((revision) => revision.id);
  }

  async listRevisionLineage(): Promise<RevisionLineageIndexEntry[]> {
    return [...this.state.revisions.values()].map((revision) => ({
      id: revision.id,
      ...(revision.supersedesRevisionId ? { supersedesRevisionId: revision.supersedesRevisionId } : {})
    }));
  }

  async listRevisionEvidenceReferences(): Promise<RevisionEvidenceReference[]> {
    return [...this.state.revisions.values()].map((revision) => ({
      sources: revision.sources.map(({ id, evidenceVersionId }) => ({
        id,
        ...(evidenceVersionId ? { evidenceVersionId } : {})
      }))
    }));
  }

  async getHighRiskApproval(revisionId: string): Promise<HighRiskApproval | null> {
    const approval = this.state.highRiskApprovals.get(revisionId);
    return approval ? structuredClone(approval) : null;
  }

  async getVersion(): Promise<number> {
    return this.state.cursor;
  }

  async setAutomation(settings: AutomationSettings): Promise<void> {
    this.state.automation = structuredClone(settings);
    this.recordChange("AUTOMATION_UPDATED", "automation");
  }

  async getAutomation(): Promise<AutomationSettings> {
    return structuredClone(this.state.automation);
  }

  async insertRevision(revision: ArticleRevision): Promise<ArticleRevision> {
    const existing = this.state.revisions.get(revision.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(revision)) {
        throw new BackendStoreError(
          "IMMUTABLE_REVISION",
          `Revision ${revision.id} already exists with different content`
        );
      }
      return structuredClone(existing);
    }

    const saved = structuredClone(revision);
    this.state.revisions.set(revision.id, saved);
    this.recordChange("REVISION_SUBMITTED", revision.id);
    return structuredClone(saved);
  }

  async getRevision(revisionId: string): Promise<ArticleRevision> {
    const revision = this.state.revisions.get(revisionId);
    if (!revision) {
      throw new BackendStoreError(
        "REVISION_NOT_FOUND",
        `Revision ${revisionId} was not found`
      );
    }
    return structuredClone(revision);
  }

  async getApproval(revisionId: string): Promise<Approval | ApprovalV3 | null> {
    const approval = this.state.approvals.get(revisionId);
    return approval ? structuredClone(approval) : null;
  }

  async getApprovalRevocation(revisionId: string): Promise<ApprovalRevocation | null> {
    const revocation = this.state.approvalRevocations.get(revisionId);
    return revocation ? structuredClone(revocation) : null;
  }

  async saveApproval<T extends Approval | ApprovalV3>(approval: T): Promise<T> {
    const existing = this.state.approvals.get(approval.revisionId);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(approval)) {
        return structuredClone(existing) as T;
      }
      throw new BackendStoreError(
        "REVISION_ALREADY_APPROVED",
        `Revision ${approval.revisionId} already has an immutable approval`
      );
    }
    const saved = structuredClone(approval);
    this.state.approvals.set(approval.revisionId, saved);
    this.recordChange("REVISION_APPROVED", approval.revisionId);
    return structuredClone(saved) as T;
  }

  async revokeApproval(revocation: ApprovalRevocation): Promise<ApprovalRevocation> {
    assertValidApprovalRevocation(revocation);
    const approval = this.state.approvals.get(revocation.revisionId);
    if (!approval) {
      throw new BackendStoreError(
        "APPROVAL_NOT_FOUND",
        `Revision ${revocation.revisionId} does not have an editorial approval`
      );
    }
    if (approval.revisionHash !== revocation.revisionHash) {
      throw new BackendStoreError(
        "APPROVAL_HASH_MISMATCH",
        `Revision ${revocation.revisionId} approval hash does not match the revocation`
      );
    }
    const existing = this.state.approvalRevocations.get(revocation.revisionId);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(revocation)) {
        return structuredClone(existing);
      }
      throw new BackendStoreError(
        "APPROVAL_ALREADY_REVOKED",
        `Revision ${revocation.revisionId} already has an immutable revocation`
      );
    }
    const saved = structuredClone(revocation);
    this.state.approvalRevocations.set(revocation.revisionId, saved);
    this.recordChange("APPROVAL_REVOKED", revocation.revisionId);
    return structuredClone(saved);
  }

  async saveHighRiskApproval(
    approval: HighRiskApproval
  ): Promise<HighRiskApproval> {
    const existing = this.state.highRiskApprovals.get(approval.revisionId);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(approval)) {
        return structuredClone(existing);
      }
      throw new BackendStoreError(
        "REVISION_ALREADY_APPROVED",
        `Revision ${approval.revisionId} already has an immutable high-risk approval`
      );
    }
    const saved = structuredClone(approval);
    this.state.highRiskApprovals.set(approval.revisionId, saved);
    this.recordChange("REVISION_APPROVED", `${approval.revisionId}:HIGH_RISK`);
    return structuredClone(saved);
  }

  async enqueuePublication(
    revisionId: string,
    revisionHash: string,
    binding: PublicationIntentBinding
  ): Promise<OutboxEffect> {
    const idempotencyKey = `publish:${revisionId}:${revisionHash}:${binding.previewHash}`;
    const existing = [...this.state.outbox.values()].find(
      (effect) => effect.idempotencyKey === idempotencyKey
    );
    if (existing) {
      return structuredClone(existing);
    }

    const effect: OutboxEffect = {
      id: `effect-${this.state.outbox.size + 1}`,
      type: "PUBLISH_REVISION",
      aggregateId: revisionId,
      revisionHash,
      ...structuredClone(binding),
      idempotencyKey,
      state: "PENDING",
      attempts: 0
    };
    this.state.outbox.set(effect.id, effect);
    this.state.outboxVersions.set(effect.id, 1);
    // Creation and later state transitions must be equally visible to the
    // incremental desktop sync feed; otherwise a freshly queued publication
    // can be invisible until an unrelated mutation happens.
    this.recordChange("EFFECT_UPDATED", effect.id);
    return structuredClone(effect);
  }

  async listOutbox(): Promise<OutboxEffect[]> {
    return [...this.state.outbox.values()].map((effect) =>
      structuredClone(effect)
    );
  }

  async getOutboxEffect(effectId: string): Promise<{ effect: OutboxEffect; version: number }> {
    const effect = this.state.outbox.get(effectId);
    if (!effect) throw new Error(`Outbox effect ${effectId} was not found`);
    return {
      effect: structuredClone(effect),
      version: this.state.outboxVersions.get(effectId) ?? 1
    };
  }

  async updateOutbox(effect: OutboxEffect, expectedVersion: number): Promise<OutboxEffect> {
    if (!this.state.outbox.has(effect.id)) {
      throw new Error(`Outbox effect ${effect.id} was not found`);
    }
    const current = this.state.outboxVersions.get(effect.id) ?? 1;
    if (expectedVersion !== current) {
      throw new BackendStoreError(
        "WRITE_VERSION_CONFLICT",
        `Outbox effect ${effect.id} changed from version ${expectedVersion} to ${current}`
      );
    }
    const saved = structuredClone(effect);
    this.state.outbox.set(effect.id, saved);
    this.state.outboxVersions.set(effect.id, current + 1);
    this.recordChange("EFFECT_UPDATED", effect.id);
    return structuredClone(saved);
  }

  async getOutboxVersion(effectId: string): Promise<number> {
    if (!this.state.outbox.has(effectId)) {
      throw new Error(`Outbox effect ${effectId} was not found`);
    }
    return this.state.outboxVersions.get(effectId) ?? 1;
  }

  async createJob(job: BackendJob): Promise<BackendJob> {
    if (this.state.jobs.has(job.id)) {
      throw new Error(`Job ${job.id} already exists`);
    }
    const saved = structuredClone(job);
    this.state.jobs.set(job.id, saved);
    this.state.jobVersions.set(job.id, 1);
    this.recordChange("JOB_UPDATED", job.id);
    return structuredClone(saved);
  }

  async getJob(jobId: string): Promise<BackendJob> {
    return (await this.getJobRecord(jobId)).job;
  }

  async getJobRecord(jobId: string): Promise<{ job: BackendJob; version: number }> {
    const job = this.state.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found`);
    }
    return {
      job: structuredClone(job),
      version: this.state.jobVersions.get(jobId) ?? 1
    };
  }

  async saveJob(job: BackendJob, expectedVersion: number): Promise<BackendJob> {
    if (!this.state.jobs.has(job.id)) {
      throw new Error(`Job ${job.id} was not found`);
    }
    const current = this.state.jobVersions.get(job.id) ?? 1;
    if (expectedVersion !== current) {
      throw new BackendStoreError(
        "WRITE_VERSION_CONFLICT",
        `Job ${job.id} changed from version ${expectedVersion} to ${current}`
      );
    }
    const saved = structuredClone(job);
    this.state.jobs.set(job.id, saved);
    this.state.jobVersions.set(job.id, current + 1);
    this.recordChange("JOB_UPDATED", job.id);
    return structuredClone(saved);
  }

  async getJobVersion(jobId: string): Promise<number> {
    if (!this.state.jobs.has(jobId)) {
      throw new Error(`Job ${jobId} was not found`);
    }
    return this.state.jobVersions.get(jobId) ?? 1;
  }

  async listJobs(): Promise<BackendJob[]> {
    return [...this.state.jobs.values()].map((job) => structuredClone(job));
  }

  async getLocalState(key: string): Promise<unknown | undefined> {
    return this.state.localState.has(key)
      ? structuredClone(this.state.localState.get(key))
      : undefined;
  }

  async setLocalState(key: string, value: unknown): Promise<void> {
    this.state.localState.set(key, structuredClone(value));
    this.recordChange("LOCAL_STATE_UPDATED", key);
  }

  async setMaintenanceState(key: string, value: unknown): Promise<void> {
    if (!key.startsWith("maintenance.")) {
      throw new BackendStoreError("INVALID_MAINTENANCE_KEY", "Maintenance state keys must start with maintenance.");
    }
    this.state.localState.set(key, structuredClone(value));
  }

  private recordChange(kind: BackendChangeKind, entityId: string): void {
    this.state.cursor += 1;
    this.state.changes.push({
      cursor: this.state.cursor,
      kind,
      entityId
    });
  }
}
