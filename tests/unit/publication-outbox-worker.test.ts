import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import { startPublicationOutboxWorker } from "../../apps/engine/src/publication-outbox-worker.ts";

test("publication outbox worker claims each pending effect once and records success", async () => {
  const repository = new InMemoryBackendStore();
  const revisionId = "revision-1";
  const effect = await repository.enqueuePublication(revisionId, "a".repeat(64));
  assert.equal(effect.revisionHash, "a".repeat(64));
  const calls: string[] = [];
  const worker = startPublicationOutboxWorker(repository, {
    async process(input) {
      calls.push(input.idempotencyKey);
      return { state: "SUCCEEDED", resultRef: "merge:abc" };
    }
  }, 5);
  for (let attempt = 0; attempt < 50 && calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  worker.stop();
  const snapshot = await repository.sync(0);
  const saved = snapshot.snapshot.outbox.find((item) => item.id === effect.id);
  assert.deepEqual(calls, [effect.idempotencyKey]);
  assert.equal(saved?.state, "SUCCEEDED");
  assert.equal(saved?.resultRef, "merge:abc");
});

test("publication outbox worker records processor failures without deleting the intent", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-2", "b".repeat(64));
  const worker = startPublicationOutboxWorker(repository, {
    async process() { throw new Error("connector unavailable"); }
  }, 5);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
    if (current?.state === "FAILED") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  worker.stop();
  const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
  assert.equal(saved?.state, "FAILED");
  assert.equal(saved?.lastError, "connector unavailable");
});

test("publication outbox worker retries an interrupted connector effect after restart", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-retry", "c".repeat(64));
  const firstWorker = startPublicationOutboxWorker(repository, {
    async process() { throw new Error("temporary connector outage"); }
  }, 1_000);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
    if (current?.state === "UNKNOWN") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  firstWorker.stop();
  assert.equal((await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id)?.state, "UNKNOWN");

  const secondWorker = startPublicationOutboxWorker(repository, {
    async process() { return { state: "SUCCEEDED", resultRef: "merge:recovered" } as const; }
  }, 1_000);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
    if (current?.state === "SUCCEEDED") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  secondWorker.stop();
  const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
  assert.equal(saved?.state, "SUCCEEDED");
  assert.equal(saved?.attempts, 2);
});

test("publication outbox worker reports a transient repository fault and recovers without an unhandled tick", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-store-recovery", "d".repeat(64));
  const originalListOutbox = repository.listOutbox.bind(repository);
  let failOnce = true;
  repository.listOutbox = async () => {
    if (failOnce) {
      failOnce = false;
      throw new Error("database temporarily unavailable");
    }
    return originalListOutbox();
  };
  const faults: string[] = [];
  const worker = startPublicationOutboxWorker(
    repository,
    {
      async process() { return { state: "SUCCEEDED", resultRef: "merge:store-recovered" } as const; }
    },
    5,
    {
      onFault(error) {
        faults.push(error instanceof Error ? error.message : String(error));
      }
    }
  );

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
    if (current?.state === "SUCCEEDED") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  worker.stop();

  const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
  assert.deepEqual(faults, ["OUTBOX_STORAGE_UNAVAILABLE"]);
  assert.equal(saved?.state, "SUCCEEDED");
});
