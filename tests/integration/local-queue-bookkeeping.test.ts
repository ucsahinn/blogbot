import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { LocalQueueRuntime } from "../../apps/engine/src/local-queue.ts";
import { createOwnedTempRoot } from "../helpers/owned-temp-root.ts";

// Includes real PGlite/Wasm startup under the parallel integration matrix.
// The state-transition probes below retain their independent five-second bound.
const QUEUE_TEST_TIMEOUT_MS = 45_000;

for (const failure of ["read", "write", "write-after-commit"] as const) {
  test(`queue recovers its failed handler after one retry-bookkeeping ${failure} rejection`, { timeout: QUEUE_TEST_TIMEOUT_MS }, async (t) => {
    const owned = await createOwnedTempRoot(t, "blogbot-queue-bookkeeping-");
    const database = new PGlite(join(owned.path, "pgdata"));
    owned.track(() => database.close());
    const faults: string[] = [];
    const runtime = new LocalQueueRuntime(database, { onFault: (error) => faults.push(error.message) });
    owned.track(() => runtime.stop());
    await runtime.start();

    // A different worker still owns this active handler. Recovery must not
    // globally reset reservations or start it again.
    let releaseGuard!: () => void;
    const guard = new Promise<void>((resolve) => { releaseGuard = resolve; });
    owned.track(async () => { releaseGuard(); });
    let guardCalls = 0;
    const guardId = await runtime.enqueue("blogbot.draft", { fixture: "active-owner" }, "active-owner");
    await runtime.work("blogbot.draft", async () => { guardCalls += 1; await guard; });
    await until(async () => guardCalls === 1);

    const failedId = await runtime.enqueue("blogbot.ingest", { fixture: "retry" }, "retry-bookkeeping");
    const otherId = await runtime.enqueue("blogbot.ingest", { fixture: "other" }, "other-job");
    // Both rows stay real. Only the selected dependency operation rejects
    // once; all claims, subsequent reads and updates execute against PGlite.
    const query = database.query.bind(database);
    let injected = false;
    t.mock.method(database, "query", async (...args: Parameters<PGlite["query"]>) => {
      const isRetryRead = args[0].includes("SELECT attempts FROM blogbot_local_queue_jobs");
      const isRetryWrite = args[0].includes("SET state = $2, available_at_unix_ms");
      if (!injected && args[1]?.[0] === failedId && (failure === "read" ? isRetryRead : isRetryWrite)) {
        injected = true;
        if (failure === "write-after-commit") await query(...args);
        throw new Error("synthetic single-operation storage rejection");
      }
      return query(...args);
    });
    let failedHandlerCalls = 0;
    await runtime.work("blogbot.ingest", async (job) => {
      if (job.id === failedId && ++failedHandlerCalls === 1) throw new Error("synthetic handler failure");
    });
    await until(async () => faults.length === 1 && (await runtime.getJob("blogbot.ingest", otherId))?.state === "completed");

    assert.equal((await runtime.getJob("blogbot.ingest", failedId))?.state, "created",
      "a settled handler must not leave an ownerless active reservation after storage recovers");
    assert.equal(failedHandlerCalls, 1, "bookkeeping recovery must not bypass the retry delay");
    assert.equal((await runtime.getJob("blogbot.draft", guardId))?.state, "active");
    assert.equal(guardCalls, 1, "another worker's active handler must retain ownership");
    assert.deepEqual(faults, ["LOCAL_QUEUE_UNAVAILABLE"]);
    const retry = await database.query<{ attempts: number; available_at_unix_ms: string }>(
      "SELECT attempts, available_at_unix_ms FROM blogbot_local_queue_jobs WHERE id = $1", [failedId]);
    assert.equal(retry.rows[0]?.attempts, 1);
    assert.ok(Number(retry.rows[0]?.available_at_unix_ms) > Date.now(), "the retry must remain delayed");

    // Make only this fixture's retry due; the real worker must then complete it
    // without a runtime restart or an explicit recoverInterrupted() call.
    await database.query("UPDATE blogbot_local_queue_jobs SET available_at_unix_ms = 0 WHERE id = $1", [failedId]);
    await until(async () => (await runtime.getJob("blogbot.ingest", failedId))?.state === "completed");
    assert.equal(failedHandlerCalls, 2);
    assert.equal(guardCalls, 1);
  });
}

for (const recoveryBoundary of ["before-read", "after-read"] as const) {
  test(`a stale retry settlement held ${recoveryBoundary} cannot overwrite a newer active claim`, { timeout: QUEUE_TEST_TIMEOUT_MS }, async (t) => {
    const owned = await createOwnedTempRoot(t, "blogbot-queue-bookkeeping-owner-");
    const database = new PGlite(join(owned.path, "pgdata"));
    owned.track(() => database.close());
    const runtime = new LocalQueueRuntime(database);
    owned.track(() => runtime.stop());
    await runtime.start();
    const id = await runtime.enqueue("blogbot.ingest", { fixture: "reclaimed" }, "reclaimed-job");
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    let releaseNewHandler!: () => void;
    const newHandler = new Promise<void>((resolve) => { releaseNewHandler = resolve; });
    owned.track(async () => { releaseRead(); releaseNewHandler(); });
    const query = database.query.bind(database);
    let readHeld = false;
    let capturedReadRows = 0;
    t.mock.method(database, "query", async (...args: Parameters<PGlite["query"]>) => {
      if (!readHeld && args[1]?.[0] === id && args[0].includes("SELECT attempts FROM blogbot_local_queue_jobs")) {
        if (recoveryBoundary === "after-read") {
          // Return the real owned-row result only after another worker claims
          // the job. The retry UPDATE must independently fence that stale read.
          const result = await query(...args);
          capturedReadRows = result.rows.length;
          readHeld = true;
          await heldRead;
          return result;
        }
        readHeld = true;
        await heldRead;
      }
      return query(...args);
    });
    await runtime.work("blogbot.ingest", async (job) => {
      if (job.id === id) throw new Error("synthetic first attempt failure");
    });
    await until(async () => readHeld);
    if (recoveryBoundary === "after-read") assert.equal(capturedReadRows, 1, "the old owner read must succeed before recovery");
    assert.equal(await runtime.recoverInterrupted("blogbot.ingest", id), true);
    let newHandlerCalls = 0;
    await runtime.work("blogbot.ingest", async () => { newHandlerCalls += 1; await newHandler; });
    await until(async () => newHandlerCalls === 1);
    const probeId = await runtime.enqueue("blogbot.ingest", { fixture: "old-worker-progress" }, "old-worker-progress");
    releaseRead();
    await until(async () => (await runtime.getJob("blogbot.ingest", probeId))?.state === "completed");

    assert.equal((await runtime.getJob("blogbot.ingest", id))?.state, "active",
      "the old attempt must not reset a reservation now owned by the newer handler");
    const current = await database.query<{ attempts: number }>("SELECT attempts FROM blogbot_local_queue_jobs WHERE id = $1", [id]);
    assert.equal(current.rows[0]?.attempts, 2);
    assert.equal(newHandlerCalls, 1);
    releaseNewHandler();
    await until(async () => (await runtime.getJob("blogbot.ingest", id))?.state === "completed");
  });
}

test("shutdown during retry bookkeeping preserves the active job for restart", { timeout: QUEUE_TEST_TIMEOUT_MS }, async (t) => {
  const owned = await createOwnedTempRoot(t, "blogbot-queue-bookkeeping-stop-");
  const database = new PGlite(join(owned.path, "pgdata"));
  owned.track(() => database.close());
  const runtime = new LocalQueueRuntime(database);
  const stopRuntime = owned.track(() => runtime.stop());
  await runtime.start();
  const id = await runtime.enqueue("blogbot.ingest", { fixture: "shutdown" }, "shutdown-bookkeeping");
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  owned.track(async () => { releaseRead(); });
  const query = database.query.bind(database);
  let readHeld = false;
  t.mock.method(database, "query", async (...args: Parameters<PGlite["query"]>) => {
    if (!readHeld && args[1]?.[0] === id && args[0].includes("SELECT attempts FROM blogbot_local_queue_jobs")) {
      readHeld = true;
      await heldRead;
    }
    return query(...args);
  });
  await runtime.work("blogbot.ingest", async () => { throw new Error("synthetic handler failure before stop"); });
  await until(async () => readHeld);
  const stopping = stopRuntime();
  releaseRead();
  await stopping;
  const stopped = await database.query<{ state: string }>("SELECT state FROM blogbot_local_queue_jobs WHERE id = $1", [id]);
  assert.equal(stopped.rows[0]?.state, "active", "shutdown must not dead-letter an otherwise retryable job");

  const restarted = new LocalQueueRuntime(database);
  owned.track(() => restarted.stop());
  await restarted.start();
  await restarted.work("blogbot.ingest", async () => undefined);
  await until(async () => (await restarted.getJob("blogbot.ingest", id))?.state === "completed");
});

test("a stale successful handler cannot complete a newer active claim of the same job", { timeout: QUEUE_TEST_TIMEOUT_MS }, async (t) => {
  const owned = await createOwnedTempRoot(t, "blogbot-queue-bookkeeping-complete-");
  const database = new PGlite(join(owned.path, "pgdata"));
  owned.track(() => database.close());
  const runtime = new LocalQueueRuntime(database);
  owned.track(() => runtime.stop());
  await runtime.start();
  const id = await runtime.enqueue("blogbot.ingest", { fixture: "reclaimed-success" }, "reclaimed-success");
  let releaseOldHandler!: () => void;
  const oldHandler = new Promise<void>((resolve) => { releaseOldHandler = resolve; });
  let releaseNewHandler!: () => void;
  const newHandler = new Promise<void>((resolve) => { releaseNewHandler = resolve; });
  owned.track(async () => { releaseOldHandler(); releaseNewHandler(); });
  let oldHandlerCalls = 0;
  await runtime.work("blogbot.ingest", async (job) => {
    if (job.id === id) { oldHandlerCalls += 1; await oldHandler; }
  });
  await until(async () => oldHandlerCalls === 1);
  assert.equal(await runtime.recoverInterrupted("blogbot.ingest", id), true);
  let newHandlerCalls = 0;
  await runtime.work("blogbot.ingest", async () => { newHandlerCalls += 1; await newHandler; });
  await until(async () => newHandlerCalls === 1);
  const probeId = await runtime.enqueue("blogbot.ingest", { fixture: "old-success-progress" }, "old-success-progress");
  releaseOldHandler();
  await until(async () => (await runtime.getJob("blogbot.ingest", probeId))?.state === "completed");
  assert.equal((await runtime.getJob("blogbot.ingest", id))?.state, "active",
    "completion belongs to the claimed attempt, not a later handler with the same job id");
  assert.equal(oldHandlerCalls, 1);
  assert.equal(newHandlerCalls, 1);
  releaseNewHandler();
  await until(async () => (await runtime.getJob("blogbot.ingest", id))?.state === "completed");
});

test("reviving a dead letter cannot restore a stale handler's claim ownership", { timeout: QUEUE_TEST_TIMEOUT_MS }, async (t) => {
  const owned = await createOwnedTempRoot(t, "blogbot-queue-bookkeeping-revive-");
  const database = new PGlite(join(owned.path, "pgdata"));
  owned.track(() => database.close());
  const runtime = new LocalQueueRuntime(database);
  owned.track(() => runtime.stop());
  await runtime.start();
  const payload = { fixture: "claim-identity" };
  const id = await runtime.enqueue("blogbot.ingest", payload, "claim-identity");
  let releaseOldHandler!: () => void;
  const oldHandler = new Promise<void>((resolve) => { releaseOldHandler = resolve; });
  let releaseRevivedHandler!: () => void;
  const revivedHandler = new Promise<void>((resolve) => { releaseRevivedHandler = resolve; });
  owned.track(async () => { releaseOldHandler(); releaseRevivedHandler(); });
  let oldStarted = false;
  await runtime.work("blogbot.ingest", async (job) => {
    if (job.id === id) { oldStarted = true; await oldHandler; }
  });
  await until(async () => oldStarted);
  assert.equal(await runtime.recoverInterrupted("blogbot.ingest", id), true);
  let failures = 0;
  let revived = false;
  let revivedStarted = false;
  await runtime.work("blogbot.ingest", async () => {
    if (!revived) { failures += 1; throw new Error("synthetic retry-budget exhaustion"); }
    revivedStarted = true;
    await revivedHandler;
  });
  // Attempt one is still held by the old handler. Real attempts two through
  // six exhaust the normal ingest retry budget; only fixture due times move.
  for (let failureCount = 1; failureCount <= 5; failureCount += 1) {
    const expected = failureCount === 5 ? "failed" : "created";
    await until(async () => failures === failureCount && (await runtime.getJob("blogbot.ingest", id))?.state === expected);
    if (expected === "created") {
      await database.query("UPDATE blogbot_local_queue_jobs SET available_at_unix_ms = 0 WHERE id = $1", [id]);
    }
  }
  revived = true;
  assert.equal(await runtime.enqueue("blogbot.ingest", payload, "claim-identity"), id);
  await until(async () => revivedStarted);
  const reset = await database.query<{ attempts: number }>("SELECT attempts FROM blogbot_local_queue_jobs WHERE id = $1", [id]);
  assert.equal(reset.rows[0]?.attempts, 1, "the retry budget legitimately restarted at one");
  const probeId = await runtime.enqueue("blogbot.ingest", { fixture: "old-after-revive" }, "old-after-revive");
  releaseOldHandler();
  await until(async () => (await runtime.getJob("blogbot.ingest", probeId))?.state === "completed");
  assert.equal((await runtime.getJob("blogbot.ingest", id))?.state, "active",
    "a reset retry counter must not make the old claim current again");
  releaseRevivedHandler();
  await until(async () => (await runtime.getJob("blogbot.ingest", id))?.state === "completed");
});

test("pre-token queue schema and logical rows remain recoverable after upgrade", { timeout: QUEUE_TEST_TIMEOUT_MS }, async (t) => {
  const { applyLogicalRestore, dumpApplicationTables } = await import("../../apps/engine/src/stdio-entrypoint.ts");
  const owned = await createOwnedTempRoot(t, "blogbot-queue-bookkeeping-legacy-");
  const database = new PGlite(join(owned.path, "pgdata"));
  owned.track(() => database.close());
  // Exact pre-token queue columns: existing profiles and older logical dumps
  // do not contain the new nullable ownership field.
  await database.exec(`CREATE TABLE blogbot_local_queue_jobs (
    id text PRIMARY KEY, queue_name text NOT NULL, payload jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('created', 'active', 'completed', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at_unix_ms bigint NOT NULL, updated_at_unix_ms bigint NOT NULL
  )`);
  const id = "11111111-1111-4111-8111-111111111111";
  const payload = { fixture: "legacy-queue", value: 17 };
  await database.query(
    "INSERT INTO blogbot_local_queue_jobs VALUES ($1, $2, $3::jsonb, 'active', 1, 0, 0)",
    [id, "blogbot.ingest", JSON.stringify(payload)]
  );
  const legacyRows = await dumpApplicationTables(database);
  const runtime = new LocalQueueRuntime(database);
  const stopRuntime = owned.track(() => runtime.stop());
  await runtime.start();
  const received: (typeof payload)[] = [];
  await runtime.work<typeof payload>("blogbot.ingest", async (job) => { received.push(job.data); });
  await until(async () => (await runtime.getJob("blogbot.ingest", id))?.state === "completed");
  assert.deepEqual(received, [payload]);
  await stopRuntime();

  assert.equal(await applyLogicalRestore(database, legacyRows), 1);
  const restarted = new LocalQueueRuntime(database);
  owned.track(() => restarted.stop());
  await restarted.start();
  await restarted.work<typeof payload>("blogbot.ingest", async (job) => { received.push(job.data); });
  await until(async () => (await restarted.getJob("blogbot.ingest", id))?.state === "completed");
  assert.deepEqual(received, [payload, payload]);
  const preserved = await database.query<{ id: string; attempts: number; count: string }>(
    "SELECT id, attempts, count(*) OVER ()::text AS count FROM blogbot_local_queue_jobs"
  );
  assert.deepEqual(preserved.rows, [{ id, attempts: 2, count: "1" }]);
});

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "queue condition did not become true within five seconds");
    await delay(20);
  }
}
