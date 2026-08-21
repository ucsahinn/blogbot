import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import { startPublicationOutboxWorker } from "../../apps/engine/src/publication-outbox-worker.ts";

const binding = {
  previewHash: "9".repeat(64),
  targetRepository: "owner/site",
  baseBranch: "main",
  targetBaseSha: "a".repeat(40),
  adapterVersion: "astro-generic@2.0.0"
};

async function waitForOutboxState(
  repository: InMemoryBackendStore,
  effectId: string,
  predicate: (state: string | undefined) => boolean
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effectId);
    if (saved && predicate(saved.state)) return saved;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Outbox effect ${effectId} did not reach the expected state`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("publication outbox worker claims each pending effect once and records success", async () => {
  const repository = new InMemoryBackendStore();
  const revisionId = "revision-1";
  const effect = await repository.enqueuePublication(revisionId, "a".repeat(64), binding);
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
  const effect = await repository.enqueuePublication("revision-2", "b".repeat(64), binding);
  const worker = startPublicationOutboxWorker(repository, {
    async process() { throw new Error("connector unavailable"); }
  }, 5, { retryBaseMs: 1 });
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
  const effect = await repository.enqueuePublication("revision-retry", "c".repeat(64), binding);
  const firstWorker = startPublicationOutboxWorker(repository, {
    async process() { throw new Error("temporary connector outage"); }
  }, 1_000, { retryBaseMs: 1 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
    if (current?.state === "UNKNOWN") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  firstWorker.stop();
  assert.equal((await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id)?.state, "UNKNOWN");

  const secondWorker = startPublicationOutboxWorker(repository, {
    async process() { return { state: "SUCCEEDED", resultRef: "merge:recovered" } as const; }
  }, 1_000, { retryBaseMs: 1 });
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

test("publication outbox worker makes repeated unknown results terminal", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-unknown-terminal", "e".repeat(64), binding);
  const worker = startPublicationOutboxWorker(repository, {
    async process() { return { state: "UNKNOWN", lastError: "checks pending" } as const; }
  }, 1, { retryBaseMs: 1 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
    if (saved?.state === "FAILED") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  worker.stop();
  const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
  assert.equal(saved?.state, "FAILED");
  assert.equal(saved?.attempts, 3);
  assert.equal(saved?.lastError, "checks pending");
});

test("publication outbox worker keeps connector-advised unknown checks recoverable after the transient attempt limit", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-checks-pending", "1".repeat(64), binding);
  let calls = 0;
  const worker = startPublicationOutboxWorker(repository, {
    async process() {
      calls += 1;
      return calls < 4
        ? { state: "UNKNOWN", lastError: "checks pending", retryAfterMs: 0 } as const
        : { state: "SUCCEEDED", resultRef: "merge:checks-complete" } as const;
    }
  }, 1, { retryBaseMs: 1 });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
    if (saved?.state === "SUCCEEDED") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  worker.stop();

  const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
  assert.equal(calls, 4);
  assert.equal(saved?.state, "SUCCEEDED");
  assert.equal(saved?.attempts, 4);
  assert.equal(saved?.resultRef, "merge:checks-complete");
});

test("publication outbox worker persists backoff before retrying an unknown effect", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-backed-off", "f".repeat(64), binding);
  let calls = 0;
  const worker = startPublicationOutboxWorker(repository, {
    async process() {
      calls += 1;
      return { state: "UNKNOWN", lastError: "remote checks pending" } as const;
    }
  }, 1, { retryBaseMs: 10_000 });

  for (let attempt = 0; attempt < 50 && calls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  worker.stop();

  const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
  assert.equal(calls, 1);
  assert.equal(saved?.state, "UNKNOWN");
  assert.ok(typeof saved?.nextAttemptAt === "string" && Date.parse(saved.nextAttemptAt) > Date.now() - 100);
});

test("publication outbox worker reports a transient repository fault and recovers without an unhandled tick", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-store-recovery", "d".repeat(64), binding);
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

test("a stale worker result cannot overwrite a newer terminal result", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-competing-success", "2".repeat(64), binding);
  const firstStarted = deferred();
  const releaseFirst = deferred();

  const firstWorker = startPublicationOutboxWorker(repository, {
    async process() {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { state: "SUCCEEDED", resultRef: "merge:stale-worker" } as const;
    }
  }, 1_000);
  await firstStarted.promise;

  const secondWorker = startPublicationOutboxWorker(repository, {
    async process() {
      return { state: "SUCCEEDED", resultRef: "merge:newer-worker" } as const;
    }
  }, 1_000);
  const newer = await waitForOutboxState(repository, effect.id, (state) => state === "SUCCEEDED");
  assert.equal(newer.resultRef, "merge:newer-worker");

  releaseFirst.resolve();
  await new Promise((resolve) => setTimeout(resolve, 25));
  firstWorker.stop();
  secondWorker.stop();

  const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
  assert.equal(saved?.state, "SUCCEEDED");
  assert.equal(saved?.resultRef, "merge:newer-worker");
  assert.equal(saved?.attempts, 2);
});

test("a stale listed row cannot claim over a newer terminal state", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-stale-claim", "4".repeat(64), binding);
  const originalGetVersion = repository.getOutboxVersion.bind(repository);
  let advanceBeforeVersionRead = true;
  repository.getOutboxVersion = async (effectId) => {
    if (advanceBeforeVersionRead) {
      advanceBeforeVersionRead = false;
      const current = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effectId);
      assert.ok(current);
      const version = await originalGetVersion(effectId);
      await repository.updateOutbox(
        { ...current, state: "SUCCEEDED", resultRef: "merge:manual-terminal" },
        version
      );
    }
    return originalGetVersion(effectId);
  };
  let calls = 0;

  const worker = startPublicationOutboxWorker(repository, {
    async process() {
      calls += 1;
      return { state: "SUCCEEDED", resultRef: "merge:stale-claim" } as const;
    }
  }, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 25));
  worker.stop();

  const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
  assert.equal(calls, 0);
  assert.equal(saved?.state, "SUCCEEDED");
  assert.equal(saved?.resultRef, "merge:manual-terminal");
  assert.equal(saved?.attempts, 0);
});

test("a stale processor failure cannot overwrite a newer retry decision", async () => {
  const repository = new InMemoryBackendStore();
  const effect = await repository.enqueuePublication("revision-competing-retry", "3".repeat(64), binding);
  const firstStarted = deferred();
  const releaseFirst = deferred();

  const firstWorker = startPublicationOutboxWorker(repository, {
    async process() {
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new Error("stale connector failure");
    }
  }, 1_000, { retryBaseMs: 60_000 });
  await firstStarted.promise;

  const secondWorker = startPublicationOutboxWorker(repository, {
    async process() {
      return { state: "UNKNOWN", lastError: "newer retry decision", retryAfterMs: 60_000 } as const;
    }
  }, 1_000, { retryBaseMs: 60_000 });
  const newer = await waitForOutboxState(repository, effect.id, (state) => state === "UNKNOWN");
  assert.equal(newer.lastError, "newer retry decision");

  releaseFirst.resolve();
  await new Promise((resolve) => setTimeout(resolve, 25));
  firstWorker.stop();
  secondWorker.stop();

  const saved = (await repository.sync(0)).snapshot.outbox.find((item) => item.id === effect.id);
  assert.equal(saved?.state, "UNKNOWN");
  assert.equal(saved?.lastError, "newer retry decision");
  assert.equal(saved?.attempts, 2);
  assert.ok(saved?.nextAttemptAt);
});
