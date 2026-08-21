import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexWorkerCoordinator,
  type CodexJobPersistencePort,
  type CodexJobQueuePort,
  type CodexJobSnapshot,
  type CodexQueueMessage,
  type CodexTaskResolverPort,
  type CodexWaitReason,
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
    reason: CodexWaitReason;
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
    transientFailureCount: number;
    retryAt: string;
  }) {
    const current = this.requireVersion(input.jobId, input.expectedVersion);
    const snapshot: CodexJobSnapshot = {
      jobId: current.jobId,
      idempotencyKey: current.idempotencyKey,
      definitionId: current.definitionId,
      payload: current.payload,
      state: "QUEUED",
      version: current.version + 1,
      lastFailure: input.failure,
      transientFailureCount: input.transientFailureCount,
      retryAt: input.retryAt
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

  async recoverInterrupted(jobId: string) {
    const current = this.byJobId.get(jobId);
    if (!current) return { recovered: false, snapshot: null };
    if (current.state === "COMPLETED") return { recovered: false, snapshot: current };
    if (current.state === "QUEUED") return { recovered: true, snapshot: current };
    const snapshot: CodexJobSnapshot = {
      jobId: current.jobId,
      idempotencyKey: current.idempotencyKey,
      definitionId: current.definitionId,
      payload: current.payload,
      state: "QUEUED",
      version: current.version + 1,
      ...(current.state === "RUNNING" ? { lastFailure: "EXECUTION_FAILED" as const } : {})
    };
    this.byJobId.set(jobId, snapshot);
    return { recovered: true, snapshot };
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
  readonly recovered: CodexQueueMessage[] = [];
  readonly scheduled: Array<{ message: CodexQueueMessage; startAfterSeconds?: number }> = [];

  async enqueueOnce(message: CodexQueueMessage, options?: { startAfterSeconds?: number }) {
    this.scheduled.push({
      message,
      ...(options?.startAfterSeconds === undefined ? {} : { startAfterSeconds: options.startAfterSeconds })
    });
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

  async recoverInterrupted(message: CodexQueueMessage) {
    this.recovered.push(message);
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
    model: "default",
    output: { title: "Özgün analiz" }
  });
  assert.deepEqual(duplicate, completed);
  assert.deepEqual(calls, ["run"]);
});

test("processing a claimed job tells the host when source preparation ends and Codex starts", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const lifecycle: string[] = [];
  const coordinator = createCodexWorkerCoordinator({
    persistence: store,
    queue,
    taskResolver: taskResolver(validTask),
    codex: codexPort(
      [{ type: "output.completed", output: { title: "Özgün analiz" } }],
      lifecycle
    ),
    onStarted: async ({ submission }) => {
      lifecycle.push(`started:${submission.jobId}`);
    },
    onTaskReady: async ({ submission }) => {
      lifecycle.push(`codex:${submission.jobId}`);
    }
  });
  await coordinator.submit(submission);

  await coordinator.process(queue.messages[0]!);

  assert.deepEqual(lifecycle, ["started:job-1", "codex:job-1", "run"]);
});

test("a post-output materialization failure stays durably retryable instead of leaving the job running", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const coordinator = createCodexWorkerCoordinator({
    persistence: store,
    queue,
    taskResolver: taskResolver(validTask),
    codex: codexPort([{ type: "output.completed", output: { title: "Özgün analiz" } }], []),
    onCompleted: async () => {
      throw new Error("revision materialization failed");
    }
  });
  await coordinator.submit(submission);

  const retrying = await coordinator.process(queue.messages[0]!);

  assert.equal(retrying.state, "QUEUED");
  assert.equal(retrying.lastFailure, "EXECUTION_FAILED");
  assert.equal(retrying.transientFailureCount, 1);
  assert.equal(store.byJobId.get(submission.jobId)?.state, "QUEUED");
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

test("runner timeout becomes a visible waiting state instead of an endless queued retry", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const waits: string[] = [];
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
                throw Object.assign(new Error("bounded timeout"), { code: "PROCESS_TIMEOUT" });
              }
            };
          }
        };
      }
    },
    onWaiting: async ({ reason }) => {
      waits.push(reason);
    }
  });
  await coordinator.submit(submission);

  const waiting = await coordinator.process(queue.messages[0]!);

  assert.equal(waiting.state, "WAITING_CODEX");
  assert.equal(waiting.reason, "RUNNER_TIMEOUT");
  assert.deepEqual(waits, ["RUNNER_TIMEOUT"]);
  assert.equal(queue.messages.length, 1);
});

test("invalid Codex protocol enters a manual retry state instead of looping the queue", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const waits: string[] = [];
  const coordinator = createCodexWorkerCoordinator({
    persistence: store,
    queue,
    taskResolver: taskResolver(validTask),
    codex: codexPort([{ type: "future.protocol.event" }], []),
    onWaiting: async ({ reason }) => { waits.push(reason); }
  });
  await coordinator.submit(submission);

  const waiting = await coordinator.process(queue.messages[0]!);

  assert.equal(waiting.state, "WAITING_CODEX");
  assert.equal(waiting.reason, "RUNNER_REQUIRES_RETRY");
  assert.deepEqual(waits, ["RUNNER_REQUIRES_RETRY"]);
  assert.equal(queue.messages.length, 1);
});

test("unexpected runner failure is retained and retried once after the first durable backoff", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const retries: string[] = [];
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
    },
    onRetrying: async ({ failure }) => {
      retries.push(failure);
    }
  });
  await coordinator.submit(submission);

  const retrying = await coordinator.process(queue.messages[0]!);
  assert.equal(retrying.state, "QUEUED");
  assert.equal(retrying.lastFailure, "EXECUTION_FAILED");
  assert.equal(retrying.transientFailureCount, 1);
  assert.ok(retrying.retryAt);
  assert.deepEqual(queue.messages.at(-1), {
    jobId: "job-1",
    idempotencyKey: "draft-42:write-tr:v1",
    generation: 3
  });
  assert.deepEqual(retries, ["EXECUTION_FAILED"]);
  assert.deepEqual(queue.scheduled.at(-1), {
    message: queue.messages.at(-1),
    startAfterSeconds: 5
  });
});

test("unsupported CLI and exhausted app-owned session retention stop automatic retry", async () => {
  for (const [runnerCode, diagnosticCode] of [
    ["UNSUPPORTED_CLI", "CODEX_CLI_UNSUPPORTED"],
    ["SESSION_RETENTION_FAILED", "CODEX_SESSION_RETENTION_FAILED"]
  ] as const) {
    const store = new MemoryCodexJobStore();
    const queue = new MemoryCodexQueue();
    const diagnostics: string[] = [];
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
                  throw Object.assign(new Error(runnerCode), { code: runnerCode });
                }
              };
            }
          };
        }
      },
      onWaiting: async ({ diagnosticCode: observed }) => {
        if (observed) diagnostics.push(observed);
      }
    });
    await coordinator.submit({ ...submission, jobId: `job-${runnerCode}`, idempotencyKey: `key-${runnerCode}` });
    const waiting = await coordinator.process(queue.messages[0]!);
    assert.equal(waiting.state, "WAITING_CODEX");
    assert.equal(waiting.reason, "RUNNER_REQUIRES_RETRY");
    assert.deepEqual(diagnostics, [diagnosticCode]);
    assert.equal(queue.messages.length, 1);
  }
});

test("startup recovery clears a stale active queue reservation even when the Codex record is already queued", async () => {
  const store = new MemoryCodexJobStore();
  const queue = new MemoryCodexQueue();
  const coordinator = createCodexWorkerCoordinator({
    persistence: store,
    queue,
    taskResolver: taskResolver(validTask),
    codex: codexPort([], [])
  });
  await coordinator.submit(submission);

  const recovered = await coordinator.recoverInterrupted(submission.jobId);

  assert.equal(recovered.recovered, true);
  assert.deepEqual(queue.recovered, [{
    jobId: submission.jobId,
    idempotencyKey: submission.idempotencyKey,
    generation: 1
  }]);
});
