import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import { CODEX_RUNNER_TIMEOUT_MS, codexRecoveryJobId, createEngineProtocol, collectDraftSourceEvidence, recoverWaitingDraftJobs, resolveCandidateSourceUrl, syncCodexParentJobState } from "../../apps/engine/src/stdio-entrypoint.ts";
import type { CodexWorkerCoordinator } from "../../apps/engine/src/codex-worker.ts";
import type { SourceRepository } from "../../packages/database/src/source-repository.ts";

const envelope = (command: Record<string, unknown>) => ({
  version: 1,
  id: String(command.requestId),
  kind: "command",
  command
});

test("revision summary list never falls back to a full engine snapshot", async () => {
  class SummaryOnlyRepository extends InMemoryBackendStore {
    summaryReads = 0;
    override async sync(): Promise<never> {
      throw new Error("FULL_SYNC_MUST_NOT_RUN_FOR_REVISION_SUMMARY");
    }
    override async listRevisionSnapshot() {
      this.summaryReads += 1;
      return { revisions: [], approvals: [], highRiskApprovals: [] };
    }
  }
  const repository = new SummaryOnlyRepository();
  const handle = createEngineProtocol(repository);
  const response = await handle(envelope({
    version: 1, requestId: "revision-summary-only", idempotencyKey: "revision-summary-only",
    expectedVersion: 0, kind: "REVISION.LIST", payload: { summaryOnly: true }
  }));

  assert.equal(response.ok, true);
  assert.equal(repository.summaryReads, 1);
});

test("draft.create persists a WAITING_CODEX local job when no runner is configured", async () => {
  const repository = new InMemoryBackendStore();
  const handle = createEngineProtocol(repository);
  const response = await handle(envelope({
    version: 1,
    requestId: "draft-1",
    idempotencyKey: "draft-1",
    expectedVersion: 0,
    kind: "DRAFT.CREATE",
    payload: {
      draftId: "draft-1",
      candidateId: "candidate-1",
      candidateTitle: "Tedarik zinciri açığını araştır",
      sourceIds: ["source-1"]
    }
  }));
  assert.equal(response.ok, true);
  const state = await repository.sync(0);
  const job = state.snapshot.jobs[0];
  assert.deepEqual(job && { ...job, metadata: (() => {
    const { createdAtUnixMs: _createdAtUnixMs, ...stable } = job.metadata ?? {};
    return stable;
  })() }, {
    id: "draft-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 0,
    lastError: "CODEX_RUNNER_UNAVAILABLE",
    metadata: {
      progressStage: "WAITING_CODEX",
      candidateId: "candidate-1",
      candidateTitle: "Tedarik zinciri açığını araştır",
      instruction: "",
      sourceIds: ["source-1"],
      urls: [],
      section: "haberler",
      articleType: "news",
      urgency: "normal",
      tone: "neutral",
      length: "standard",
      visualPolicy: "GENERATE",
      scheduleIntent: "UNSCHEDULED"
    }
  });
  assert.equal(typeof job?.metadata?.createdAtUnixMs, "number");
});

test("draft.create preserves URL evidence for instant creation", async () => {
  const repository = new InMemoryBackendStore();
  const handle = createEngineProtocol(repository);
  const response = await handle(envelope({
    version: 1,
    requestId: "draft-url-1",
    idempotencyKey: "draft-url-1",
    expectedVersion: 0,
    kind: "DRAFT.CREATE",
    payload: {
      draftId: "draft-url-1",
      instruction: "Bu kaynaktan doğrulanmış haber hazırla",
      urls: ["https://example.com/report"],
      sourceIds: [],
      section: "haberler",
      articleType: "news"
    }
  }));
  assert.equal(response.ok, true);
  assert.deepEqual((await repository.getJob("draft-url-1")).metadata?.urls, ["https://example.com/report"]);
});

test("interactive Codex work has a bounded visible timeout", () => {
  assert.equal(CODEX_RUNNER_TIMEOUT_MS, 5 * 60 * 1_000);
});

test("a durable draft waiting for Codex is re-dispatched when the local runner becomes available", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-recover-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 0,
    lastError: "CODEX_RUNNER_UNAVAILABLE",
    metadata: {
      instruction: "Kaynakları karşılaştırarak özgün haber hazırla",
      sourceIds: ["source-1"],
      urls: [],
      section: "haberler",
      articleType: "news",
      urgency: "normal",
      tone: "neutral",
      length: "standard",
      visualPolicy: "NONE",
      scheduleIntent: "UNSCHEDULED"
    }
  });
  const submitted: unknown[] = [];
  const coordinator: CodexWorkerCoordinator = {
    async submit(input) {
      submitted.push(input);
      return { ...input, state: "QUEUED", version: 1 };
    },
    async recoverInterrupted() { return { recovered: false, snapshot: null }; },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  };

  const recovered = await recoverWaitingDraftJobs(repository, coordinator);

  assert.equal(recovered, 1);
  assert.deepEqual(submitted, [{
    jobId: "draft-recover-1",
    idempotencyKey: "recovered:draft-recover-1",
    definitionId: "DRAFT.CREATE",
    payload: {
      draftId: "draft-recover-1",
      instruction: "Kaynakları karşılaştırarak özgün haber hazırla",
      sourceIds: ["source-1"],
      urls: [],
      section: "haberler",
      articleType: "news",
      urgency: "normal",
      tone: "neutral",
      length: "standard",
      visualPolicy: "NONE",
      scheduleIntent: "UNSCHEDULED",
      sources: []
    }
  }]);
  const job = await repository.getJob("draft-recover-1");
  assert.equal(job.state, "QUEUED");
  assert.equal(job.lastError, undefined);
});

test("Boby guidance queues only a bounded local guidance request", async () => {
  const repository = new InMemoryBackendStore();
  const submitted: unknown[] = [];
  const startedImmediately: unknown[] = [];
  const coordinator: CodexWorkerCoordinator = {
    async submit(input) {
      submitted.push(input);
      return { ...input, state: "QUEUED", version: 1 };
    },
    startImmediately(input) { startedImmediately.push(input); },
    async recoverInterrupted() { return { recovered: false, snapshot: null }; },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  };
  const handle = createEngineProtocol(repository, "memory", { codexCoordinator: coordinator });

  const response = await handle(envelope({
    version: 1,
    requestId: "boby-guidance-1",
    idempotencyKey: "boby-guidance-1", // gitleaks:allow -- deterministic test identifier, not a credential
    expectedVersion: 0,
    kind: "BOBY.GUIDE",
    payload: {
      guidanceId: "boby-guidance-1",
      question: "Taslağı nerede incelerim?",
      activePage: "content",
      runtimeState: "ONLINE",
      sessionId: "boby-luna-thread-1",
      safeWorkspaceSummary: { draftCount: 2, reviewCount: 1, sourceCount: 3 }
    }
  }));

  assert.equal(response.ok, true);
  assert.deepEqual(submitted, [{
    jobId: "boby-guidance-1",
    idempotencyKey: "boby:boby-guidance-1",
    definitionId: "BOBY.GUIDE",
    payload: {
      question: "Taslağı nerede incelerim?",
      activePage: "content",
      runtimeState: "ONLINE",
      sessionId: "boby-luna-thread-1",
      safeWorkspaceSummary: { draftCount: 2, reviewCount: 1, sourceCount: 3 }
    }
  }]);
  assert.deepEqual(startedImmediately, [{
    jobId: "boby-guidance-1",
    idempotencyKey: "boby:boby-guidance-1",
    generation: 1
  }]);
  const job = await repository.getJob("boby-guidance-1");
  assert.equal(job.kind, "CODEX");
  assert.equal(job.state, "QUEUED");
  assert.equal(job.metadata?.purpose, "BOBY_GUIDANCE");
  assert.equal(job.metadata?.bobySessionId, "boby-luna-thread-1");
  assert.equal(job.metadata?.question, "Taslağı nerede incelerim?");
  assert.equal("ignoredSecret" in (job.metadata ?? {}), false);
});

test("restart recovery resumes the final-review subjob and clears the parent draft from RUNNING", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-final-review-recover-1",
    kind: "DRAFT",
    state: "RUNNING",
    attempts: 0,
    metadata: {
      progressStage: "FINAL_REVIEW",
      finalReviewJobId: "draft-final-review-recover-1:final-review"
    }
  });
  const recoveredJobIds: string[] = [];
  const coordinator: CodexWorkerCoordinator = {
    async submit() { throw new Error("not used"); },
    async recoverInterrupted(jobId) {
      recoveredJobIds.push(jobId);
      return { recovered: true, snapshot: null };
    },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  };

  const recovered = await recoverWaitingDraftJobs(repository, coordinator);

  assert.equal(recovered, 1);
  assert.deepEqual(recoveredJobIds, ["draft-final-review-recover-1:final-review"]);
  const job = await repository.getJob("draft-final-review-recover-1");
  assert.equal(job.state, "QUEUED");
  assert.equal(job.metadata?.progressStage, "FINAL_REVIEW_RETRYING");
});

test("restart recovery leaves an unrecoverable final review visibly waiting instead of RUNNING", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-final-review-missing-1",
    kind: "DRAFT",
    state: "RUNNING",
    attempts: 0,
    metadata: {
      progressStage: "FINAL_REVIEW",
      finalReviewJobId: "draft-final-review-missing-1:final-review"
    }
  });
  const coordinator: CodexWorkerCoordinator = {
    async submit() { throw new Error("not used"); },
    async recoverInterrupted() { return { recovered: false, snapshot: null }; },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  };

  await recoverWaitingDraftJobs(repository, coordinator);

  const job = await repository.getJob("draft-final-review-missing-1");
  assert.equal(job.state, "WAITING_CODEX");
  assert.equal(job.lastError, "FINAL_REVIEW_RECOVERY_REQUIRED");
  assert.equal(job.metadata?.progressStage, "FINAL_REVIEW_RECOVERY_REQUIRED");
});

test("a waiting final-review subjob makes its original draft visibly waiting", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-final-review-waiting-1",
    kind: "DRAFT",
    state: "RUNNING",
    attempts: 0,
    metadata: { progressStage: "FINAL_REVIEW" }
  });

  await syncCodexParentJobState(repository, {
    jobId: "draft-final-review-waiting-1:final-review",
    idempotencyKey: "final-review:draft-final-review-waiting-1",
    definitionId: "REVISION.FINAL_REVIEW",
    payload: { originalJobId: "draft-final-review-waiting-1" }
  }, { kind: "WAITING", reason: "RUNNER_REQUIRES_RETRY" });

  const job = await repository.getJob("draft-final-review-waiting-1");
  assert.equal(job.state, "WAITING_CODEX");
  assert.equal(job.metadata?.progressStage, "FINAL_REVIEW_WAITING_CODEX");
  assert.equal(job.metadata?.finalReviewJobId, "draft-final-review-waiting-1:final-review");
  assert.equal(job.metadata?.finalReviewWaitReason, "RUNNER_REQUIRES_RETRY");
});

test("a retrying final-review subjob schedules retry on its original draft", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-final-review-retrying-1",
    kind: "DRAFT",
    state: "RUNNING",
    attempts: 0,
    metadata: { progressStage: "FINAL_REVIEW" }
  });

  await syncCodexParentJobState(repository, {
    jobId: "draft-final-review-retrying-1:final-review",
    idempotencyKey: "final-review:draft-final-review-retrying-1",
    definitionId: "REVISION.FINAL_REVIEW",
    payload: { originalJobId: "draft-final-review-retrying-1" }
  }, { kind: "RETRYING", failure: "EXECUTION_FAILED", transientFailureCount: 2, retryAt: "2026-08-10T10:00:00.000Z" });

  const job = await repository.getJob("draft-final-review-retrying-1");
  assert.equal(job.state, "RETRY_SCHEDULED");
  assert.equal(job.metadata?.progressStage, "FINAL_REVIEW_RETRYING");
  assert.equal(job.metadata?.finalReviewJobId, "draft-final-review-retrying-1:final-review");
  assert.equal(job.metadata?.finalReviewRetryAttempt, 2);
});

test("manual retry targets a final-review subjob instead of its completed draft subjob", () => {
  assert.equal(codexRecoveryJobId({
    id: "draft-final-review-retry-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 0,
    metadata: {
      progressStage: "FINAL_REVIEW_WAITING_CODEX",
      finalReviewJobId: "draft-final-review-retry-1:final-review"
    }
  }), "draft-final-review-retry-1:final-review");
});

test("job.retry sends a waiting final review to its durable subjob", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-final-review-command-retry-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 0,
    metadata: {
      progressStage: "FINAL_REVIEW_WAITING_CODEX",
      finalReviewJobId: "draft-final-review-command-retry-1:final-review"
    }
  });
  const recoveredJobIds: string[] = [];
  const codexCoordinator: CodexWorkerCoordinator = {
    async submit() { throw new Error("not used"); },
    async recoverInterrupted(jobId) {
      recoveredJobIds.push(jobId);
      return { recovered: true, snapshot: null };
    },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  };
  const handle = createEngineProtocol(repository, "memory", { codexCoordinator });

  const response = await handle(envelope({
    version: 1,
    requestId: "final-review-retry-1",
    idempotencyKey: "final-review-retry-1",
    expectedVersion: 1,
    kind: "JOB.RETRY",
    payload: { jobId: "draft-final-review-command-retry-1" }
  }));

  assert.equal(response.ok, true);
  assert.deepEqual(recoveredJobIds, ["draft-final-review-command-retry-1:final-review"]);
});

test("a timed-out Codex draft remains waiting after restart until the editor explicitly retries it", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-timeout-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 1,
    lastError: "CODEX_RUNNER_TIMEOUT",
    metadata: {
      codexWaitReason: "RUNNER_TIMEOUT",
      instruction: "Zaman aşımına uğrayan taslağı tekrar çalıştır",
      sourceIds: ["source-1"],
      urls: []
    }
  });
  const submitted: unknown[] = [];
  const recoveredIds: string[] = [];
  const coordinator = {
    async submit(input: unknown) {
      submitted.push(input);
      return { state: "QUEUED", version: 1 };
    },
    async recoverInterrupted(jobId: string) {
      recoveredIds.push(jobId);
      return { recovered: false, snapshot: null };
    },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  } as unknown as CodexWorkerCoordinator;

  const recovered = await recoverWaitingDraftJobs(repository, coordinator);

  assert.equal(recovered, 0);
  assert.deepEqual(recoveredIds, []);
  assert.deepEqual(submitted, []);
  const job = await repository.getJob("draft-timeout-1");
  assert.equal(job.state, "WAITING_CODEX");
  assert.equal(job.metadata?.codexWaitReason, "RUNNER_TIMEOUT");
});

test("a draft interrupted while Codex was running is re-queued on the next local engine start", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-interrupted-1",
    kind: "DRAFT",
    state: "RUNNING",
    attempts: 1,
    metadata: {
      instruction: "Yerel engine kapandığında yarım kalan taslağı sürdür",
      sourceIds: ["source-1"],
      urls: []
    }
  });
  const recoveredIds: string[] = [];
  const submitted: unknown[] = [];
  const coordinator = {
    async submit(input: unknown) {
      submitted.push(input);
      return { state: "QUEUED", version: 1 };
    },
    async recoverInterrupted(jobId: string) {
      recoveredIds.push(jobId);
      return { recovered: true, snapshot: { state: "QUEUED", version: 3 } };
    },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  } as unknown as CodexWorkerCoordinator;

  const recovered = await recoverWaitingDraftJobs(repository, coordinator);

  assert.equal(recovered, 1);
  assert.deepEqual(recoveredIds, ["draft-interrupted-1"]);
  assert.deepEqual(submitted, []);
  const recoveredJob = await repository.getJob("draft-interrupted-1");
  assert.equal(recoveredJob.state, "QUEUED");
  assert.equal(recoveredJob.metadata?.recoveryCount, 1);
  assert.equal(typeof recoveredJob.metadata?.lastQueuedAtUnixMs, "number");
});

test("draft.create preserves every user-selected generation and scheduling option", async () => {
  const repository = new InMemoryBackendStore();
  const handle = createEngineProtocol(repository);
  const response = await handle(envelope({
    version: 1,
    requestId: "draft-options-1",
    idempotencyKey: "draft-options-1",
    expectedVersion: 0,
    kind: "DRAFT.CREATE",
    payload: {
      draftId: "draft-options-1",
      instruction: "Kaynakları karşılaştırarak ayrıntılı bir analiz hazırla",
      sourceIds: ["source-1"],
      urls: [],
      section: "analiz",
      articleType: "analysis",
      urgency: "urgent",
      tone: "technical",
      length: "deep",
      visualPolicy: "LOCAL_RENDERER",
      scheduleIntent: "UNSCHEDULED"
    }
  }));
  assert.equal(response.ok, true);
  const metadata = (await repository.getJob("draft-options-1")).metadata;
  assert.equal(metadata?.urgency, "urgent");
  assert.equal(metadata?.tone, "technical");
  assert.equal(metadata?.length, "deep");
  assert.equal(metadata?.visualPolicy, "LOCAL_RENDERER");
  assert.equal(metadata?.scheduleIntent, "UNSCHEDULED");
});

test("draft.create with NEXT_SLOT binds the durable job to an enabled custom weekly slot", async () => {
  const repository = new InMemoryBackendStore();
  await repository.setLocalState("desktop.editorial", {
    schedule: {
      slots: {
        "slot-sun": { slotId: "slot-sun", enabled: true, time: "18:45" },
        "slot-mon": { slotId: "slot-mon", enabled: false, time: "10:00" }
      }
    }
  });
  const handle = createEngineProtocol(repository);
  const response = await handle(envelope({
    version: 1,
    requestId: "draft-next-slot-1",
    idempotencyKey: "draft-next-slot-1",
    expectedVersion: await repository.getVersion(),
    kind: "DRAFT.CREATE",
    payload: {
      draftId: "draft-next-slot-1",
      instruction: "Haftalık yayın ritmine göre özgün analiz hazırla",
      sourceIds: ["source-1"],
      urls: [],
      section: "analiz",
      articleType: "analysis",
      scheduleIntent: "NEXT_SLOT"
    }
  }));

  assert.equal(response.ok, true);
  const job = await repository.getJob("draft-next-slot-1");
  assert.equal(job.metadata?.scheduleIntent, "NEXT_SLOT");
  assert.equal(typeof job.metadata?.scheduledAt, "string");
  assert.ok(Date.parse(String(job.metadata?.scheduledAt)) > Date.now());
});

test("draft.create with NEXT_SLOT uses the visible default weekly rhythm before any calendar save", async () => {
  const repository = new InMemoryBackendStore();
  const handle = createEngineProtocol(repository);
  const response = await handle(envelope({
    version: 1,
    requestId: "draft-next-slot-default-1",
    idempotencyKey: "draft-next-slot-default-1",
    expectedVersion: 0,
    kind: "DRAFT.CREATE",
    payload: {
      draftId: "draft-next-slot-default-1",
      instruction: "Varsayılan takvim ritmine göre içerik hazırla",
      sourceIds: ["source-1"],
      urls: [],
      section: "haberler",
      articleType: "news",
      scheduleIntent: "NEXT_SLOT"
    }
  }));

  assert.equal(response.ok, true);
  assert.equal(typeof (await repository.getJob("draft-next-slot-default-1")).metadata?.scheduledAt, "string");
});
test("draft.create with NEXT_SLOT considers every enabled slot of the same weekday", async () => {
  const repository = new InMemoryBackendStore();
  await repository.setLocalState("desktop.editorial", {
    schedule: {
      slots: {
        "slot-mon-1": { slotId: "slot-mon-1", enabled: true, time: "09:00" },
        "slot-mon-2": { slotId: "slot-mon-2", enabled: true, time: "18:00" }
      }
    }
  });
  const handle = createEngineProtocol(repository);

  const response = await handle(envelope({
    version: 1,
    requestId: "draft-next-slot-multiple-1",
    idempotencyKey: "draft-next-slot-multiple-1",
    expectedVersion: await repository.getVersion(),
    kind: "DRAFT.CREATE",
    payload: {
      draftId: "draft-next-slot-multiple-1",
      instruction: "Çoklu yayın zamanı",
      sourceIds: ["source-1"],
      urls: [],
      section: "haberler",
      articleType: "news",
      scheduleIntent: "NEXT_SLOT"
    }
  }));

  assert.equal(response.ok, true);
  const job = await repository.getJob("draft-next-slot-multiple-1");
  assert.equal(typeof job.metadata?.scheduledAt, "string");
  assert.ok(Date.parse(String(job.metadata?.scheduledAt)) > Date.now());
});

test("paid fallback disabled remains a manual stop after restart", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-paid-fallback-disabled",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 1,
    lastError: "PAID_FALLBACK_DISABLED",
    metadata: {
      codexWaitReason: "PAID_FALLBACK_DISABLED",
      instruction: "Ücretli fallback olmadan yerel Codex beklesin",
      sourceIds: ["source-1"],
      urls: []
    }
  });
  const recoveredIds: string[] = [];
  const coordinator = {
    async submit() { throw new Error("not used"); },
    async recoverInterrupted(jobId: string) {
      recoveredIds.push(jobId);
      return { recovered: true, snapshot: null };
    },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  } as unknown as CodexWorkerCoordinator;

  assert.equal(await recoverWaitingDraftJobs(repository, coordinator), 0);
  assert.deepEqual(recoveredIds, []);
  assert.equal((await repository.getJob("draft-paid-fallback-disabled")).state, "WAITING_CODEX");
});

test("a previously unsupported Codex CLI retries after an engine restart", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-unsupported-cli",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 1,
    lastError: "CODEX_CLI_UNSUPPORTED",
    metadata: {
      codexWaitReason: "RUNNER_REQUIRES_RETRY",
      codexDiagnosticCode: "CODEX_CLI_UNSUPPORTED",
      sourceIds: ["source-1"],
      urls: []
    }
  });
  const recoveredIds: string[] = [];
  const coordinator = {
    async submit() { throw new Error("not used"); },
    async recoverInterrupted(jobId: string) {
      recoveredIds.push(jobId);
      return { recovered: true, snapshot: null };
    },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  } as unknown as CodexWorkerCoordinator;

  assert.equal(await recoverWaitingDraftJobs(repository, coordinator), 1);
  assert.deepEqual(recoveredIds, ["draft-unsupported-cli"]);
  assert.equal((await repository.getJob("draft-unsupported-cli")).state, "QUEUED");
});

test("NEXT_SLOT reserves an already assigned time and chooses the next available slot", async () => {
  const repository = new InMemoryBackendStore();
  await repository.setLocalState("desktop.editorial", {
    schedule: { slots: {
      "slot-mon-1": { slotId: "slot-mon-1", enabled: true, time: "09:00" },
      "slot-mon-2": { slotId: "slot-mon-2", enabled: true, time: "18:00" }
    } }
  });
  const handle = createEngineProtocol(repository);
  const create = async (id: string) => handle(envelope({
    version: 1,
    requestId: id,
    idempotencyKey: id,
    expectedVersion: await repository.getVersion(),
    kind: "DRAFT.CREATE",
    payload: { draftId: id, instruction: "Aynı yayın slotu iki kez kullanılmamalı", sourceIds: ["source-1"], urls: [], section: "haberler", articleType: "news", scheduleIntent: "NEXT_SLOT" }
  }));

  assert.equal((await create("draft-next-slot-reserved-1")).ok, true);
  assert.equal((await create("draft-next-slot-reserved-2")).ok, true);
  const first = await repository.getJob("draft-next-slot-reserved-1");
  const second = await repository.getJob("draft-next-slot-reserved-2");
  assert.notEqual(first.metadata?.scheduledAt, second.metadata?.scheduledAt);
});

test("draft source evidence is bounded, anchored, and marked untrusted", async () => {
  const body = `<rss><channel><title>Feed</title><item><title>Patch</title><link>https://example.com/patch</link><description>${"A".repeat(15000)}</description></item></channel></rss>`;
  const evidence = await collectDraftSourceEvidence(undefined, [], ["https://example.com/feed"], {
    async resolve() { return ["93.184.216.34"]; },
    async request() {
      return { status: 200, headers: { "content-type": "application/rss+xml" }, body: new TextEncoder().encode(body) };
    }
  });
  assert.equal(evidence.length, 1);
  const item = evidence[0] as Record<string, unknown>;
  assert.equal(item.untrusted, true);
  assert.equal(typeof item.evidenceText, "string");
  assert.equal(String(item.evidenceText).length, 12000);
  const anchors = item.evidenceAnchors as Array<{ sourceId: string; start: number; end: number; quoteHash: string }>;
  const anchor = anchors[0];
  assert.ok(anchor);
  assert.deepEqual(anchors, [{ sourceId: String(item.id), start: 0, end: 12000, quoteHash: anchor.quoteHash }]);
  assert.match(anchor.quoteHash, /^[a-f0-9]{64}$/u);
});

test("candidate research uses only the selected feed entry instead of the whole feed", async () => {
  const repository = {
    async getSource() {
      return { id: "source-1", url: "https://news.example/feed.xml", updatedAt: "2026-08-07T00:00:00.000Z" };
    },
    async listEntriesBounded() {
      return [
        { externalId: "other", url: "https://news.example/stories/other", title: "Other story", summary: "Other summary" },
        { externalId: "selected", url: "https://news.example/stories/selected", title: "Selected story", summary: "Selected summary" }
      ];
    }
  } as unknown as SourceRepository;

  const evidence = await collectDraftSourceEvidence(
    repository,
    ["source-1"],
    [],
    undefined,
    "https://news.example/stories/selected"
  );

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.url, "https://news.example/stories/selected");
  assert.equal(evidence[0]?.title, "Selected story");
});

test("legacy candidate jobs recover the original selected feed entry", async () => {
  const repository = {
    async listEntries() {
      return [
        { externalId: "other", url: "https://news.example/stories/other" },
        { externalId: "selected", url: "https://news.example/stories/selected" }
      ];
    }
  } as unknown as SourceRepository;
  // This is the deterministic candidate identity used by the source catalog.
  const candidateId = "candidate-c3bc469203aba48cdfc06abe";
  const resolved = await resolveCandidateSourceUrl(repository, ["source-1"], candidateId);
  assert.equal(resolved, "https://news.example/stories/selected");
});

test("draft.create dispatches to the isolated Codex coordinator when configured", async () => {
  const repository = new InMemoryBackendStore();
  const submissions: unknown[] = [];
  const codexCoordinator: CodexWorkerCoordinator = {
    async submit(submission) {
      submissions.push(submission);
      return {
        ...submission,
        state: "QUEUED",
        version: 1
      };
    },
    async recoverInterrupted() { return { recovered: false, snapshot: null }; },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); }
  };
  const handle = createEngineProtocol(repository, "memory", { codexCoordinator });
  const response = await handle(envelope({
    version: 1,
    requestId: "draft-codex-1",
    idempotencyKey: "draft-codex-1",
    expectedVersion: 0,
    kind: "DRAFT.CREATE",
    payload: { draftId: "draft-codex-1", sourceIds: ["source-1"], instruction: "Özgün haber hazırla" }
  }));
  assert.equal(response.ok, true);
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0], {
    jobId: "draft-codex-1",
    idempotencyKey: "draft:draft-codex-1",
    definitionId: "DRAFT.CREATE",
    payload: {
      draftId: "draft-codex-1",
      sourceIds: ["source-1"],
      instruction: "Özgün haber hazırla",
      sources: []
    }
  });
});

test("job.retry moves a failed job back to QUEUED and increments attempts", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({ id: "job-1", kind: "INGEST", state: "FAILED", attempts: 1, lastError: "boom" });
  const handle = createEngineProtocol(repository);
  const response = await handle(envelope({
    version: 1,
    requestId: "retry-1",
    idempotencyKey: "retry-1",
    expectedVersion: 1,
    kind: "JOB.RETRY",
    payload: { jobId: "job-1" }
  }));
  assert.equal(response.ok, true);
  assert.equal((await repository.getJob("job-1")).state, "QUEUED");
  assert.equal((await repository.getJob("job-1")).attempts, 2);
});

test("malformed local workflow commands fail before any durable mutation", async () => {
  const commands = [
    { kind: "DRAFT.CREATE", payload: { draftId: "draft-invalid", sourceIds: ["source-1"], unexpected: true } },
    {
      kind: "BOBY.GUIDE",
      payload: {
        guidanceId: "boby-invalid",
        question: "Ne yapmalıyım?",
        activePage: "content",
        runtimeState: "ONLINE",
        safeWorkspaceSummary: { draftCount: 0, reviewCount: 0, sourceCount: 0 },
        unexpected: true
      }
    },
    { kind: "JOB.RETRY", payload: { jobId: "missing-job", unexpected: true } },
    { kind: "LOCAL_STATE.SET", payload: { key: "desktop.invalid", value: true, unexpected: true } }
  ];
  for (const [index, local] of commands.entries()) {
    const repository = new InMemoryBackendStore();
    const handle = createEngineProtocol(repository);
    const response = await handle(envelope({
      version: 1,
      requestId: `invalid-local-${index}`,
      idempotencyKey: `invalid-local-${index}`,
      expectedVersion: 0,
      ...local
    }));
    assert.equal(response.ok, false, local.kind);
    assert.equal((response.result as { error: { code: string } }).error.code, "INVALID_COMMAND", local.kind);
    assert.equal(await repository.getVersion(), 0, local.kind);
    assert.deepEqual(await repository.listJobs(), [], local.kind);
    assert.equal(await repository.getLocalState("desktop.invalid"), undefined, local.kind);
  }
});

test("job.retry preserves Codex-required terminal jobs when no coordinator is available", async () => {
  for (const kind of ["DRAFT", "CODEX"] as const) {
    for (const state of ["WAITING_CODEX", "FAILED", "DEAD_LETTER", "RETRY_SCHEDULED"] as const) {
      const repository = new InMemoryBackendStore();
      const id = `${kind.toLowerCase()}-${state.toLowerCase()}`;
      const before = {
        id,
        kind,
        state,
        attempts: 3,
        lastError: "original-stop",
        metadata: { progressStage: "original-stage" }
      } as const;
      await repository.createJob(before);
      const version = await repository.getVersion();
      const handle = createEngineProtocol(repository);
      const response = await handle(envelope({
        version: 1,
        requestId: `retry-${id}`,
        idempotencyKey: `retry-${id}`,
        expectedVersion: version,
        kind: "JOB.RETRY",
        payload: { jobId: id }
      }));

      assert.equal(response.ok, false, `${kind}/${state}`);
      assert.equal((response.result as { error: { code: string } }).error.code, "CODEX_RUNNER_UNAVAILABLE");
      assert.deepEqual(await repository.getJob(id), before, `${kind}/${state}`);
      assert.equal(await repository.getVersion(), version, `${kind}/${state}`);
    }
  }
});

test("job.retry recovers a waiting Codex draft through its durable coordinator", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "job-waiting-codex-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 1,
    lastError: "CODEX_OUTPUT_MISSING"
  });
  const recovered: string[] = [];
  const codexCoordinator = {
    async submit() { throw new Error("not used"); },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); },
    async recoverInterrupted(jobId: string) {
      recovered.push(jobId);
      return { recovered: true, snapshot: null };
    }
  } satisfies CodexWorkerCoordinator;
  const handle = createEngineProtocol(repository, "memory", { codexCoordinator });
  const response = await handle(envelope({
    version: 1,
    requestId: "retry-waiting-codex-1",
    idempotencyKey: "retry-waiting-codex-1",
    expectedVersion: 1,
    kind: "JOB.RETRY",
    payload: { jobId: "job-waiting-codex-1" }
  }));
  assert.equal(response.ok, true);
  assert.deepEqual(recovered, ["job-waiting-codex-1"]);
  assert.equal((await repository.getJob("job-waiting-codex-1")).state, "QUEUED");
  assert.equal((await repository.getJob("job-waiting-codex-1")).attempts, 2);
});
