import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BackendRepository } from "../../packages/database/src/backend-repository.ts";
import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";

const binding = {
  previewHash: "b".repeat(64),
  targetRepository: "owner/site",
  baseBranch: "main",
  targetBaseSha: "c".repeat(40),
  adapterVersion: "astro-generic@2.0.0"
};

/**
 * The desktop learns about durable work through the incremental change feed, so
 * every repository implementation of the same interface has to publish the same
 * events. A queued publication that is missing from the feed stays invisible
 * until an unrelated mutation happens to move the cursor.
 */
async function assertEnqueueIsVisibleInTheChangeFeed(repository: BackendRepository): Promise<void> {
  const before = await repository.getVersion();
  const effect = await repository.enqueuePublication("revision-feed-1", "a".repeat(64), binding);

  assert.ok(await repository.getVersion() > before, "enqueuePublication must advance the cursor");
  const changes = (await repository.sync(before)).changes;
  assert.deepEqual(
    changes.filter((change) => change.kind === "EFFECT_UPDATED").map((change) => change.entityId),
    [effect.id]
  );
}

test("the memory-backed repository publishes a queued publication to the change feed", async () => {
  await assertEnqueueIsVisibleInTheChangeFeed(new InMemoryBackendStore());
});

test("the PGlite repository publishes a queued publication to the change feed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-enqueue-feed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());

  await assertEnqueueIsVisibleInTheChangeFeed(repository);
});

test("the memory-backed repository rejects a durable write that lost its race", async () => {
  const repository = new InMemoryBackendStore();
  const job = await repository.createJob({
    id: "draft-memory-cas-1",
    kind: "DRAFT",
    state: "RUNNING",
    attempts: 1
  });
  const observedVersion = await repository.getJobVersion(job.id);

  await repository.saveJob({ ...job, state: "SUCCEEDED" }, observedVersion);

  await assert.rejects(
    repository.saveJob({ ...job, state: "QUEUED", attempts: 2 }, observedVersion),
    (error: unknown) => (error as { code?: string }).code === "WRITE_VERSION_CONFLICT"
  );
  assert.equal((await repository.getJob(job.id)).state, "SUCCEEDED");
});
