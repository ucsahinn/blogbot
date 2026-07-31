import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import { createEngineProtocol, collectDraftSourceEvidence } from "../../apps/engine/src/stdio-entrypoint.ts";
import type { CodexWorkerCoordinator } from "../../apps/engine/src/codex-worker.ts";

const envelope = (command: Record<string, unknown>) => ({
  version: 1,
  id: String(command.requestId),
  kind: "command",
  command
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
    payload: { draftId: "draft-1", titleTr: "Başlık", sourceIds: ["source-1"] }
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
      instruction: "",
      sourceIds: ["source-1"],
      urls: [],
      section: "haberler",
      articleType: "news"
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

test("draft source evidence is bounded, anchored, and marked untrusted", async () => {
  const body = `<rss><channel><title>Feed</title><item><title>Patch</title><link>https://example.com/patch</link><description>${"A".repeat(5000)}</description></item></channel></rss>`;
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
  assert.equal(String(item.evidenceText).length, 4096);
  const anchors = item.evidenceAnchors as Array<{ sourceId: string; start: number; end: number; quoteHash: string }>;
  const anchor = anchors[0];
  assert.ok(anchor);
  assert.deepEqual(anchors, [{ sourceId: String(item.sourceId), start: 0, end: 4096, quoteHash: anchor.quoteHash }]);
  assert.match(anchor.quoteHash, /^[a-f0-9]{64}$/u);
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
  await repository.createJob({ id: "job-1", kind: "DRAFT", state: "FAILED", attempts: 1, lastError: "boom" });
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
