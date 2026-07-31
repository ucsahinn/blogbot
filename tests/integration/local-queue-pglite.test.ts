import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalQueueRuntime } from "../../apps/engine/src/local-queue.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";

test("pg-boss on PGlite keeps one durable job for the same idempotency key", async () => {
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
