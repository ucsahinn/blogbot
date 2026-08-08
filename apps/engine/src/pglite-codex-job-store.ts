import type { PGlite } from "@electric-sql/pglite";
import { deterministicQueueJobId, type LocalQueueName } from "./local-queue.ts";

import {
  canonicalJson
} from "../../../packages/editorial/src/revision.ts";
import { JsonProtector } from "../../../packages/database/src/encrypted-json.ts";
import type {
  CodexJobPersistencePort,
  CodexJobQueuePort,
  CodexJobSnapshot,
  CodexQueueMessage,
  CodexWorkerCoordinator,
  CodexWaitReason,
  CodexWorkSubmission
} from "./codex-worker.ts";

interface CodexJobRow {
  id: string;
  idempotency_key: string;
  state: CodexJobSnapshot["state"];
  version: number;
  value: unknown;
}

interface CodexQueueRuntimePort {
  enqueue(
    name: "blogbot.codex",
    data: object,
    idempotencyKey: string,
    options?: { startAfterSeconds?: number }
  ): Promise<string>;
  recoverInterrupted?(name: LocalQueueName, id: string): Promise<boolean>;
}

interface CodexQueueWorkerRuntimePort extends CodexQueueRuntimePort {
  work<T extends object>(
    name: "blogbot.codex",
    handler: (job: { data: T }) => Promise<void>
  ): Promise<string>;
}

const TABLE = "blogbot_codex_jobs";

export class PGliteCodexQueueAdapter implements CodexJobQueuePort {
  constructor(private readonly queue: CodexQueueRuntimePort) {}

  async enqueueOnce(
    message: CodexQueueMessage,
    options?: { startAfterSeconds?: number }
  ): Promise<void> {
    await this.queue.enqueue(
      "blogbot.codex",
      message,
      `codex:${message.idempotencyKey}:${message.generation}`,
      options
    );
  }

  async recoverInterrupted(message: CodexQueueMessage): Promise<void> {
    await this.queue.recoverInterrupted?.(
      "blogbot.codex",
      deterministicQueueJobId(`codex:${message.idempotencyKey}:${message.generation}`)
    );
  }
}

export async function registerCodexQueueWorker(
  queue: CodexQueueWorkerRuntimePort,
  coordinator: CodexWorkerCoordinator
): Promise<string> {
  return queue.work<CodexQueueMessage>("blogbot.codex", async (job) => {
    await coordinator.process(job.data);
  });
}

export class PGliteCodexJobStore implements CodexJobPersistencePort {
  private readonly protector = JsonProtector.fromEnvironment();

  constructor(private readonly database: PGlite) {}

  async reserveQueued(
    submission: CodexWorkSubmission
  ): Promise<{ created: boolean; snapshot: CodexJobSnapshot }> {
    assertSubmission(submission);
    return this.database.transaction(async (transaction) => {
      const byKey = await transaction.query<CodexJobRow>(
        `SELECT id, idempotency_key, state, version, value
           FROM ${TABLE}
          WHERE idempotency_key = $1`,
        [submission.idempotencyKey]
      );
      const existing = byKey.rows[0];
      if (existing) {
        const snapshot = this.open(existing);
        if (!sameReservedInput(snapshot, submission)) {
          throw new Error(
            "CODEX_IDEMPOTENCY_KEY_REUSED: key belongs to different input"
          );
        }
        return { created: false, snapshot };
      }

      const byId = await transaction.query<CodexJobRow>(
        `SELECT id, idempotency_key, state, version, value
           FROM ${TABLE}
          WHERE id = $1`,
        [submission.jobId]
      );
      if (byId.rows[0]) {
        throw new Error(
          "CODEX_JOB_ID_REUSED: job id belongs to different idempotency key"
        );
      }

      const snapshot: CodexJobSnapshot = {
        ...structuredClone(submission),
        state: "QUEUED",
        version: 1
      };
      await transaction.query(
        `INSERT INTO ${TABLE} (id, idempotency_key, state, version, value)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          snapshot.jobId,
          snapshot.idempotencyKey,
          snapshot.state,
          snapshot.version,
          JSON.stringify(this.seal(snapshot))
        ]
      );
      return { created: true, snapshot };
    });
  }

  async claimQueued(
    message: CodexQueueMessage
  ): Promise<{ claimed: boolean; snapshot: CodexJobSnapshot }> {
    return this.database.transaction(async (transaction) => {
      const current = await this.require(transaction, message.jobId);
      if (
        current.idempotencyKey !== message.idempotencyKey ||
        current.version !== message.generation ||
        current.state !== "QUEUED"
      ) {
        return { claimed: false, snapshot: current };
      }
      const next: CodexJobSnapshot = {
        jobId: current.jobId,
        idempotencyKey: current.idempotencyKey,
        definitionId: current.definitionId,
        payload: current.payload,
        state: "RUNNING",
        version: current.version + 1
      };
      await this.compareAndSwap(transaction, current, next);
      return { claimed: true, snapshot: next };
    });
  }

  async markWaiting(input: {
    jobId: string;
    expectedVersion: number;
    reason: CodexWaitReason;
    role: "FAST" | "DEFAULT" | "DEEP_REVIEW";
    model: string;
  }): Promise<CodexJobSnapshot> {
    return this.transitionRunning(input.jobId, input.expectedVersion, (current) => ({
      jobId: current.jobId,
      idempotencyKey: current.idempotencyKey,
      definitionId: current.definitionId,
      payload: current.payload,
      state: "WAITING_CODEX",
      version: current.version + 1,
      reason: input.reason,
      role: input.role,
      model: input.model
    }));
  }

  async markCompleted(input: {
    jobId: string;
    expectedVersion: number;
    role: "FAST" | "DEFAULT" | "DEEP_REVIEW";
    model: string;
    output: unknown;
  }): Promise<CodexJobSnapshot> {
    assertJsonValue(input.output, "output");
    return this.transitionRunning(input.jobId, input.expectedVersion, (current) => ({
      jobId: current.jobId,
      idempotencyKey: current.idempotencyKey,
      definitionId: current.definitionId,
      payload: current.payload,
      state: "COMPLETED",
      version: current.version + 1,
      role: input.role,
      model: input.model,
      output: structuredClone(input.output)
    }));
  }

  async returnToQueued(input: {
    jobId: string;
    expectedVersion: number;
    failure: "EXECUTION_FAILED";
    transientFailureCount: number;
    retryAt: string;
  }): Promise<CodexJobSnapshot> {
    return this.transitionRunning(input.jobId, input.expectedVersion, (current) => ({
      jobId: current.jobId,
      idempotencyKey: current.idempotencyKey,
      definitionId: current.definitionId,
      payload: current.payload,
      state: "QUEUED",
      version: current.version + 1,
      lastFailure: input.failure,
      transientFailureCount: input.transientFailureCount,
      retryAt: input.retryAt
    }));
  }

  async requeueWaiting(
    message: CodexQueueMessage
  ): Promise<{ requeued: boolean; snapshot: CodexJobSnapshot }> {
    return this.database.transaction(async (transaction) => {
      const current = await this.require(transaction, message.jobId);
      if (
        current.idempotencyKey !== message.idempotencyKey ||
        current.version !== message.generation ||
        current.state !== "WAITING_CODEX"
      ) {
        return { requeued: false, snapshot: current };
      }
      const next: CodexJobSnapshot = {
        jobId: current.jobId,
        idempotencyKey: current.idempotencyKey,
        definitionId: current.definitionId,
        payload: current.payload,
        state: "QUEUED",
        version: current.version + 1
      };
      await this.compareAndSwap(transaction, current, next);
      return { requeued: true, snapshot: next };
    });
  }

  async recoverInterrupted(jobId: string): Promise<{
    recovered: boolean;
    snapshot: CodexJobSnapshot | null;
    interruptedQueueGeneration?: number;
  }> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<CodexJobRow>(
        `SELECT id, idempotency_key, state, version, value
           FROM ${TABLE}
          WHERE id = $1`,
        [jobId]
      );
      const row = result.rows[0];
      if (!row) return { recovered: false, snapshot: null };
      const current = this.open(row);
      if (current.state === "COMPLETED") return { recovered: false, snapshot: current };
      if (current.state === "QUEUED") return { recovered: true, snapshot: current };
      const next: CodexJobSnapshot = {
        jobId: current.jobId,
        idempotencyKey: current.idempotencyKey,
        definitionId: current.definitionId,
        payload: current.payload,
        state: "QUEUED",
        version: current.version + 1,
        ...(current.state === "RUNNING" ? { lastFailure: "EXECUTION_FAILED" as const } : {})
      };
      await this.compareAndSwap(transaction, current, next);
      return {
        recovered: true,
        snapshot: next,
        ...(current.state === "RUNNING" ? { interruptedQueueGeneration: current.version - 1 } : {})
      };
    });
  }

  private async transitionRunning(
    jobId: string,
    expectedVersion: number,
    createNext: (
      current: Extract<CodexJobSnapshot, { state: "RUNNING" }>
    ) => CodexJobSnapshot
  ): Promise<CodexJobSnapshot> {
    return this.database.transaction(async (transaction) => {
      const current = await this.require(transaction, jobId);
      if (current.version !== expectedVersion || current.state !== "RUNNING") {
        throw new Error(
          `CODEX_JOB_VERSION_CONFLICT: expected RUNNING version ${expectedVersion}`
        );
      }
      const next = createNext(current);
      await this.compareAndSwap(transaction, current, next);
      return next;
    });
  }

  private async compareAndSwap(
    transaction: Pick<PGlite, "query">,
    current: CodexJobSnapshot,
    next: CodexJobSnapshot
  ): Promise<void> {
    const updated = await transaction.query<{ id: string }>(
      `UPDATE ${TABLE}
          SET state = $4,
              version = $5,
              value = $6::jsonb
        WHERE id = $1
          AND idempotency_key = $2
          AND state = $3
          AND version = $7
      RETURNING id`,
      [
        current.jobId,
        current.idempotencyKey,
        current.state,
        next.state,
        next.version,
        JSON.stringify(this.seal(next)),
        current.version
      ]
    );
    if (!updated.rows[0]) {
      throw new Error("CODEX_JOB_VERSION_CONFLICT: concurrent state change");
    }
  }

  private async require(
    transaction: Pick<PGlite, "query">,
    jobId: string
  ): Promise<CodexJobSnapshot> {
    const result = await transaction.query<CodexJobRow>(
      `SELECT id, idempotency_key, state, version, value
         FROM ${TABLE}
        WHERE id = $1`,
      [jobId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`CODEX_JOB_NOT_FOUND: ${jobId}`);
    }
    return this.open(row);
  }

  private seal(snapshot: CodexJobSnapshot): unknown {
    return this.protector.seal(snapshot, {
      table: TABLE,
      key: snapshot.jobId,
      field: "value"
    });
  }

  private open(row: CodexJobRow): CodexJobSnapshot {
    const snapshot = this.protector.open<CodexJobSnapshot>(row.value, {
      table: TABLE,
      key: row.id,
      field: "value"
    });
    if (
      snapshot.jobId !== row.id ||
      snapshot.idempotencyKey !== row.idempotency_key ||
      snapshot.state !== row.state ||
      snapshot.version !== row.version
    ) {
      throw new Error("CODEX_JOB_ROW_INTEGRITY_FAILED");
    }
    return snapshot;
  }
}

function sameReservedInput(
  snapshot: CodexJobSnapshot,
  submission: CodexWorkSubmission
): boolean {
  return canonicalJson({
    idempotencyKey: snapshot.idempotencyKey,
    definitionId: snapshot.definitionId,
    payload: snapshot.payload
  }) === canonicalJson({
    idempotencyKey: submission.idempotencyKey,
    definitionId: submission.definitionId,
    payload: submission.payload
  });
}

function assertSubmission(submission: CodexWorkSubmission): void {
  for (const [name, value] of [
    ["jobId", submission.jobId],
    ["idempotencyKey", submission.idempotencyKey],
    ["definitionId", submission.definitionId]
  ] as const) {
    if (!value.trim() || value.length > 512) {
      throw new Error(`CODEX_JOB_INPUT_INVALID: ${name}`);
    }
  }
  assertJsonValue(submission.payload, "payload");
}

function assertJsonValue(value: unknown, field: string): void {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 1_048_576) {
      throw new Error();
    }
    JSON.parse(encoded);
  } catch {
    throw new Error(`CODEX_JOB_INPUT_INVALID: ${field} must be bounded JSON`);
  }
}
