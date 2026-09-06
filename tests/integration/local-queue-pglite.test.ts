import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";

import { LocalQueueRuntime } from "../../apps/engine/src/local-queue.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";
import { createOwnedTempRoot } from "../helpers/owned-temp-root.ts";

test("local PGlite queue keeps one durable job for the same idempotency key", async (t) => {
  const ownedRoot = await createOwnedTempRoot(t, "blogbot-queue-");
  const repository = await PGliteBackendRepository.open(join(ownedRoot.path, "pgdata"));
  const closeRepository = ownedRoot.track(() => repository.close());

  const firstRuntime = new LocalQueueRuntime(repository.getDatabase());
  const stopFirstRuntime = ownedRoot.track(() => firstRuntime.stop());
  await firstRuntime.start();
  const firstId = await firstRuntime.enqueue(
    "blogbot.ingest",
    { trigger: "manual" },
    "scan-all-sources-1"
  );
  await stopFirstRuntime();

  const secondRuntime = new LocalQueueRuntime(repository.getDatabase());
  const stopSecondRuntime = ownedRoot.track(() => secondRuntime.stop());
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

  await stopSecondRuntime();
  await closeRepository();
});

test("local PGlite queue delivers a newly enqueued job to its local worker", async (t) => {
  const ownedRoot = await createOwnedTempRoot(t, "blogbot-queue-worker-");
  const repository = await PGliteBackendRepository.open(join(ownedRoot.path, "pgdata"));
  const closeRepository = ownedRoot.track(() => repository.close());
  const runtime = new LocalQueueRuntime(repository.getDatabase());
  const stopRuntime = ownedRoot.track(() => runtime.stop());
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
  await stopRuntime();
  await closeRepository();
});

test("local PGlite queue delivers a durable job queued before the worker registers", async (t) => {
  const ownedRoot = await createOwnedTempRoot(t, "blogbot-queue-recovery-");
  const repository = await PGliteBackendRepository.open(join(ownedRoot.path, "pgdata"));
  const closeRepository = ownedRoot.track(() => repository.close());
  const producer = new LocalQueueRuntime(repository.getDatabase());
  const stopProducer = ownedRoot.track(() => producer.stop());
  await producer.start();
  const id = await producer.enqueue(
    "blogbot.codex",
    { jobId: "draft-recovery", idempotencyKey: "draft-recovery", generation: 1 },
    "codex:draft-recovery:1"
  );
  await stopProducer();

  const consumer = new LocalQueueRuntime(repository.getDatabase());
  const stopConsumer = ownedRoot.track(() => consumer.stop());
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
  await stopConsumer();
  await closeRepository();
});

test("local PGlite queue recovers an active Codex job after an interrupted local engine", async (t) => {
  const ownedRoot = await createOwnedTempRoot(t, "blogbot-queue-active-recovery-");
  const repository = await PGliteBackendRepository.open(join(ownedRoot.path, "pgdata"));
  const closeRepository = ownedRoot.track(() => repository.close());
  const producer = new LocalQueueRuntime(repository.getDatabase());
  const stopProducer = ownedRoot.track(() => producer.stop());
  let consumer: LocalQueueRuntime | undefined;
  let stopConsumer: (() => Promise<void>) | undefined;
  try {
  await producer.start();

  const id = await producer.enqueue(
    "blogbot.codex",
    { jobId: "draft-active", idempotencyKey: "draft-active", generation: 1 },
    "codex:draft-active:1"
  );
  await stopProducer();

  consumer = new LocalQueueRuntime(repository.getDatabase());
  stopConsumer = ownedRoot.track(() => consumer!.stop());
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
    await stopConsumer?.();
    await closeRepository();
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

test("local PGlite queue atomically replays concurrent idempotent enqueues", async (t) => {
  const ownedRoot = await createOwnedTempRoot(t, "blogbot-queue-race-");
  const repository = await PGliteBackendRepository.open(join(ownedRoot.path, "pgdata"));
  const closeRepository = ownedRoot.track(() => repository.close());
  const runtime = new LocalQueueRuntime(repository.getDatabase());
  const stopRuntime = ownedRoot.track(() => runtime.stop());
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

  await stopRuntime();
  await closeRepository();
});

test("re-enqueueing a dead-lettered key hands back work a worker can actually claim", async (t) => {
  const ownedRoot = await createOwnedTempRoot(t, "blogbot-queue-deadletter-");
  const repository = await PGliteBackendRepository.open(join(ownedRoot.path, "pgdata"));
  const closeRepository = ownedRoot.track(() => repository.close());
  const runtime = new LocalQueueRuntime(repository.getDatabase());
  const stopRuntime = ownedRoot.track(() => runtime.stop());
  await runtime.start();

  const id = await runtime.enqueue("blogbot.ingest", { trigger: "manual" }, "revive-me");
  // Drive the row to the terminal dead-letter state the same way a permanently
  // failing handler would.
  await repository.getDatabase().query(
    "UPDATE blogbot_local_queue_jobs SET state = 'failed', attempts = 9 WHERE id = $1",
    [id]
  );

  // A recovery path re-enqueues the same deterministic key. This used to return
  // the dead job id and report success, while no worker could ever claim it.
  const revivedId = await runtime.enqueue("blogbot.ingest", { trigger: "manual" }, "revive-me");
  assert.equal(revivedId, id);
  const revived = await runtime.getJob("blogbot.ingest", id);
  assert.equal(revived?.state, "created", "a re-enqueued dead letter must be claimable again");
  const attempts = await repository.getDatabase().query<{ attempts: number }>(
    "SELECT attempts FROM blogbot_local_queue_jobs WHERE id = $1",
    [id]
  );
  assert.equal(Number(attempts.rows[0]?.attempts), 0, "reviving must reset the spent attempt budget");

  await stopRuntime();
  await closeRepository();
});

test("re-enqueueing a completed key never silently redoes finished work", async (t) => {
  const ownedRoot = await createOwnedTempRoot(t, "blogbot-queue-completed-");
  const repository = await PGliteBackendRepository.open(join(ownedRoot.path, "pgdata"));
  const closeRepository = ownedRoot.track(() => repository.close());
  const runtime = new LocalQueueRuntime(repository.getDatabase());
  const stopRuntime = ownedRoot.track(() => runtime.stop());
  await runtime.start();

  const id = await runtime.enqueue("blogbot.ingest", { trigger: "manual" }, "already-done");
  await repository.getDatabase().query(
    "UPDATE blogbot_local_queue_jobs SET state = 'completed' WHERE id = $1",
    [id]
  );

  const replayId = await runtime.enqueue("blogbot.ingest", { trigger: "manual" }, "already-done");
  assert.equal(replayId, id);
  const job = await runtime.getJob("blogbot.ingest", id);
  assert.equal(job?.state, "completed", "finished work must stay finished");

  await stopRuntime();
  await closeRepository();
});

test("queue retention removes only terminal rows past the window", async (t) => {
  const ownedRoot = await createOwnedTempRoot(t, "blogbot-queue-retention-");
  const repository = await PGliteBackendRepository.open(join(ownedRoot.path, "pgdata"));
  const closeRepository = ownedRoot.track(() => repository.close());
  const runtime = new LocalQueueRuntime(repository.getDatabase());
  const stopRuntime = ownedRoot.track(() => runtime.stop());
  await runtime.start();

  const stale = await runtime.enqueue("blogbot.ingest", { n: 1 }, "stale-terminal");
  const recent = await runtime.enqueue("blogbot.ingest", { n: 2 }, "recent-terminal");
  const pending = await runtime.enqueue("blogbot.ingest", { n: 3 }, "still-pending");
  const longAgo = Date.now() - 400 * 24 * 60 * 60 * 1_000;
  await repository.getDatabase().query(
    "UPDATE blogbot_local_queue_jobs SET state = 'completed', updated_at_unix_ms = $2 WHERE id = $1",
    [stale, longAgo]
  );
  await repository.getDatabase().query(
    "UPDATE blogbot_local_queue_jobs SET state = 'failed' WHERE id = $1",
    [recent]
  );

  const removed = await runtime.pruneTerminated();

  assert.equal(removed, 1, "only the row past the retention window may be removed");
  assert.equal(await runtime.getJob("blogbot.ingest", stale), null);
  // A terminal row inside the window must survive: its deterministic key becomes
  // enqueueable again once it is gone.
  assert.ok(await runtime.getJob("blogbot.ingest", recent));
  assert.equal((await runtime.getJob("blogbot.ingest", pending))?.state, "created");

  await stopRuntime();
  await closeRepository();
});
