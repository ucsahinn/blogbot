import type { AutomationSettings } from "../../editorial/src/automation.ts";
import {
  canonicalJson,
  type Approval,
  type ArticleRevision,
  type HighRiskApproval
} from "../../editorial/src/revision.ts";
import {
  BackendStoreError,
  type BackendChange,
  type BackendChangeKind,
  type BackendJob,
  type BackendRepository,
  type BackendRepositoryTransaction,
  type OutboxEffect,
  type SyncResult
} from "./backend-repository.ts";

export * from "./backend-repository.ts";

interface StoreState {
  cursor: number;
  automation: AutomationSettings;
  revisions: Map<string, ArticleRevision>;
  approvals: Map<string, Approval>;
  highRiskApprovals: Map<string, HighRiskApproval>;
  outbox: Map<string, OutboxEffect>;
  jobs: Map<string, BackendJob>;
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
    highRiskApprovals: new Map(),
    outbox: new Map(),
    jobs: new Map(),
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

  async getApproval(revisionId: string): Promise<Approval | null> {
    const approval = this.state.approvals.get(revisionId);
    return approval ? structuredClone(approval) : null;
  }

  async saveApproval(approval: Approval): Promise<Approval> {
    const existing = this.state.approvals.get(approval.revisionId);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(approval)) {
        return structuredClone(existing);
      }
      throw new BackendStoreError(
        "REVISION_ALREADY_APPROVED",
        `Revision ${approval.revisionId} already has an immutable approval`
      );
    }
    const saved = structuredClone(approval);
    this.state.approvals.set(approval.revisionId, saved);
    this.recordChange("REVISION_APPROVED", approval.revisionId);
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
    revisionHash: string
  ): Promise<OutboxEffect> {
    const idempotencyKey = `publish:${revisionId}:${revisionHash}`;
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
      idempotencyKey,
      state: "PENDING",
      attempts: 0
    };
    this.state.outbox.set(effect.id, effect);
    return structuredClone(effect);
  }

  async listOutbox(): Promise<OutboxEffect[]> {
    return [...this.state.outbox.values()].map((effect) =>
      structuredClone(effect)
    );
  }

  async updateOutbox(effect: OutboxEffect): Promise<OutboxEffect> {
    if (!this.state.outbox.has(effect.id)) {
      throw new Error(`Outbox effect ${effect.id} was not found`);
    }
    const saved = structuredClone(effect);
    this.state.outbox.set(effect.id, saved);
    this.recordChange("EFFECT_UPDATED", effect.id);
    return structuredClone(saved);
  }

  async createJob(job: BackendJob): Promise<BackendJob> {
    if (this.state.jobs.has(job.id)) {
      throw new Error(`Job ${job.id} already exists`);
    }
    const saved = structuredClone(job);
    this.state.jobs.set(job.id, saved);
    this.recordChange("JOB_UPDATED", job.id);
    return structuredClone(saved);
  }

  async getJob(jobId: string): Promise<BackendJob> {
    const job = this.state.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found`);
    }
    return structuredClone(job);
  }

  async saveJob(job: BackendJob): Promise<BackendJob> {
    if (!this.state.jobs.has(job.id)) {
      throw new Error(`Job ${job.id} was not found`);
    }
    const saved = structuredClone(job);
    this.state.jobs.set(job.id, saved);
    this.recordChange("JOB_UPDATED", job.id);
    return structuredClone(saved);
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

  private recordChange(kind: BackendChangeKind, entityId: string): void {
    this.state.cursor += 1;
    this.state.changes.push({
      cursor: this.state.cursor,
      kind,
      entityId
    });
  }
}
