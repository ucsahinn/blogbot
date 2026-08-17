import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";

import { LocalQueueRuntime } from "../../apps/engine/src/local-queue.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";

test("local PGlite queue keeps one durable job for the same idempotency key", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-queue-"));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));

  const firstRuntime = new LocalQueueRuntime(repository.getDatabase());
  await firstRuntime.start();
  const firstId = await firstRuntime.enqueue(
    "blogbot.ingest",
    { trigger: "manual" },
    "scan-all-sources-1"
  );
  await firstRuntime.stop();

  const secondRuntime = new LocalQueueRuntime(repository.getDatabase());
  await secondRuntime.start();
  const replayId = await secondRuntime.enqueue(
    "blogbot.ingest",
    { trigger: "manual" },
    "scan-all-sources-1"
  );

  assert.equal(replayId, firstId);
  const job = await secondRuntime.getJob("blogbot.ingest", firstId);
  assert.equal(job?.state, "created");
  assert.deepEqual(job?.data, { trigger: "manual" });

  await assert.rejects(
    secondRuntime.enqueue(
      "blogbot.ingest",
      { trigger: "scheduled" },
      "scan-all-sources-1"
    ),
    /IDEMPOTENCY_KEY_REUSED/
  );

  await secondRuntime.stop();
  await repository.close();
});

test("local PGlite queue delivers a newly enqueued job to its local worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-queue-worker-"));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  const runtime = new LocalQueueRuntime(repository.getDatabase());
  await runtime.start();

  let resolveReceived: ((value: { id: string; data: object }) => void) | undefined;
  const received = new Promise<{ id: string; data: object }>((resolve) => {
    resolveReceived = resolve;
  });
  await runtime.work("blogbot.codex", async (job) => {
    resolveReceived?.({ id: job.id, data: job.data });
  });

  const id = await runtime.enqueue(
    "blogbot.codex",
    { jobId: "draft-1", idempotencyKey: "draft-1", generation: 1 },
    "codex:draft-1:1"
  );
  const result = await Promise.race([
    received,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("queue worker did not receive its job")), 5_000))
  ]);

  assert.equal(result.id, id);
  assert.deepEqual(result.data, { jobId: "draft-1", idempotencyKey: "draft-1", generation: 1 });
  await runtime.stop();
  await repository.close();
});

test("local PGlite queue delivers a durable job queued before the worker registers", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-queue-recovery-"));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  const producer = new LocalQueueRuntime(repository.getDatabase());
  await producer.start();
  const id = await producer.enqueue(
    "blogbot.codex",
    { jobId: "draft-recovery", idempotencyKey: "draft-recovery", generation: 1 },
    "codex:draft-recovery:1"
  );
  await producer.stop();

  const consumer = new LocalQueueRuntime(repository.getDatabase());
  await consumer.start();
  let resolveReceived: ((value: { id: string; data: object }) => void) | undefined;
  const received = new Promise<{ id: string; data: object }>((resolve) => {
    resolveReceived = resolve;
  });
  await consumer.work("blogbot.codex", async (job) => {
    resolveReceived?.({ id: job.id, data: job.data });
  });

  const result = await Promise.race([
    received,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("queue worker did not receive its durable job")), 5_000))
  ]);

  assert.equal(result.id, id);
  assert.deepEqual(result.data, {
    jobId: "draft-recovery",
    idempotencyKey: "draft-recovery",
    generation: 1
  });
  await consumer.stop();
  await repository.close();
});

test("local PGlite queue recovers an active Codex job after an interrupted local engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-queue-active-recovery-"));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  const producer = new LocalQueueRuntime(repository.getDatabase());
  let consumer: LocalQueueRuntime | undefined;
  try {
  await producer.start();

  const id = await producer.enqueue(
    "blogbot.codex",
    { jobId: "draft-active", idempotencyKey: "draft-active", generation: 1 },
    "codex:draft-active:1"
  );
  await producer.stop();

  consumer = new LocalQueueRuntime(repository.getDatabase());
  await consumer.start();
  await repository.getDatabase().query(
    "UPDATE blogbot_local_queue_jobs SET state = 'active' WHERE id = $1",
    [id]
  );
  assert.equal(await consumer.recoverInterrupted("blogbot.codex", id), true);
  const recoveredJob = await consumer.getJob("blogbot.codex", id);
  assert.equal(recoveredJob?.state, "created");

  let resolveReceived: ((value: { id: string; data: object }) => void) | undefined;
  const received = new Promise<{ id: string; data: object }>((resolve) => { resolveReceived = resolve; });
  await consumer.work("blogbot.codex", async (job) => { resolveReceived?.({ id: job.id, data: job.data }); });
  const result = await Promise.race([
    received,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("recovered worker did not receive its active job")), 5_000))
  ]);

  assert.equal(result.id, id);
  assert.deepEqual(result.data, { jobId: "draft-active", idempotencyKey: "draft-active", generation: 1 });
  } finally {
    await consumer?.stop().catch(() => undefined);
    await repository.close();
  }
});

test("local PGlite queue reports a store fault instead of leaking a poll rejection", async () => {
  const faults: string[] = [];
  let closed = false;
  const database = {
    exec: async () => undefined,
    query: async () => {
      if (closed) throw new Error("PGlite closed");
      return { rows: [] };
    }
  } as unknown as PGlite;
  const runtime = new LocalQueueRuntime(database, {
    onFault: (error) => faults.push(error.message)
  });
  await runtime.start();
  closed = true;
  await runtime.work("blogbot.ingest", async () => undefined);

  await new Promise((resolve) => setTimeout(resolve, 650));

  assert.deepEqual(faults, ["LOCAL_QUEUE_UNAVAILABLE"]);
  await runtime.stop();
});

test("local PGlite queue cannot finish startup after a concurrent stop request", async () => {
  let releaseSchema: (() => void) | undefined;
  const schemaReleased = new Promise<void>((resolve) => {
    releaseSchema = resolve;
  });
  const database = {
    exec: async () => schemaReleased,
    query: async () => ({ rows: [] })
  } as unknown as PGlite;
  const runtime = new LocalQueueRuntime(database);

  const starting = runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = runtime.stop();

  releaseSchema?.();
  await Promise.all([starting, stopping]);

  await assert.rejects(
    runtime.enqueue("blogbot.ingest", { trigger: "shutdown-race" }, "shutdown-race"),
    /Local queue runtime is not started/
  );
});

test("local PGlite queue atomically replays concurrent idempotent enqueues", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-queue-race-"));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  const runtime = new LocalQueueRuntime(repository.getDatabase());
  await runtime.start();

  const results = await Promise.allSettled([
    runtime.enqueue("blogbot.ingest", { trigger: "concurrent" }, "concurrent-idempotency-key"),
    runtime.enqueue("blogbot.ingest", { trigger: "concurrent" }, "concurrent-idempotency-key")
  ]);
  assert.equal(results.every((result) => result.status === "fulfilled"), true);
  const ids = results.map((result) => result.status === "fulfilled" ? result.value : "");
  assert.equal(ids[0], ids[1]);

  const rows = await repository.getDatabase().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM blogbot_local_queue_jobs"
  );
  assert.equal(rows.rows[0]?.count, "1");

  await runtime.stop();
  await repository.close();
});
