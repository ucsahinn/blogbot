import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PGliteCodexJobStore,
  PGliteCodexQueueAdapter,
  registerCodexQueueWorker
} from "../../apps/engine/src/pglite-codex-job-store.ts";
import type { CodexWorkSubmission } from "../../apps/engine/src/codex-worker.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";

const submission: CodexWorkSubmission = {
  jobId: "codex-job-1",
  idempotencyKey: "draft-17:write-tr:v1",
  definitionId: "write-tr-v1",
  payload: { evidenceIds: ["source-1"] }
};

test("PGlite Codex store preserves encrypted idempotent state across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-codex-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "pgdata");

  const firstRepository = await PGliteBackendRepository.open(dataDir);
  const firstStore = new PGliteCodexJobStore(firstRepository.getDatabase());
  const reservation = await firstStore.reserveQueued(submission);
  assert.equal(reservation.created, true);
  assert.equal(reservation.snapshot.version, 1);

  const raw = await firstRepository.getDatabase().query<{ value: unknown }>(
    "SELECT value FROM blogbot_codex_jobs WHERE id = $1",
    [submission.jobId]
  );
  assert.equal(
    (raw.rows[0]?.value as { alg?: string } | undefined)?.alg,
    "A256GCM"
  );
  assert.doesNotMatch(
    JSON.stringify(raw.rows[0]?.value),
    /write-tr-v1|source-1/
  );
  await firstRepository.close();

  const reopened = await PGliteBackendRepository.open(dataDir);
  const reopenedStore = new PGliteCodexJobStore(reopened.getDatabase());
  const replay = await reopenedStore.reserveQueued({
    ...submission,
    jobId: "ignored-duplicate-id"
  });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.snapshot, reservation.snapshot);

  const claimed = await reopenedStore.claimQueued({
    jobId: submission.jobId,
    idempotencyKey: submission.idempotencyKey,
    generation: 1
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.snapshot.state, "RUNNING");
  assert.equal(claimed.snapshot.version, 2);

  const staleClaim = await reopenedStore.claimQueued({
    jobId: submission.jobId,
    idempotencyKey: submission.idempotencyKey,
    generation: 1
  });
  assert.equal(staleClaim.claimed, false);
  assert.deepEqual(staleClaim.snapshot, claimed.snapshot);

  const recoveredRunning = await reopenedStore.recoverInterrupted(submission.jobId);
  assert.equal(recoveredRunning.recovered, true);
  assert.equal(recoveredRunning.snapshot?.state, "QUEUED");
  assert.equal(recoveredRunning.snapshot?.version, 3);
  assert.equal(recoveredRunning.snapshot?.idempotencyKey, submission.idempotencyKey);

  const reClaimed = await reopenedStore.claimQueued({
    jobId: submission.jobId,
    idempotencyKey: submission.idempotencyKey,
    generation: 3
  });
  assert.equal(reClaimed.claimed, true);
  assert.equal(reClaimed.snapshot.state, "RUNNING");
  assert.equal(reClaimed.snapshot.version, 4);

  const completed = await reopenedStore.markCompleted({
    jobId: submission.jobId,
    expectedVersion: 4,
    role: "DEFAULT",
    model: "gpt-5.6-terra",
    output: { title: "Özgün analiz" }
  });
  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.version, 5);

  await assert.rejects(
    reopenedStore.markCompleted({
      jobId: submission.jobId,
      expectedVersion: 4,
      role: "DEFAULT",
      model: "gpt-5.6-terra",
      output: { title: "duplicate" }
    }),
    /CODEX_JOB_VERSION_CONFLICT/
  );
  await reopened.close();
});

test("PGlite Codex store rejects idempotency-key reuse with changed input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-codex-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  const store = new PGliteCodexJobStore(repository.getDatabase());
  await store.reserveQueued(submission);

  await assert.rejects(
    store.reserveQueued({
      ...submission,
      jobId: "different-job",
      payload: { evidenceIds: ["different-source"] }
    }),
    /CODEX_IDEMPOTENCY_KEY_REUSED/
  );
  await repository.close();
});

test("Codex queue adapter deduplicates by idempotency key and generation", async () => {
  const calls: Array<{
    name: string;
    data: object;
    idempotencyKey: string;
  }> = [];
  const queue = new PGliteCodexQueueAdapter({
    async enqueue(name, data, idempotencyKey) {
      calls.push({ name, data, idempotencyKey });
      return "queue-job-id";
    }
  });
  const message = {
    jobId: submission.jobId,
    idempotencyKey: submission.idempotencyKey,
    generation: 3
  };

  await queue.enqueueOnce(message);

  assert.deepEqual(calls, [
    {
      name: "blogbot.codex",
      data: message,
      idempotencyKey: "codex:draft-17:write-tr:v1:3"
    }
  ]);
});

test("Codex queue worker delegates only the typed queue message", async () => {
  const message = {
    jobId: submission.jobId,
    idempotencyKey: submission.idempotencyKey,
    generation: 7
  };
  const processed: unknown[] = [];
  const workerId = await registerCodexQueueWorker(
    {
      async enqueue() {
        return "unused";
      },
      async work(name, handler) {
        assert.equal(name, "blogbot.codex");
        await handler({ data: message as never });
        return "codex-worker-1";
      }
    },
    {
      async submit() {
        throw new Error("unused");
      },
      async process(received) {
        processed.push(received);
        return {
          ...submission,
          state: "QUEUED",
          version: 1
        };
      },
      async retryWaiting() {
        throw new Error("unused");
      },
      async recoverInterrupted() {
        throw new Error("unused");
      }
    }
  );

  assert.equal(workerId, "codex-worker-1");
  assert.deepEqual(processed, [message]);
});

test("the transient retry budget survives the requeue-claim cycle so the limit stays reachable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-codex-retry-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());
  const store = new PGliteCodexJobStore(repository.getDatabase());

  const reserved = await store.reserveQueued(submission);
  assert.equal(reserved.created, true);

  const claimed = await store.claimQueued({
    jobId: submission.jobId,
    idempotencyKey: submission.idempotencyKey,
    generation: reserved.snapshot.version
  });
  assert.equal(claimed.claimed, true);

  // One transient Codex failure spends one unit of the retry budget.
  const requeued = await store.returnToQueued({
    jobId: submission.jobId,
    expectedVersion: claimed.snapshot.version,
    failure: "EXECUTION_FAILED",
    transientFailureCount: 1,
    retryAt: "2026-08-19T10:00:00.000Z"
  });
  assert.equal(requeued.transientFailureCount, 1);

  // The queue redelivers the job. Claiming it must not reset the budget, or
  // `transientFailureCount` can never exceed 1, RETRY_LIMIT_REACHED becomes
  // unreachable, and a permanently failing job retries forever.
  const reclaimed = await store.claimQueued({
    jobId: submission.jobId,
    idempotencyKey: submission.idempotencyKey,
    generation: requeued.version
  });
  assert.equal(reclaimed.claimed, true);
  assert.equal(
    reclaimed.snapshot.transientFailureCount,
    1,
    "claiming a redelivered job must carry the spent retry budget into the RUNNING snapshot"
  );

  // A restart must not hand the job a fresh budget either.
  const recovered = await new PGliteCodexJobStore(repository.getDatabase())
    .recoverInterrupted(submission.jobId);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.snapshot?.state, "QUEUED");
  assert.equal(
    recovered.snapshot?.transientFailureCount,
    1,
    "restart recovery must not reset the spent retry budget"
  );
});
