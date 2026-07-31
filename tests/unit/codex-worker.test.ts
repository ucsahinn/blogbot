import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexWorkerCoordinator,
  type CodexJobPersistencePort,
  type CodexJobQueuePort,
  type CodexJobSnapshot,
  type CodexQueueMessage,
  type CodexTaskResolverPort,
  type CodexWorkSubmission
} from "../../apps/engine/src/codex-worker.ts";
import type {
  CodexEvent,
  StructuredCodexPort,
  StructuredCodexTask
} from "../../apps/codex-runner/src/structured-runner.ts";

class MemoryCodexJobStore implements CodexJobPersistencePort {
  readonly byJobId = new Map<string, CodexJobSnapshot>();
  readonly byIdempotencyKey = new Map<string, string>();

  async reserveQueued(submission: CodexWorkSubmission) {
    const existingJobId = this.byIdempotencyKey.get(submission.idempotencyKey);
    if (existingJobId) {
      return {
        created: false,
        snapshot: this.require(existingJobId)
      };
    }

    const snapshot: CodexJobSnapshot = {
      ...submission,
      state: "QUEUED",
      version: 1
    };
    this.byJobId.set(snapshot.jobId, snapshot);
    this.byIdempotencyKey.set(snapshot.idempotencyKey, snapshot.jobId);
    return { created: true, snapshot };
  }

  async claimQueued(message: CodexQueueMessage) {
    const current = this.require(message.jobId);
    if (
      current.idempotencyKey !== message.idempotencyKey ||
      current.version !== message.generation ||
      current.state !== "QUEUED"
    ) {
      return { claimed: false, snapshot: current };
    }
    const snapshot: CodexJobSnapshot = {
      ...current,
      state: "RUNNING",
      version: current.version + 1
    };
    this.byJobId.set(snapshot.jobId, snapshot);
    return { claimed: true, snapshot };
  }

  async markWaiting(input: {
    jobId: string;
    expectedVersion: number;
    reason:
      | "AUTH_REQUIRED"
      | "RATE_LIMIT"
      | "USAGE_LIMIT"
      | "PAID_FALLBACK_DISABLED";
    role: "FAST" | "DEFAULT" | "DEEP_REVIEW";
    model: string;
  }) {
    const current = this.requireVersion(input.jobId, input.expectedVersion);
    const snapshot: CodexJobSnapshot = {
      jobId: current.jobId,
      idempotencyKey: current.idempotencyKey,
      definitionId: current.definitionId,
      payload: current.payload,
      state: "WAITING_CODEX",
      version: current.version + 1,
      reason: input.reason,
      role: input.role,
      model: input.model
    };
    this.byJobId.set(snapshot.jobId, snapshot);
    return snapshot;
  }

  async markCompleted(input: {
    jobId: string;
    expectedVersion: number;
    role: "FAST" | "DEFAULT" | "DEEP_REVIEW";
    model: string;
    output: unknown;
  }) {
    const current = this.requireVersion(input.jobId, input.expectedVersion);
    const snapshot: CodexJobSnapshot = {
      jobId: current.jobId,
      idempotencyKey: current.idempotencyKey,
      definitionId: current.definitionId,
      payload: current.payload,
      state: "COMPLETED",
      version: current.version + 1,
      role: input.role,
      model: input.model,
      output: input.output
    };
    this.byJobId.set(snapshot.jobId, snapshot);
    return snapshot;
  }

  async returnToQueued(input: {
    jobId: string;
    expectedVersion: number;
    failure: "EXECUTION_FAILED";
  }) {
    const current = this.requireVersion(input.jobId, input.expectedVersion);
    const snapshot: CodexJobSnapshot = {
      jobId: current.jobId,
      idempotencyKey: current.idempotencyKey,
      definitionId: current.definitionId,
      payload: current.payload,
      state: "QUEUED",
      version: current.version + 1,
      lastFailure: input.failure
    };
    this.byJobId.set(snapshot.jobId, snapshot);
    return snapshot;
  }

  async requeueWaiting(message: CodexQueueMessage) {
    const current = this.require(message.jobId);
    if (
      current.idempotencyKey !== message.idempotencyKey ||
      current.version !== message.generation ||
      current.state !== "WAITING_CODEX"
    ) {
      return { requeued: false, snapshot: current };
    }
    const snapshot: CodexJobSnapshot = {
      jobId: current.jobId,
      idempotencyKey: current.idempotencyKey,
      definitionId: current.definitionId,
      payload: current.payload,
      state: "QUEUED",
      version: current.version + 1
    };
    this.byJobId.set(snapshot.jobId, snapshot);
    return { requeued: true, snapshot };
  }

  private require(jobId: string): CodexJobSnapshot {
    const snapshot = this.byJobId.get(jobId);
    if (!snapshot) {
      throw new Error(`missing job: ${jobId}`);
    }
    return snapshot;
  }

  private requireVersion(
    jobId: string,
    expectedVersion: number
  ): CodexJobSnapshot {
    const snapshot = this.require(jobId);
    if (snapshot.version !== expectedVersion) {
      throw new Error("version conflict");
    }
    return snapshot;
  }
}

class MemoryCodexQueue implements CodexJobQueuePort {
  readonly messages: CodexQueueMessage[] = [];

  async enqueueOnce(message: CodexQueueMessage) {
    if (
      !this.messages.some(
        (existing) =>
          existing.idempotencyKey === message.idempotencyKey &&
          existing.generation === message.generation
      )
    ) {
      this.messages.push(message);
    }
  }
}

function taskResolver(
  task: StructuredCodexTask<{ title: string }>
): CodexTaskResolverPort {
  return {
    resolve(snapshot) {
      assert.equal(snapshot.definitionId, "write-tr-v1");
      return task;
    }
  };
}

function codexPort(events: readonly CodexEvent[], calls: string[]) {
  return {
    async *run(): AsyncIterable<CodexEvent> {
      calls.push("run");
      yield* events;
    }
  } satisfies StructuredCodexPort;
}

const submission: CodexWorkSubmission = {
  jobId: "job-1",
  idempotencyKey: "draft-42:write-tr:v1",
  definitionId: "write-tr-v1",
  payload: { evidenceIds: ["source-1"] }
};

const validTask: StructuredCodexTask<{ title: string }> = {
  taskKind: "WRITE_TR",
  input: { evidenceIds: ["source-1"] },
  outputSchema: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string" } },
    additionalProperties: false
  },
  validateOutput: (value): value is { title: string } =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { title?: unknown }).title === "string"
};

test("submitting the same idempotency key queues exactly one durable job", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const coordinator = createCodexWorkerCoordinator({
    persistence: store,
    queue,
    taskResolver: taskResolver(validTask),
    codex: codexPort([], [])
  });

  const first = await coordinator.submit(submission);
  const duplicate = await coordinator.submit({
    ...submission,
    jobId: "job-duplicate"
  });

  assert.equal(first.state, "QUEUED");
  assert.equal(duplicate.jobId, "job-1");
  assert.deepEqual(queue.messages, [
    {
      jobId: "job-1",
      idempotencyKey: "draft-42:write-tr:v1",
      generation: 1
    }
  ]);
});

test("processing a queued job persists running then schema-validated completion", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const calls: string[] = [];
  const coordinator = createCodexWorkerCoordinator({
    persistence: store,
    queue,
    taskResolver: taskResolver(validTask),
    codex: codexPort(
      [{ type: "output.completed", output: { title: "Özgün analiz" } }],
      calls
    )
  });
  await coordinator.submit(submission);

  const completed = await coordinator.process(queue.messages[0]!);
  const duplicate = await coordinator.process(queue.messages[0]!);

  assert.deepEqual(completed, {
    ...submission,
    state: "COMPLETED",
    version: 3,
    role: "DEFAULT",
    model: "gpt-5.6-terra",
    output: { title: "Özgün analiz" }
  });
  assert.deepEqual(duplicate, completed);
  assert.deepEqual(calls, ["run"]);
});

test("typed Codex limits enter WAITING_CODEX and retry requeues once", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const calls: string[] = [];
  const coordinator = createCodexWorkerCoordinator({
    persistence: store,
    queue,
    taskResolver: taskResolver(validTask),
    codex: codexPort([{ type: "usage_limit.reached" }], calls)
  });
  await coordinator.submit(submission);

  const waiting = await coordinator.process(queue.messages[0]!);
  const duplicate = await coordinator.process(queue.messages[0]!);
  const retryMessage = {
    ...queue.messages[0]!,
    generation: waiting.version
  };
  const retried = await coordinator.retryWaiting(retryMessage);
  const duplicateRetry = await coordinator.retryWaiting(retryMessage);

  assert.equal(waiting.state, "WAITING_CODEX");
  assert.equal(waiting.reason, "USAGE_LIMIT");
  assert.deepEqual(duplicate, waiting);
  assert.equal(retried.state, "QUEUED");
  assert.deepEqual(duplicateRetry, retried);
  assert.deepEqual(calls, ["run"]);
  assert.equal(queue.messages.length, 2);
});

test("paid fallback requests wait behind an explicit policy reason without invoking Codex", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const calls: string[] = [];
  const coordinator = createCodexWorkerCoordinator({
    persistence: store,
    queue,
    taskResolver: taskResolver({
      ...validTask,
      paidFallbackRequested: true
    }),
    codex: codexPort(
      [{ type: "output.completed", output: { title: "must not run" } }],
      calls
    )
  });
  await coordinator.submit(submission);

  const waiting = await coordinator.process(queue.messages[0]!);

  assert.equal(waiting.state, "WAITING_CODEX");
  assert.equal(waiting.reason, "PAID_FALLBACK_DISABLED");
  assert.deepEqual(calls, []);
});

test("unexpected runner failure returns the claim to QUEUED for the durable retry", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const coordinator = createCodexWorkerCoordinator({
    persistence: store,
    queue,
    taskResolver: taskResolver(validTask),
    codex: {
      run() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<CodexEvent>> {
                throw new Error("runner crashed");
              }
            };
          }
        };
      }
    }
  });
  await coordinator.submit(submission);

  await assert.rejects(
    coordinator.process(queue.messages[0]!),
    /runner crashed/
  );
  assert.deepEqual(store.byJobId.get("job-1"), {
    ...submission,
    state: "QUEUED",
    version: 3,
    lastFailure: "EXECUTION_FAILED"
  });
  assert.deepEqual(queue.messages.at(-1), {
    jobId: "job-1",
    idempotencyKey: "draft-42:write-tr:v1",
    generation: 3
  });
});
